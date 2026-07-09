/**
 * Self-bootstrap for local development (see scripts/dev-bootstrap.ts, run by the
 * `predev` npm hook). On a fresh clone there is no `wrangler.toml` (it is
 * gitignored per-fork), so `vite dev`'s SvelteKit Cloudflare platformProxy has
 * no D1/R2 binding stanzas to read and every page 500s. Local dev needs no real
 * Cloudflare resources: platformProxy runs D1 against a local SQLite keyed by
 * binding name, so the `database_id` is irrelevant locally. This just makes a
 * `wrangler.toml` exist (copied from the committed template, placeholder IDs and
 * all) and migrates the local D1 — nothing is provisioned, nothing is deployed.
 *
 * `npm run setup` still owns real provisioning and overwrites the placeholder
 * IDs with real ones; this never touches an existing `wrangler.toml`.
 */

import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type BootstrapResult = 'skipped-e2e' | 'config-exists' | 'created';

export interface BootstrapDeps {
	/** Repo root holding wrangler.toml(.example) and the drizzle/ migrations. */
	repoRoot: string;
	/** Process env. The E2E harness sets SONA_E2E_WRANGLER_CONFIG (playwright.config.ts). */
	env?: NodeJS.ProcessEnv;
	/** Applies the concatenated migration SQL to the local D1. Injected in tests
	 *  so they never shell out to wrangler. */
	migrate?: (schemaSql: string) => void;
	log?: (msg: string) => void;
}

/** Concatenate drizzle/*.sql (sorted) into one schema script — same order the
 *  e2e seed (tests/e2e/seed.ts) and the setup CLI apply them in. */
export function readMigrations(repoRoot: string): string {
	const dir = path.join(repoRoot, 'drizzle');
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((name) => readFileSync(path.join(dir, name), 'utf8'))
		.join('\n');
}

/**
 * Apply the schema to the DEFAULT local D1 persist dir (.wrangler/state) — the
 * same one getPlatformProxy reads when `vite dev` runs with no SONA_E2E_PERSIST_TO
 * override, so the dev server boots against exactly this database. Targets the
 * `DB` binding (not a database_name), so the placeholder id in wrangler.toml is
 * never consulted. CI=1 keeps wrangler from prompting when there is no TTY.
 */
function migrateLocalD1(repoRoot: string, schemaSql: string): void {
	const tmp = mkdtempSync(path.join(tmpdir(), 'sona-dev-bootstrap-'));
	const schemaPath = path.join(tmp, 'schema.sql');
	writeFileSync(schemaPath, schemaSql);
	try {
		// stdout ignored (wrangler prints a per-statement JSON success array we don't
		// want in the predev output); stderr inherited so real migration errors still
		// surface. A non-zero exit still throws — the caller rolls back wrangler.toml.
		execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${schemaPath}`], {
			cwd: repoRoot,
			stdio: ['ignore', 'ignore', 'inherit'],
			env: { ...process.env, CI: '1' }
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Ensure local dev has a usable `wrangler.toml` + migrated local D1. Returns what
 * it did:
 *   'skipped-e2e'   — the E2E harness manages its own config + throwaway DB.
 *   'config-exists' — a wrangler.toml is already present; left untouched.
 *   'created'       — copied the template and migrated the local D1.
 */
export function bootstrapDevConfig(deps: BootstrapDeps): BootstrapResult {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((m: string) => console.log(m));

	// The E2E harness points the dev server at its own wrangler config + throwaway
	// D1 (SONA_E2E_*) and seeds it in a separate step (playwright.config.ts) — leave
	// real local dev's files alone.
	if (env.SONA_E2E_WRANGLER_CONFIG) return 'skipped-e2e';

	const configPath = path.join(deps.repoRoot, 'wrangler.toml');
	// Never clobber a real, filled-in config (e.g. one written by `npm run setup`).
	if (existsSync(configPath)) return 'config-exists';

	// Start from a clean local D1 so the migrate below is reproducible: the drizzle
	// migrations are plain CREATE TABLE (no IF NOT EXISTS), so re-applying over an
	// existing/half-migrated DB would error. Scoped to the D1 dir (getPlatformProxy's
	// default persist, .wrangler/state/v3/d1) so local R2/KV state is left alone.
	// Mirrors the e2e seed's wipe (tests/e2e/seed.ts).
	const d1Dir = path.join(deps.repoRoot, '.wrangler', 'state', 'v3', 'd1');
	if (existsSync(d1Dir)) log('… wiping the existing local D1 for a clean re-migrate');
	rmSync(d1Dir, { recursive: true, force: true });

	copyFileSync(path.join(deps.repoRoot, 'wrangler.toml.example'), configPath);
	log('✔ wrote wrangler.toml from wrangler.toml.example (placeholder IDs — local dev only; run `npm run setup` before deploying)');

	// Roll back the wrangler.toml sentinel if the migration fails, so a transient
	// wrangler error doesn't leave a config that makes every future `npm run dev`
	// skip the bootstrap and boot against an unmigrated DB — the next run retries clean.
	const migrate = deps.migrate ?? ((sql: string) => migrateLocalD1(deps.repoRoot, sql));
	try {
		migrate(readMigrations(deps.repoRoot));
	} catch (err) {
		rmSync(configPath, { force: true });
		throw err;
	}
	log('✔ applied drizzle migrations to the local D1 (.wrangler)');
	return 'created';
}
