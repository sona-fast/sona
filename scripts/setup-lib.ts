/**
 * Pure helpers for the Sona setup CLI (scripts/setup.ts), split out so the
 * fiddly logic — the combined migration SQL, the Pages project-name sanitizer,
 * the R2 error sniff, and the gh-secrets eligibility decision — can be unit
 * tested without a Cloudflare account or a live shell.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** How a resource name must look, quoted verbatim when one is rejected. */
export const RESOURCE_NAME_RULE =
	'lowercase letters, digits, and hyphens only (no spaces, quotes, or other punctuation), 1 to 58 characters, starting and ending with a letter or digit';

/**
 * True when `name` is safe to use as a Pages project / D1 database / R2 bucket
 * name — the same character set `sanitizeProjectName` produces, which is also
 * what Cloudflare accepts. Checked on the operator's ANSWER, not just the prompt
 * default: setup hands these names to wrangler and writes them into
 * wrangler.toml, so a name carrying anything else risks the two disagreeing.
 */
export function isValidResourceName(name: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) && name.length <= 58;
}

/**
 * The default name setup offers for a derived resource (`<project>-db`,
 * `<project>-images`). The project portion is truncated so the result always
 * passes isValidResourceName: a 58-character project name is legal, but
 * `<that>-images` is not, and setup would then reject a default it wrote itself
 * — fatal on a run with no TTY to re-ask on.
 */
export function derivedResourceName(project: string, suffix: string): string {
	const stem = project.slice(0, Math.max(58 - suffix.length - 1, 0)).replace(/-+$/, '');
	return stem ? `${stem}-${suffix}` : suffix;
}

/**
 * Ask for a resource name until the answer is one wrangler and wrangler.toml will
 * agree on. `ask` and `isInteractive` are injected so the loop is testable and so
 * this file stays free of readline and process state; `onReject` lets the caller
 * explain the rule in its own voice. Returns null when a rejected answer can't be
 * re-asked — a piped or CI run has no second answer to give, and provisioning
 * under a name we would have to rewrite is what this guards against.
 */
export async function askResourceName(
	question: string,
	def: string,
	deps: {
		ask: (question: string, def: string) => Promise<string>;
		isInteractive: boolean;
		onReject?: (answer: string) => void;
	}
): Promise<string | null> {
	for (;;) {
		const answer = await deps.ask(question, def);
		if (isValidResourceName(answer)) return answer;
		deps.onReject?.(answer);
		if (!deps.isInteractive) return null;
	}
}

/**
 * Write SQL to a private temp file — `mkdtemp` gives a directory only the current
 * user can read (0700), so a seed or a password hash never sits in a predictable,
 * world-readable path under the shared /tmp. Caller removes the returned directory
 * once done. (The one impure helper here, shared by setup.ts and
 * reset-password.ts so the three SQL temp files can't drift apart on permissions.)
 */
export function writePrivateTempSql(sql: string, prefix: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const path = join(dir, 'sona.sql');
	writeFileSync(path, sql, { mode: 0o600 });
	return { dir, path };
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
 * True when a `wrangler r2 bucket create` run left the bucket in place: a clean
 * exit, or a failure that only means the bucket was already there (error 10004 —
 * the re-run case, which exits non-zero but is a success for our purposes).
 *
 * Every other failure means NO bucket: R2 not enabled, or — the case that
 * prompted this — a token missing Account → Workers R2 Storage: Edit, which
 * carries none of isR2NotEnabled's markers and so used to read as success.
 */
export function bucketCreateSucceeded(output: string, commandOk: boolean): boolean {
	return commandOk || /\b10004\b/.test(output) || /already exists/i.test(output);
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
 * GET failed, e.g. the token lacks Zone → Zone Settings: Read). `patchOk` is ignored
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

/**
 * True for a non-null object — the guard every API-body walk needs before it
 * reads a property, since `typeof null === 'object'`. Shared so the four copies
 * that guarded Cloudflare list entries can't drift apart.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

// Cap by code point, not UTF-16 unit, so an emoji at the boundary is dropped
// whole instead of split into a lone surrogate.
const capPoints = (value: string, max: number): string => {
	const points = Array.from(value);
	return points.length > max ? `${points.slice(0, max).join('')}…` : value;
};

/**
 * One printable line naming a cfApi failure. Only the code + message fields
 * are read (never the raw `errors` value JSON.stringified into
 * operator-pasteable output), and any standalone 32-hex run in the message —
 * case-insensitive, whatever delimits it: a path segment, `account_id=…`,
 * quoted, or parenthesized — is scrubbed to `<id>`: Cloudflare's own text can
 * echo object ids (code 7003 quotes the request path, zone id included). A
 * longer hex run is left alone, since it isn't an object id. The message
 * content is otherwise printed verbatim. Anything
 * that isn't the documented { code, message } array shape yields '' (the
 * caller prints just the HTTP status).
 */
export function cfErrorSummary(errors: unknown): string {
	if (!Array.isArray(errors)) return '';
	const joined = errors
		.filter(isRecord)
		.map((e) => {
			// No message, no line — a bare code would print a dangling '10000: '.
			// Strip control/format chars (ANSI escapes, zero-widths), collapse
			// whitespace, and cap each message: bodies can be multi-line or
			// arbitrarily long, and this lands in operator-pasteable output.
			// Format chars are DELETED, not spaced: a zero-width inside an id would
			// otherwise split it into two halves that no longer match the 32-hex run,
			// and the id would print. Control chars still become a space — those do
			// separate words. The id boundaries are alphanumeric lookarounds rather
			// than \b, so an id butted against an underscore still scrubs (\b treats
			// _ as a word char, so `zone_<id>` slipped through).
			const raw =
				typeof e.message === 'string'
					? e.message
							.replace(/\p{Cf}/gu, '')
							.replace(/\p{Cc}/gu, ' ')
							.replace(/\s+/g, ' ')
							.trim()
							.replace(/(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])/gi, '<id>')
					: '';
			if (!raw) return '';
			const message = capPoints(raw, 200);
			return typeof e.code === 'number' ? `${e.code}: ${message}` : message;
		})
		.filter(Boolean)
		.join('; ');
	// Cap the whole summary too, so many errors can't yield a multi-KB line.
	return capPoints(joined, 300);
}

/**
 * Failure tail for a failed cfApi step, appended to an error detail so it
 * carries an honest reason instead of a bare status:
 *   - status 0     → cfApi's thrown-fetch marker; the API was never reached.
 *   - 2xx          → the body said success:false (cfApi maps that to ok=false),
 *                    so repeat the API's own code+message summary.
 *   - 401/403      → the caller's scope hint, then '; the API said …' when
 *                    the body gave a reason (the attribution keeps our advice
 *                    and the API's own words separable).
 *   - anything else (500 etc.) → '; the API said …' when the body gave a
 *                    reason, else bare; never a scope hint — that misdirects.
 * Shared by waf-lib and turnstile-lib, which each bind their own scope hint —
 * the two private copies drifted apart once already.
 */
export function cfFailureTail(status: number, errors: unknown, scopeHint: string): string {
	if (status === 0) return '; the Cloudflare API did not respond';
	const why = cfErrorSummary(errors);
	if (status >= 200 && status < 300) {
		return `; the API reported failure${why ? ` (${why})` : ' with no reason given'}`;
	}
	const hint = status === 401 || status === 403 ? `; token needs ${scopeHint}` : '';
	return `${hint}${why ? `; the API said ${why}` : ''}`;
}

/**
 * The "(HTTP <n>)" fragment of an error detail — empty for status 0, where
 * cfFailureTail already says the API did not respond and a bare "(HTTP 0)"
 * is noise.
 */
export function statusLabel(status: number): string {
	return status === 0 ? '' : ` (HTTP ${status})`;
}

/**
 * The whole "why it failed" suffix for a failed cfApi call: the status label
 * followed by the failure tail. The two are always printed together, so this is
 * the single form every caller appends to its own sentence.
 */
export function failureDetail(res: { status: number; errors?: unknown }, scopeHint: string): string {
	return `${statusLabel(res.status)}${cfFailureTail(res.status, res.errors, scopeHint)}`;
}

/** The scope a zone lookup needs — named only when the status proves it (401/403). */
export const ZONE_READ_SCOPE_HINT = 'Zone → Zone: Read';

/**
 * The warn setup prints when the custom-domain zone lookup fails, as lines.
 * cfFailureTail decides what the reason is per status, so a 400/404/500 that
 * carried a message repeats it (the inline version gated that on 2xx and threw
 * it away for exactly the statuses an operator can least explain), a thrown
 * fetch says the API did not respond instead of "HTTP 0", and Zone → Zone: Read
 * is named only on a 401/403 rather than guessed at for every failure.
 * `name` is the candidate whose lookup failed — for a subdomain host that can be
 * the parent zone, and pointing at the host would mislead.
 */
export function zoneLookupWarnLines(name: string, status: number, errors: unknown): string[] {
	return [
		`\n⚠ Zone lookup failed for ${name}${failureDetail({ status, errors }, ZONE_READ_SCOPE_HINT)} — skipping the DNS / image-transform preflight.`,
		'  Re-run setup to retry the preflight.'
	];
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
 * 'error' = provisioning failed — `downloadRateLimitDetail` / `turnstileDetail`
 * carry the provisioning lib's reason (missing scope, HTTP failure), which the
 * summary repeats instead of assuming a cause; 'exists' rate limits are old
 * news and stay silent.
 *
 * `turnstileWired` says whether BOTH halves of the wiring actually landed (the
 * Pages PATCH carrying TURNSTILE_SITEKEY and the TURNSTILE_SECRET put). The
 * login check fails open when either is missing, so a provisioned widget with
 * failed wiring must read as NOT protected — never as enforced.
 */
export interface SecuritySummaryInput {
	host: string;
	downloadRateLimit: RateLimitStatus | null;
	downloadRateLimitDetail: string | null;
	turnstileStatus: TurnstileStatus | null;
	// turnstile-lib's failure reason when turnstileStatus is 'error'.
	turnstileDetail: string | null;
	turnstileWired: boolean;
	// The RESOLVED zone's name when it differs from the host (subdomain forks):
	// the rate-limit rule is zone-wide, so the applied line must name the zone
	// it actually landed on. The retry command keeps the host — the applier
	// resolves the zone itself.
	zoneName?: string | null;
}

export function securitySummaryLines(input: SecuritySummaryInput): string[] {
	const {
		host,
		downloadRateLimit,
		downloadRateLimitDetail,
		turnstileStatus,
		turnstileDetail,
		turnstileWired,
		zoneName
	} = input;
	const lines: string[] = [];
	if (downloadRateLimit === 'error') {
		lines.push('  • Public-endpoint rate limit: NOT set.');
		lines.push(`     Reason: ${downloadRateLimitDetail ?? 'none reported'}.`);
		lines.push('     When that is fixed, run:');
		lines.push(`       CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- ${host}`);
	} else if (downloadRateLimit && downloadRateLimit !== 'exists') {
		lines.push(
			`  • Public-endpoint rate limit: applied to the ${zoneName ?? host} zone (download beacon + oEmbed).`
		);
	}
	if (turnstileStatus === 'error') {
		lines.push('  • Admin-login bot check: NOT set.');
		lines.push(`     Reason: ${turnstileDetail ?? 'none reported'}.`);
		lines.push('     When that is fixed, re-run setup to protect /admin/login.');
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
		lines.push(`  • Admin-login bot check: Turnstile ${turnstileStatus} for ${host}.`);
		lines.push('     (TURNSTILE_SITEKEY var + TURNSTILE_SECRET secret set; enforced once deployed).');
	}
	return lines;
}

export interface StorageSummaryInput {
	/** Active image store: 'r2' | 'uploadthing'. */
	provider: string;
	/** The R2 bucket create said R2 isn't enabled on the account. */
	r2Missing: boolean;
	/** The bucket create reported the bucket in place (created, or already there). */
	bucketReady: boolean;
	/** The UPLOADTHING_TOKEN secret put succeeded (false when no token was given). */
	uploadThingTokenSet: boolean;
	bucket: string;
	project: string;
}

/**
 * The end-of-run "Storage backend:" lines. Both backends report NOT READY on the
 * state we actually established: R2 when the bucket create didn't put a bucket
 * there, UploadThing when the UPLOADTHING_TOKEN put didn't land (a skipped or
 * failed put used to still print "(set up)", which is the same over-claim
 * turnstileWired exists to prevent — the operator deploys and every upload fails).
 *
 * "R2 is not enabled" is only ONE way the create fails. A token without Account →
 * Workers R2 Storage: Edit fails with none of that error's markers, so the claim
 * keys off the create's own outcome and the not-enabled text only picks the
 * wording — otherwise setup says "(set up)" about a bucket that doesn't exist.
 */
export function storageSummaryLines(input: StorageSummaryInput): string[] {
	const { provider, r2Missing, bucketReady, uploadThingTokenSet, bucket, project } = input;
	if (provider === 'r2') {
		if (bucketReady) return ['Storage backend: Cloudflare R2 (set up).'];
		if (r2Missing)
			return [
				'Storage backend: Cloudflare R2 — NOT READY (R2 is not enabled on this account).',
				`  Create the bucket, then re-run setup:  npx wrangler r2 bucket create ${bucket}`
			];
		return [
			`Storage backend: Cloudflare R2 — NOT READY (the ${bucket} bucket was not created).`,
			`  Create it, then re-run setup:  npx wrangler r2 bucket create ${bucket}`
		];
	}
	if (uploadThingTokenSet) return ['Storage backend: UploadThing (set up).'];
	return [
		'Storage backend: UploadThing — NOT READY (the UPLOADTHING_TOKEN secret is not set).',
		`  Set it, then re-deploy:  npx wrangler pages secret put UPLOADTHING_TOKEN --project-name ${project}`
	];
}

/**
 * Names the Resend secrets whose put failed. These are optional, so silence is
 * right when the operator supplied none — but a value they DID supply that
 * failed to land must be said out loud: password-reset email reads these at
 * runtime, so the failure would otherwise surface as a dead reset link long
 * after setup finished.
 */
export function resendSecretWarnLines(failed: string[], project: string): string[] {
	if (failed.length === 0) return [];
	return [
		`\n⚠ Resend secrets that did NOT get set: ${failed.join(', ')}.`,
		'  Password-reset email stays off until they are:',
		...failed.map((name) => `    npx wrangler pages secret put ${name} --project-name ${project}`)
	];
}

/**
 * The end-of-run "Telegram sticker import:" line. `enabled (bot token set)` is a
 * claim about a secret put, so it needs the put's result — a failed put leaves
 * Telegram import hidden, and saying "enabled" would send the operator hunting in
 * the app for a feature that never turned on.
 */
export function telegramSummaryLine(tokenProvided: boolean, tokenSet: boolean): string {
	if (!tokenProvided) return 'Telegram sticker import: not configured.';
	return tokenSet
		? 'Telegram sticker import: enabled (bot token set).'
		: 'Telegram sticker import: enabled, but the bot token did NOT get set — import stays hidden.';
}

/**
 * The end-of-run block that hands the operator their one-time SETUP_TOKEN. The
 * wizard authenticates against the SETUP_TOKEN secret on the Pages project, so
 * when that put failed the printed value is not yet a working token — say that
 * and give the command, rather than printing it as if the wizard would take it.
 */
export function setupTokenLines(input: { setupToken: string; setupTokenSet: boolean; project: string }): string[] {
	const { setupToken, setupTokenSet, project } = input;
	if (setupTokenSet) {
		return ['\n  Your one-time setup token (enter it in the wizard):\n', `     SETUP_TOKEN = ${setupToken}`];
	}
	return [
		'\n  ⚠ The SETUP_TOKEN secret did NOT get set on the Pages project, so the wizard will',
		'     reject this token until you set it yourself:',
		`       npx wrangler pages secret put SETUP_TOKEN --project-name ${project}`,
		`     SETUP_TOKEN = ${setupToken}`
	];
}

/**
 * The closing parenthetical of the summary, which used to assert both halves
 * unconditionally. Each is a write that can fail: without CRON_SECRET the
 * scheduled syncs can't authenticate, and without the seed the app boots with no
 * storage backend — so each is reported from its own result.
 */
export function provisioningNoteLine(cronSecretSet: boolean, seedOk: boolean): string {
	const cron = cronSecretSet
		? 'CRON_SECRET set for the cron jobs'
		: 'CRON_SECRET NOT set — the cron jobs cannot authenticate';
	const seed = seedOk
		? 'storageProvider seeded'
		: 'storageProvider NOT seeded — set it in admin Settings';
	return `  (${cron}; ${seed}.)`;
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
			`  3. Connect ${r2PublicUrl} to the bucket — setup did not touch DNS.`,
			'     Images 404 until you connect it. Once the zone is active in Cloudflare, run:',
			'       CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \\',
			`         npm run connect-domains -- ${host}`,
			'     Or add the CDN host by hand:',
			`       Cloudflare dashboard → R2 → ${bucket} → Settings → Custom Domains → add ${r2PublicUrl}.`,
			'     Diagnose a half-finished domain setup with:',
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
