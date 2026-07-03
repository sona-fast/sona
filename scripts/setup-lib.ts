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
