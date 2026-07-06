/**
 * Pure helpers for the Sona setup CLI (scripts/setup.ts), split out so the
 * fiddly logic — the combined migration SQL, the Pages project-name sanitizer,
 * the R2 error sniff, and the gh-secrets eligibility decision — can be unit
 * tested without a Cloudflare account or a live shell.
 */

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
 * Returns '' when no id is found.
 */
export function parseDatabaseId(output: string): string {
	return (output.match(/"?database_id"?\s*[:=]\s*"([0-9a-fA-F-]+)"/) || [])[1] ?? '';
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
	// Matches both git@github.com:owner/repo(.git), ssh://git@github.com/owner/repo,
	// and https://github.com/owner/repo(.git), with or without a trailing slash.
	const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	return m ? `${m[1]}/${m[2]}` : null;
}

export interface PagesConfigInput {
	/** D1 binding name (DB) and the created database's id. */
	dbBinding: string;
	dbId: string;
	/** R2 binding name (IMAGES) and bucket; omit `bucket` to skip the R2 binding. */
	r2Binding: string;
	bucket?: string;
	/** Plain-text environment variables to attach (e.g. FURTRACK_MODE). */
	envVars: Record<string, string>;
}

/**
 * Builds the `PATCH /accounts/{id}/pages/projects/{project}` body that attaches
 * the D1/R2 bindings + plain-text vars to the Pages project's PRODUCTION config.
 * setup writes these only to the gitignored `wrangler.toml`, so a CI-only deploy
 * (which never sees that file) ships without them; this wires them onto the
 * project itself. The PATCH merges per key, so unrelated project config is
 * untouched. The R2 binding is omitted when no bucket exists (R2 not enabled).
 */
export function buildPagesConfigPayload(input: PagesConfigInput): Record<string, unknown> {
	const env_vars: Record<string, { type: string; value: string }> = {};
	for (const [name, value] of Object.entries(input.envVars)) {
		env_vars[name] = { type: 'plain_text', value };
	}
	const production: Record<string, unknown> = {
		d1_databases: { [input.dbBinding]: { id: input.dbId } },
		env_vars
	};
	if (input.bucket) production.r2_buckets = { [input.r2Binding]: { name: input.bucket } };
	return { deployment_configs: { production } };
}

/**
 * True when `wrangler whoami` output indicates the credentials resolve. Used by
 * the setup preflight to fail early with an actionable message rather than
 * midway through provisioning. Checks the "You are logged in" success marker
 * FIRST: a User API Token lacking User → User Details → Read still authenticates
 * (exit 0) but prints "Unable to retrieve email for this user" — that token
 * provisions fine, so it must not be read as a failure. Only then check the
 * hard "not authenticated" failure markers.
 */
export function tokenResolves(whoamiOutput: string): boolean {
	if (/you are logged in/i.test(whoamiOutput)) return true;
	if (/not authenticated|authentication error/i.test(whoamiOutput)) return false;
	return /logged in|associated with/i.test(whoamiOutput);
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
	if ((getRes.result as { value?: string } | undefined)?.value === 'on') return true;
	return patchOk;
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
