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

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const schemaPath = path.join(repoRoot, 'src/lib/server/db/schema.ts');

/**
 * Nearest installed node_modules, walking up from the repo. A git worktree of
 * this repo has no node_modules of its own and resolves to the main checkout's,
 * exactly as node does; CI finds it in the repo root.
 */
function findNodeModules(): string {
	for (let dir = repoRoot; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules');
		if (existsSync(path.join(candidate, '.bin', 'drizzle-kit'))) return candidate;
		if (path.dirname(dir) === dir) throw new Error('drizzle-kit is not installed; run `npm ci`');
	}
}
const nodeModules = findNodeModules();

interface DriftResult {
	/** SQL drizzle-kit would emit, or null when schema and migrations agree. */
	pendingSql: string | null;
}

/** The fields this guard reads out of the project's drizzle.config.ts. */
interface DrizzleConfig {
	dialect: string;
	out: string;
}

// Read from the real config so the guard can't check a different dialect or
// migrations directory than the one the project generates into.
let config: DrizzleConfig;
beforeAll(async () => {
	const loaded = (await import('../../../../drizzle.config.ts')).default as Partial<DrizzleConfig>;
	expect(loaded.dialect, 'drizzle.config.ts should declare a dialect').toBeTruthy();
	expect(loaded.out, 'drizzle.config.ts should declare an out directory').toBeTruthy();
	config = loaded as DrizzleConfig;
});

/**
 * Runs `drizzle-kit generate` against a copy of the committed migration
 * metadata, in a temp directory that is removed again either way.
 *
 * `out` is resolved relative to the process cwd by drizzle-kit, so the command
 * runs from the temp dir; the schema is passed as an absolute path, and the
 * dialect comes from drizzle.config.ts so the two can't drift apart.
 */
function pendingMigration(schema: string, config: DrizzleConfig): DriftResult {
	const { dialect, out } = config;
	const workDir = mkdtempSync(path.join(tmpdir(), 'sona-schema-drift-'));
	try {
		const outDir = path.join(workDir, 'out');
		mkdirSync(outDir);
		cpSync(path.join(repoRoot, out, 'meta'), path.join(outDir, 'meta'), { recursive: true });

		execFileSync(
			path.join(nodeModules, '.bin', 'drizzle-kit'),
			['generate', '--dialect', dialect, '--schema', schema, '--out', './out'],
			// stdin is closed so an unexpected rename prompt fails instead of hanging.
			{ cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }
		);

		const generated = readdirSync(outDir)
			.filter((f) => f.endsWith('.sql'))
			.sort();
		if (generated.length === 0) return { pendingSql: null };
		return {
			pendingSql: generated
				.map((f) => readFileSync(path.join(outDir, f), 'utf8').trim())
				.join('\n')
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

describe('drizzle schema/migration drift', () => {
	it('has no migration pending for schema.ts', () => {
		const { pendingSql } = pendingMigration(schemaPath, config);
		expect(
			pendingSql,
			`schema.ts and drizzle/ disagree. Run \`npx drizzle-kit generate\` and commit the migration, or revert the schema change.\n\nPending SQL:\n${pendingSql}`
		).toBeNull();
	});

	it('detects a schema change that has no migration', () => {
		// Proves a green run above means "checked", not "silently passed" — the
		// failure mode #105 describes. The probe adds a table rather than reverting
		// the index from #105, so the guard's own test survives any later edit to
		// the real schema; both are the same schema-vs-snapshot diff.
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

			expect(pendingMigration(fixture, config).pendingSql).toContain(
				'CREATE TABLE `drift_probe`'
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
