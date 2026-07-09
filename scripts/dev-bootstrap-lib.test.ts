import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrapDevConfig, readMigrations } from './dev-bootstrap-lib.ts';

// A throwaway repo skeleton with just the files the bootstrap reads.
function makeRepo() {
	const root = mkdtempSync(path.join(tmpdir(), 'sona-bootstrap-'));
	writeFileSync(
		path.join(root, 'wrangler.toml.example'),
		'name = "sona"\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "REPLACE_ME"\n'
	);
	mkdirSync(path.join(root, 'drizzle'));
	// Out-of-order filenames prove the concatenation sorts before applying.
	writeFileSync(path.join(root, 'drizzle', '0001_second.sql'), 'CREATE TABLE second (id INTEGER);');
	writeFileSync(path.join(root, 'drizzle', '0000_first.sql'), 'CREATE TABLE first (id INTEGER);');
	return root;
}

describe('bootstrapDevConfig', () => {
	let root: string;
	let migrated: string[];
	const noopLog = () => {};
	const migrate = (sql: string) => migrated.push(sql);

	beforeEach(() => {
		root = makeRepo();
		migrated = [];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('copies the template verbatim and migrates the local D1 when wrangler.toml is missing', () => {
		const result = bootstrapDevConfig({ repoRoot: root, env: {}, migrate, log: noopLog });

		expect(result).toBe('created');
		const configPath = path.join(root, 'wrangler.toml');
		expect(existsSync(configPath)).toBe(true);
		// Verbatim copy of the committed template (placeholder id and all).
		expect(readFileSync(configPath, 'utf8')).toBe(
			readFileSync(path.join(root, 'wrangler.toml.example'), 'utf8')
		);
		// One migrate call carrying every migration, concatenated in sorted order.
		expect(migrated).toHaveLength(1);
		expect(migrated[0]).toContain('CREATE TABLE first');
		expect(migrated[0]).toContain('CREATE TABLE second');
		expect(migrated[0].indexOf('first')).toBeLessThan(migrated[0].indexOf('second'));
	});

	it('is a no-op when wrangler.toml already exists (never clobbers a real config)', () => {
		const configPath = path.join(root, 'wrangler.toml');
		writeFileSync(configPath, 'name = "my-real-deploy"\ndatabase_id = "a-real-uuid"\n');

		const result = bootstrapDevConfig({ repoRoot: root, env: {}, migrate, log: noopLog });

		expect(result).toBe('config-exists');
		// The real config is untouched and no migration ran.
		expect(readFileSync(configPath, 'utf8')).toContain('my-real-deploy');
		expect(migrated).toHaveLength(0);
	});

	it('rolls back the wrangler.toml sentinel when the migration fails', () => {
		// A failed migrate must not leave a config behind — otherwise every future
		// `npm run dev` would skip the bootstrap and boot an unmigrated DB.
		expect(() =>
			bootstrapDevConfig({
				repoRoot: root,
				env: {},
				migrate: () => {
					throw new Error('wrangler blew up');
				},
				log: noopLog
			})
		).toThrow('wrangler blew up');
		expect(existsSync(path.join(root, 'wrangler.toml'))).toBe(false);
	});

	it('wipes a stale local D1 before migrating so a re-bootstrap is reproducible', () => {
		// Simulate leftover local D1 state (e.g. user deleted only wrangler.toml).
		const d1Dir = path.join(root, '.wrangler', 'state', 'v3', 'd1');
		mkdirSync(d1Dir, { recursive: true });
		writeFileSync(path.join(d1Dir, 'old.sqlite'), 'stale');

		let staleStillPresentWhenMigrateRan = true;
		const logs: string[] = [];
		const result = bootstrapDevConfig({
			repoRoot: root,
			env: {},
			migrate: () => {
				staleStillPresentWhenMigrateRan = existsSync(path.join(d1Dir, 'old.sqlite'));
			},
			log: (m) => logs.push(m)
		});

		expect(result).toBe('created');
		// The stale D1 was wiped BEFORE the migrate ran (reproducible clean apply).
		expect(staleStillPresentWhenMigrateRan).toBe(false);
		// The wipe of an existing local D1 is announced so it is never silent.
		expect(logs.some((l) => /wiping the existing local D1/.test(l))).toBe(true);
	});

	it('skips entirely under the E2E harness (SONA_E2E_WRANGLER_CONFIG set)', () => {
		const result = bootstrapDevConfig({
			repoRoot: root,
			env: { SONA_E2E_WRANGLER_CONFIG: '/tmp/wrangler.e2e.toml' },
			migrate,
			log: noopLog
		});

		expect(result).toBe('skipped-e2e');
		// E2E owns its own config + DB — the bootstrap writes nothing.
		expect(existsSync(path.join(root, 'wrangler.toml'))).toBe(false);
		expect(migrated).toHaveLength(0);
	});
});

describe('readMigrations', () => {
	it('concatenates only .sql files, sorted by filename', () => {
		const root = makeRepo();
		writeFileSync(path.join(root, 'drizzle', 'meta.json'), '{"ignored":true}');
		try {
			const sql = readMigrations(root);
			expect(sql).not.toContain('ignored');
			expect(sql.indexOf('first')).toBeLessThan(sql.indexOf('second'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
