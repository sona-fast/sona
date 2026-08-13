/**
 * Guard: schema.ts and drizzle/ must agree (#105).
 *
 * Nothing else catches their divergence. Deleting an `index()` from schema.ts
 * while its migration stays in drizzle/ breaks no test and no runtime path —
 * the D1 still has the index — but the next `drizzle-kit generate` silently
 * folds a spurious DROP INDEX into whatever migration a later change produces.
 *
 * drizzle-kit has no dry-run: `check` only validates the migration history's
 * internal consistency (journal gaps, snapshot collisions), never schema.ts
 * against it. So this generates for real, against a throwaway copy of
 * drizzle/meta in a temp dir, and fails if that produces a migration. The repo
 * is never written to, and no database or network is involved — the generator
 * diffs schema.ts against the last committed snapshot.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import drizzleConfig from '../../../../drizzle.config.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * drizzle-kit's own `generate` prints this, and only this, when there is
 * nothing to emit. It is the wording of the pinned drizzle-kit; should a
 * version bump reword it, every run of this guard fails rather than passing
 * quietly, which is the right direction to break in.
 */
const NOTHING_TO_MIGRATE = 'No schema changes, nothing to migrate';

// Read from the real config so the guard cannot check a different schema,
// dialect, or migrations directory than the one the project generates into.
function required(key: 'schema' | 'out' | 'dialect'): string {
	const value = drizzleConfig[key];
	if (typeof value !== 'string') {
		throw new Error(`drizzle.config.ts must declare a single ${key} for the drift guard to check`);
	}
	return value;
}
const schemaPath = path.resolve(repoRoot, required('schema'));
const migrationsDir = path.resolve(repoRoot, required('out'));
const dialect = required('dialect');

// Resolve the drizzle-kit the project depends on through node's own package
// resolution and its declared `bin`, rather than scanning for a
// node_modules/.bin — so the guard runs the version package.json pins and not
// whichever executable happens to sit on a path above the checkout.
// (Its package.json is not reachable through the package's `exports` map, so
// the directory comes from the main entry instead.)
const require_ = createRequire(import.meta.url);
const drizzleKitDir = path.dirname(require_.resolve('drizzle-kit'));
const { bin } = JSON.parse(readFileSync(path.join(drizzleKitDir, 'package.json'), 'utf8'));
const drizzleKitBin = path.join(drizzleKitDir, bin['drizzle-kit']);
/** The install drizzle-kit came from, so a schema copy can resolve drizzle-orm. */
const nodeModules = path.dirname(drizzleKitDir);

/**
 * The generator's own words, minus its stack frames: vitest resolves any
 * `at …/bin.cjs:1:2` line it finds in a failure message against that file's
 * source map, and drizzle-kit's bundle breaks that parser — which would replace
 * the real failure with an unrelated crash.
 */
function diagnostic(output: string | null): string {
	// A child that never started (ENOENT, EAGAIN under a loaded runner) reports
	// no output at all, so this has to tolerate its absence.
	if (!output) return '';
	return output
		.split('\n')
		.filter((line) => !/^\s+at\s/.test(line))
		.join('\n')
		.trim();
}

const CHILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

/**
 * Runs `drizzle-kit generate` against a copy of the committed migration
 * metadata, in a temp directory that is removed again either way. Returns the
 * SQL a real generate would emit, or null when schema and migrations agree.
 *
 * `out` is resolved relative to the process cwd by drizzle-kit, so the command
 * runs from the temp dir and the schema is passed as an absolute path.
 */
function pendingMigration(schema: string): string | null {
	const workDir = mkdtempSync(path.join(tmpdir(), 'sona-schema-drift-'));
	try {
		const outDir = path.join(workDir, 'out');
		mkdirSync(outDir);
		cpSync(path.join(migrationsDir, 'meta'), path.join(outDir, 'meta'), { recursive: true });

		const result = spawnSync(
			process.execPath,
			[drizzleKitBin, 'generate', '--dialect', dialect, '--schema', schema, '--out', './out'],
			// stdin is closed so an interactive prompt fails instead of hanging.
			{ cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: CHILD_TIMEOUT_MS }
		);

		const generated = readdirSync(outDir)
			.filter((f) => f.endsWith('.sql'))
			.sort();
		if (result.status === 0 && generated.length > 0) {
			return generated.map((f) => readFileSync(path.join(outDir, f), 'utf8').trim()).join('\n');
		}
		// Silence is not agreement. drizzle-kit exits 0 having emitted nothing
		// when it wanted to ask about a rename — and CI never has a TTY to ask —
		// so require the generator to say so before reporting the schema clean.
		if (result.status === 0 && result.stdout.includes(NOTHING_TO_MIGRATE)) return null;
		const said = diagnostic(result.stderr) || diagnostic(result.stdout) || '(no output)';
		throw new Error(
			`drizzle-kit generate produced neither a migration nor a clean result ` +
				`(exit ${result.status}${result.error ? `, ${result.error.message}` : ''}).\n` +
				`Usually that is a rename it wanted to ask about — which CI has no terminal to answer — ` +
				`or a schema.ts that failed to load. Run \`npx drizzle-kit generate\` locally.\n\n` +
				`drizzle-kit said:\n${said}`
		);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

describe('drizzle schema/migration drift', () => {
	it(
		'has no migration pending for schema.ts',
		() => {
			const pendingSql = pendingMigration(schemaPath);
			expect(
				pendingSql,
				`schema.ts and drizzle/ disagree. Run \`npx drizzle-kit generate\` and commit the migration, or revert the schema change.\n\nPending SQL:\n${pendingSql}`
			).toBeNull();
		},
		TEST_TIMEOUT_MS
	);

	it(
		'detects a schema change that has no migration',
		() => {
			// Proves a green run above means "checked", not "silently passed" — the
			// failure mode #105 describes. The probe adds a table rather than
			// reverting the index from #105, so the guard's own test survives any
			// later edit to the real schema; both are the same schema-vs-snapshot
			// diff, and an added table is the one shape that never prompts.
			const dir = mkdtempSync(path.join(tmpdir(), 'sona-schema-drift-probe-'));
			try {
				// Resolves drizzle-orm for the copied schema without writing to the repo.
				symlinkSync(nodeModules, path.join(dir, 'node_modules'), 'dir');
				const fixture = path.join(dir, 'schema.ts');
				writeFileSync(
					fixture,
					`${readFileSync(schemaPath, 'utf8')}
export const driftProbe = sqliteTable('drift_probe', {
	id: integer('id').primaryKey({ autoIncrement: true })
});
`
				);

				expect(pendingMigration(fixture)).toContain('CREATE TABLE `drift_probe`');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS
	);
});
