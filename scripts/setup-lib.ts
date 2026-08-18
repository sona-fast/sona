/**
 * Pure helpers for the Sona setup CLI (scripts/setup.ts), split out so the
 * fiddly logic — the combined migration SQL, the Pages project-name sanitizer,
 * the R2 error sniff, and the gh-secrets eligibility decision — can be unit
 * tested without a Cloudflare account or a live shell.
 */

import type { RateLimitStatus } from './waf-lib.ts';
import type { TurnstileStatus } from './turnstile-lib.ts';

const sqlStr = (s: string) => s.replace(/'/g, "''");

export interface Migration {
	/** The migration file's basename, e.g. `0000_flawless_eternals.sql`. */
	name: string;
	/** The file's full SQL contents. */
	sql: string;
}

/**
 * Builds ONE SQL script that creates the `schema_migrations` bookkeeping table,
 * applies every migration in order, and records each one's basename after it —
 * so the whole thing runs in a single `wrangler d1 execute --file` (one remote
 * confirmation instead of ~18) and leaves the DB in the exact state the deploy
 * workflow's tracked "Run D1 migrations" step treats as already-applied (a
 * clean no-op on the first CI deploy).
 *
 * Table shape and basename keys match `.github/workflows/deploy.yml`. Inserts
 * use `INSERT OR IGNORE` so re-running setup on an already-migrated DB is a
 * no-op (the CREATE IF NOT EXISTS + idempotent inserts keep setup re-runnable).
 */
export function buildMigrationSql(migrations: Migration[]): string {
	const parts = [
		'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);'
	];
	for (const { name, sql } of migrations) {
		parts.push(sql.trim());
		parts.push(
			`INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('${sqlStr(name)}', datetime('now'));`
		);
	}
	return parts.join('\n') + '\n';
}

export interface SeedSettingsInput {
	/** Active image store: 'r2' | 'uploadthing'. */
	provider: string;
	/** Canonical https origin for outgoing-email links; '' to leave unset. */
	siteUrl?: string;
	/** R2 public base URL; '' when UploadThing or unset. */
	r2PublicUrl?: string;
	/** FurTrack character/tag; '' when the fursuit feature is off. */
	primaryCharacter?: string;
}

/**
 * Builds the `INSERT OR REPLACE INTO site_settings` statement the setup CLI runs
 * to seed the values it collected (mirrors the wizard-less defaults). Only
 * non-empty optional values are seeded — an absent row means "unset", which the
 * app reads as its own fallback (e.g. an empty siteUrl falls back to the request
 * origin). storageProvider is always written so the app boots with a backend.
 */
export function buildSeedSql(input: SeedSettingsInput): string {
	const rows: [string, string][] = [['storageProvider', input.provider]];
	if (input.siteUrl) rows.push(['siteUrl', input.siteUrl]);
	if (input.r2PublicUrl) rows.push(['r2PublicUrl', input.r2PublicUrl]);
	if (input.primaryCharacter) rows.push(['primaryCharacter', input.primaryCharacter]);
	const values = rows.map(([k, v]) => `('${sqlStr(k)}','${sqlStr(v)}')`).join(', ');
	return `INSERT OR REPLACE INTO site_settings (key,value) VALUES ${values};`;
}

/**
 * Turns a repo/directory name into a valid Cloudflare Pages project name:
 * lowercase, dots/underscores/whitespace → hyphens, other chars dropped,
 * collapsed and trimmed hyphens, capped at 58 chars. Falls back to `sona` if
 * nothing usable remains. Used only as a prompt default the operator can edit.
 */
export function sanitizeProjectName(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[._\s]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 58)
		.replace(/-+$/, '');
	return cleaned || 'sona';
}

/**
 * True when a `wrangler r2 bucket create` failure means R2 isn't enabled on the
 * account (Cloudflare error code 10042), as opposed to a benign "already
 * exists" or some other error we don't want to misreport as a setup failure.
 */
export function isR2NotEnabled(output: string): boolean {
	return /\b10042\b/.test(output) || /enable R2/i.test(output) || /must (be|first be) enabled/i.test(output);
}

/**
 * Ensures a URL carries an http(s) scheme, mirroring `sanitizeUrl` in
 * src/lib/server/validate.ts: a value with no `http://`/`https://` prefix is
 * assumed https. Empty input stays empty (the operator can set it later). Used
 * so the seeded `r2PublicUrl` is a full URL — R2Storage uses it verbatim as
 * `${base}/${key}`, so a bare host like `cdn.example.com` would be broken.
 */
export function ensureUrlScheme(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	const lower = trimmed.toLowerCase();
	if (lower.startsWith('http://') || lower.startsWith('https://')) return trimmed;
	return 'https://' + trimmed;
}

/**
 * Extracts the D1 `database_id` from `wrangler d1 create` output. Current
 * wrangler prints a JSONC binding block (`"database_id": "..."`); older versions
 * printed a TOML one (`database_id = "..."`). Match both so auto-detect keeps
 * working across wrangler versions instead of falling back to the paste prompt.
 * The `(?<![\w])` guard anchors the key so a future `preview_database_id` line
 * can't be mis-grabbed (`\b` won't do it — `_` is a word char, so `\bdatabase_id`
 * still matches inside `preview_database_id`). Returns '' when no id is found.
 */
export function parseDatabaseId(output: string): string {
	return (output.match(/(?<![\w])database_id"?\s*[:=]\s*"([0-9a-fA-F-]+)"/) || [])[1] ?? '';
}

/**
 * Derives `owner/repo` from a git `origin` URL (ssh or https form) so `gh`
 * commands can be pinned with `-R owner/repo`. Every fork has two remotes
 * (origin + upstream sona), so a bare `gh secret set` errors with "multiple
 * remotes detected"; passing `-R` fixes it. Returns null when the URL isn't a
 * recognizable GitHub remote.
 */
export function deriveRepoSlug(originUrl: string): string | null {
	const url = originUrl.trim();
	if (!url) return null;
	// github.com must be the URL *authority* (host), never a path segment or
	// smuggled userinfo — otherwise a hostile origin like
	// https://evil.com/x@github.com/a/b or https://evil.com//github.com/a/b
	// would derive an attacker-chosen slug and mis-target `gh`. Two accepted
	// shapes, both anchored at the string start:
	//   scp-like:  [user@]github.com:owner/repo(.git)
	//   URL:       scheme://[user@]github.com/owner/repo(.git)
	// `[^@/]+@` (optional userinfo) can't cross a `/`, so github.com in a path
	// can never be reached; lookalikes (evilgithub.com, github.com.evil.com)
	// fail because the host is matched right up to its `:`/`/` delimiter.
	const scp = url.match(/^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	const web = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	const m = scp ?? web;
	return m ? `${m[1]}/${m[2]}` : null;
}

export interface PagesConfigInput {
	/** The created D1 database's id (bound as `DB`). */
	dbId: string;
	/** R2 bucket bound as `IMAGES`; omit to skip the R2 binding (R2 not enabled). */
	bucket?: string;
	/** Plain-text environment variables to attach (e.g. FURTRACK_MODE). */
	envVars: Record<string, string>;
}

/** Kept in sync with wrangler.toml.example — the source of truth for local deploys. */
const PAGES_COMPAT = {
	compatibility_date: '2025-04-01',
	compatibility_flags: ['nodejs_compat']
};

/**
 * Builds the `PATCH /accounts/{id}/pages/projects/{project}` body that attaches
 * the D1/R2 bindings + plain-text vars AND the nodejs_compat flag to the Pages
 * project (production + preview). setup writes these only to the gitignored
 * `wrangler.toml`, so a CI-only deploy (which never sees that file) ships without
 * them; this wires them onto the project itself. Without nodejs_compat the
 * SvelteKit adapter's build can't resolve node built-ins (async_hooks) and the
 * first CI deploy dies. The PATCH merges per key, so unrelated project config is
 * untouched. The R2 binding is omitted when no bucket exists (R2 not enabled).
 * The `DB`/`IMAGES` binding names are fixed by wrangler.toml.example, so they are
 * hardcoded here rather than passed in (single call site).
 */
export function buildPagesConfigPayload(input: PagesConfigInput): Record<string, unknown> {
	const env_vars: Record<string, { type: string; value: string }> = {};
	for (const [name, value] of Object.entries(input.envVars)) {
		env_vars[name] = { type: 'plain_text', value };
	}
	const production: Record<string, unknown> = {
		...PAGES_COMPAT,
		d1_databases: { DB: { id: input.dbId } },
		env_vars
	};
	if (input.bucket) production.r2_buckets = { IMAGES: { name: input.bucket } };
	return { deployment_configs: { production, preview: { ...PAGES_COMPAT } } };
}

/**
 * True when `wrangler whoami` output indicates the credentials resolve. Used by
 * the setup preflight to fail early with an actionable message rather than
 * midway through provisioning. Checks the "You are logged in" success marker
 * FIRST: a User API Token lacking User → User Details → Read still authenticates
 * (exit 0) but prints "Unable to retrieve email for this user" — that token
 * provisions fine, so it must not be read as a failure. Every real wrangler
 * success banner starts with "You are logged in", so anything that misses that
 * marker is treated as unresolved — an expired OAuth login whose refresh fails
 * prints "✘ [ERROR] Not logged in." and must return false, not slip through.
 */
export function tokenResolves(whoamiOutput: string): boolean {
	if (/you are logged in/i.test(whoamiOutput)) return true;
	return false;
}

/**
 * Strips scheme and path from a domain input, leaving the bare host (lowercased).
 * Used to look up the Cloudflare zone for the DNS-scope preflight and the image
 * transformations check. Empty input stays empty.
 */
export function hostFromDomain(domain: string): string {
	return domain
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/.*$/, '')
		.toLowerCase();
}

/**
 * Zone-name candidates to try when looking up the Cloudflare zone for a host,
 * most specific first. A subdomain like `sona.example.com` is served by the
 * `example.com` zone, but `GET /zones?name=sona.example.com` finds nothing — so
 * strip leading labels progressively (`sona.example.com`, then `example.com`)
 * and try each until one matches a zone on the account. Stops at two labels (the
 * shortest a registrable domain can be) to avoid an absurd bare-TLD query. A
 * host that is already two labels yields just itself; empty input yields [].
 */
export function zoneNameCandidates(host: string): string[] {
	const labels = host.split('.').filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i + 2 <= labels.length; i++) {
		out.push(labels.slice(i).join('.'));
	}
	return out.length ? out : host ? [host] : [];
}

/**
 * True when the custom-domain DNS-scope probe means setup must abort: the token
 * can't list DNS records for the zone (401/403), so it can't write the apex
 * CNAME later and the domain would stick pending with a 522. Any other outcome
 * (ok, or a transient 5xx / network error with status 0) does NOT block setup.
 */
export function dnsProbeBlocksSetup(probe: { ok: boolean; status: number }): boolean {
	return !probe.ok && (probe.status === 401 || probe.status === 403);
}

/**
 * Classifies the Image Transformations preflight outcome from the zone-setting
 * GET and (when it was off) the enabling PATCH's success: `true` = on (already
 * on, or PATCHed on), `false` = still off (PATCH failed), `null` = unknown (the
 * GET failed, e.g. the token lacks Zone Settings·Read). `patchOk` is ignored
 * unless the GET succeeded and reported the setting as off.
 */
export function imageResizingOutcome(
	getRes: { ok: boolean; result?: unknown },
	patchOk: boolean
): boolean | null {
	if (!getRes.ok) return null;
	if (imageResizingIsOn(getRes)) return true;
	return patchOk;
}

/**
 * True when the Image Transformations GET succeeded and reported the setting as
 * ON. Keeps the `value === 'on'` parse in this file only — setup.ts used to
 * duplicate it inline to decide whether to PATCH, a drift trap with
 * imageResizingOutcome. setup.ts now derives its "should I enable?" gate from
 * `getRes.ok && !imageResizingIsOn(getRes)`.
 */
export function imageResizingIsOn(getRes: { result?: unknown }): boolean {
	return (getRes.result as { value?: string } | undefined)?.value === 'on';
}

export interface CfApiResult {
	ok: boolean;
	status: number;
	result?: unknown;
	errors?: unknown;
}

/**
 * Minimal Cloudflare REST caller for the few steps wrangler can't do (attaching
 * Pages project bindings, the zone/DNS + image-transformations preflights).
 * Returns ok=false with the parsed errors so callers can print an actionable
 * fallback rather than throwing. `ok` requires BOTH an HTTP-ok response and
 * `success !== false` in the body, so a 200 with `"success": false` (e.g. a
 * PATCH the token wasn't scoped for) is correctly reported as a failure rather
 * than a spurious "✔ attached bindings". A thrown fetch (network error) is
 * `{ ok: false, status: 0 }`. Lives here (not setup.ts) so it is unit-testable —
 * setup.ts self-executes and can't be imported.
 */
export async function cfApi(
	apiToken: string,
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<CfApiResult> {
	try {
		const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
			method: init.method ?? 'GET',
			headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
			body: init.body ? JSON.stringify(init.body) : undefined
		});
		const json = (await res.json().catch(() => ({}))) as {
			success?: boolean;
			result?: unknown;
			errors?: unknown;
		};
		return { ok: res.ok && json.success !== false, status: res.status, result: json.result, errors: json.errors };
	} catch (e) {
		return { ok: false, status: 0, errors: e };
	}
}

export interface GhEligibilityInput {
	/** `gh` binary is on PATH. */
	ghInstalled: boolean;
	/** `gh auth status` succeeds. */
	ghAuthenticated: boolean;
	/** The repo has a GitHub `origin` remote. */
	hasGithubOrigin: boolean;
	/** CLOUDFLARE_API_TOKEN from the environment (unset ⇒ `wrangler login` was used). */
	apiToken?: string;
	/** CLOUDFLARE_ACCOUNT_ID from the environment. */
	accountId?: string;
}

/**
 * Decides whether setup can offer to wire the fork's GitHub Actions secrets/vars
 * for CI deploys. Returns a skip `reason` (printed as a note) when any
 * precondition is missing, so the operator knows exactly what to fix. The token
 * check is deliberate: if CLOUDFLARE_API_TOKEN isn't in the environment the
 * operator authenticated via `wrangler login`, and we have no value to set.
 */
export function ghSecretEligibility(input: GhEligibilityInput): { eligible: boolean; reason?: string } {
	if (!input.ghInstalled) return { eligible: false, reason: 'the `gh` CLI is not installed' };
	if (!input.ghAuthenticated)
		return { eligible: false, reason: 'the `gh` CLI is not authenticated (run `gh auth login`)' };
	if (!input.hasGithubOrigin) return { eligible: false, reason: 'this repo has no GitHub `origin` remote' };
	if (!input.apiToken || !input.accountId)
		return {
			eligible: false,
			reason:
				'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not in the environment (you likely used `wrangler login`)'
		};
	return { eligible: true };
}

export interface CiWiringInput {
	apiToken: string;
	accountId: string;
	cronSecret: string;
	setupToken: string;
	project: string;
	dbName: string;
	siteUrl: string;
	/** Resolved FurTrack mode ('off' | 'mock' | 'live'). */
	furtrackMode: string;
}

export interface CiEntry {
	kind: 'secret' | 'variable';
	name: string;
	value: string;
}

/**
 * The exact set of GitHub Actions secrets/variables setup wires for CI deploys,
 * as an ordered list so setup.ts just maps `ghSet` over it and a contract test
 * can assert every NAME is consumed by a workflow YAML (a rename on either side
 * would otherwise no-op silently — the #51 bug class).
 *
 * FURTRACK_MODE is ALWAYS included (including the value 'off'), not gated on
 * "enabled". deploy.yml re-PATCHes this variable onto the Pages project every
 * deploy; if setup skipped it on a live→off re-run the stale 'live' would keep
 * being re-applied forever. Writing 'off' explicitly neutralizes it — the app
 * maps any non-live/mock value to disabled (src/lib/server/furtrack.ts) — and
 * `gh variable set` is idempotent, so this is safe on a fresh fork too (unlike a
 * delete, which 404s when the variable was never set).
 */
export function ciWiringEntries(input: CiWiringInput): CiEntry[] {
	return [
		{ kind: 'secret', name: 'CLOUDFLARE_API_TOKEN', value: input.apiToken },
		{ kind: 'secret', name: 'CLOUDFLARE_ACCOUNT_ID', value: input.accountId },
		{ kind: 'secret', name: 'CRON_SECRET', value: input.cronSecret },
		{ kind: 'secret', name: 'SETUP_TOKEN', value: input.setupToken },
		{ kind: 'variable', name: 'CLOUDFLARE_PAGES_PROJECT', value: input.project },
		{ kind: 'variable', name: 'D1_DATABASE_NAME', value: input.dbName },
		{ kind: 'variable', name: 'SITE_URL', value: input.siteUrl },
		{ kind: 'variable', name: 'FURTRACK_MODE', value: input.furtrackMode }
	];
}

/**
 * End-of-run summary lines for the zone-security provisioning (public-endpoint
 * rate limit + admin-login Turnstile). The two features are independent, so the
 * Turnstile lines must print for every rate-limit outcome — kept pure so a test
 * can pin that, and the wording, without running the CLI.
 *
 * Status contracts: null = not attempted (no domain / no zone / no token);
 * 'error' = provisioning failed — `downloadRateLimitDetail` carries waf-lib's
 * reason (missing scope, absent zone, HTTP failure), which the summary repeats
 * instead of assuming a cause; 'exists' rate limits are old news and stay
 * silent.
 *
 * `turnstileWired` says whether BOTH halves of the wiring actually landed (the
 * Pages PATCH carrying TURNSTILE_SITEKEY and the TURNSTILE_SECRET put). The
 * login check fails open when either is missing, so a provisioned widget with
 * failed wiring must read as NOT protected — never as enforced.
 */
export function securitySummaryLines(
	host: string,
	downloadRateLimit: RateLimitStatus | null,
	downloadRateLimitDetail: string | null,
	turnstileStatus: TurnstileStatus | null,
	turnstileWired: boolean
): string[] {
	const lines: string[] = [];
	if (downloadRateLimit === 'error') {
		lines.push(
			`  • Public-endpoint rate limit: NOT set (${downloadRateLimitDetail ?? 'provisioning failed'}).`
		);
		lines.push('     Fix that, then run:');
		lines.push(`       CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- ${host}`);
	} else if (downloadRateLimit && downloadRateLimit !== 'exists') {
		lines.push(
			`  • Public-endpoint rate limit: applied to the ${host} zone (download beacon + oEmbed).`
		);
	}
	if (turnstileStatus === 'error') {
		lines.push('  • Admin-login bot check: NOT set (token lacks Account · Turnstile · Edit).');
		lines.push('     Add that permission to the token and re-run setup to protect /admin/login.');
	} else if (turnstileStatus && !turnstileWired) {
		// Worded as an unverified-THIS-RUN claim: on a re-run, a previous run may
		// have wired the project already, so "no bot check" would be false there —
		// but on a first run it's exactly true, and that's the case that matters.
		lines.push(
			`  • Admin-login bot check: Turnstile widget ${turnstileStatus} for ${host}, but this run could`
		);
		lines.push('     NOT confirm the TURNSTILE_SITEKEY var + TURNSTILE_SECRET secret attached. On a');
		lines.push('     first run that means /admin/login has NO bot check (it fails open without both) —');
		lines.push('     re-run setup, or set the var + secret on the Pages project yourself.');
	} else if (turnstileStatus) {
		lines.push(`  • Admin-login bot check: Turnstile ${turnstileStatus} for ${host}`);
		lines.push('     (TURNSTILE_SITEKEY var + TURNSTILE_SECRET secret set; enforced once deployed).');
	}
	return lines;
}

/**
 * True when a Pages-project PATCH response confirms TURNSTILE_SITEKEY persisted
 * with the value we sent. The PATCH returns the updated project; a 200 whose
 * body silently dropped the var must not be reported as wired (the login check
 * fails open without the sitekey), so the summary's turnstileWired flag keys
 * off this read-back, not the HTTP status alone. Missing/malformed bodies read
 * as unconfirmed — the safe, under-claiming direction.
 */
export function pagesPatchConfirmsSitekey(result: unknown, sitekey: string): boolean {
	const envVars = (
		result as {
			deployment_configs?: { production?: { env_vars?: Record<string, { value?: string } | null> } };
		} | null
	)?.deployment_configs?.production?.env_vars;
	return envVars?.TURNSTILE_SITEKEY?.value === sitekey;
}

/**
 * Next-steps lines for wiring the R2 public URL (the CDN host) to the bucket.
 * connect-domains is the primary path when a domain was given — it can't run
 * inside setup because the zone must already be ACTIVE, and nameserver
 * propagation can lag by hours. But connect-domains always attaches
 * `cdn.<domain>`, so when the operator overrode the R2 public URL to anything
 * else (or gave no domain), pointing them at it would wire the WRONG host and
 * leave images 404ing — those cases get the dashboard walkthrough instead.
 * Takes the raw domain answer (may be empty) and normalizes it itself. Kept
 * pure so a test can pin that the connect-domains pointer doesn't rot out of
 * the output again (a real fork setup shipped broken images because nothing
 * named it).
 */
export function cdnAttachmentLines(r2PublicUrl: string, bucket: string, domain: string): string[] {
	const host = hostFromDomain(domain);
	if (host && hostFromDomain(r2PublicUrl) === `cdn.${host}`) {
		return [
			`  3. Connect ${r2PublicUrl} to the bucket — setup did not touch DNS. Once the`,
			'     zone is active in Cloudflare, run:',
			'       CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \\',
			`         npm run connect-domains -- ${host}`,
			'     Or add the CDN host by hand:',
			`       Cloudflare dashboard → R2 → ${bucket} → Settings → Custom Domains → add ${r2PublicUrl}.`,
			'     Images 404 until this is done. Diagnose a half-finished domain setup with:',
			'       CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \\',
			`         npm run connect-domains -- --check ${host}`
		];
	}
	return [
		`  3. Point ${r2PublicUrl} at the bucket YOURSELF (setup did not touch DNS):`,
		`     Cloudflare dashboard → R2 → ${bucket} → Settings → Custom Domains → add ${r2PublicUrl},`,
		'     then create the DNS record it prompts for. Images 404 until this is done.'
	];
}
