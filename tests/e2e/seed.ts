import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { E2E_DB_NAME, E2E_PERSIST_TO, E2E_WRANGLER_CONFIG } from './paths';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function wrangler(args: string[]): void {
	execFileSync('npx', ['wrangler', ...args], {
		cwd: repoRoot,
		stdio: 'inherit',
		// No TTY in CI: keep wrangler from prompting "Ok to proceed?".
		env: { ...process.env, CI: '1' }
	});
}

/**
 * Build a hermetic local D1 for the browser tests: wipe the throwaway persist
 * dir, apply every drizzle migration in order, then load the seed fixture.
 *
 * Run from the playwright webServer command *before* `vite dev` boots (see
 * playwright.config.ts) — not from a playwright globalSetup: playwright starts
 * the webServer before globalSetup, so seeding there would race the running
 * miniflare and wipe the DB out from under it. The dev server reads the same
 * files via getPlatformProxy (SONA_E2E_PERSIST_TO = E2E_PLATFORM_PERSIST), so it
 * boots against exactly this DB — never the developer's real dev database.
 */
function seed(): void {
	// Which throwaway persist dir to build. Defaults to the shared read-only DB;
	// the recovery webServer overrides it (SONA_E2E_SEED_PERSIST_TO) so its
	// session-mutating spec runs against an isolated DB. See paths.ts.
	const persistTo = process.env.SONA_E2E_SEED_PERSIST_TO ?? E2E_PERSIST_TO;
	rmSync(persistTo, { recursive: true, force: true });

	// Concatenate drizzle/*.sql (sorted) into one schema script and apply it in a
	// single d1 execute. Mirrors scripts/setup.ts; no migration tracking table is
	// needed because this DB is thrown away and rebuilt every run.
	const migrations = readdirSync(path.join(repoRoot, 'drizzle'))
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((name) => readFileSync(path.join(repoRoot, 'drizzle', name), 'utf8'))
		.join('\n');
	const tmp = mkdtempSync(path.join(tmpdir(), 'sona-e2e-'));
	const schemaPath = path.join(tmp, 'schema.sql');
	writeFileSync(schemaPath, migrations);

	const target = [
		E2E_DB_NAME,
		'--local',
		`--config=${E2E_WRANGLER_CONFIG}`,
		`--persist-to=${persistTo}`
	];
	try {
		wrangler(['d1', 'execute', ...target, `--file=${schemaPath}`]);
		wrangler(['d1', 'execute', ...target, `--file=${path.join(repoRoot, 'tests/e2e/fixtures/seed.sql')}`]);
		// The seeded VR avatar's model must LOOK servable to the /vr/[slug] load
		// (modelBytesServable HEADs the bucket key) so the View-in-3D control
		// renders. Stub bytes only — the specs never enter the 3D view.
		const modelStub = path.join(tmp, 'e2e-avatar.vrm');
		writeFileSync(modelStub, 'glTF e2e stub — head-probe only, never parsed');
		wrangler([
			'r2',
			'object',
			'put',
			'sona-e2e-images/vr-models/e2e-avatar.vrm',
			`--file=${modelStub}`,
			'--local',
			`--config=${E2E_WRANGLER_CONFIG}`,
			`--persist-to=${persistTo}`
		]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

seed();
