import { describe, it, expect } from 'vitest';
import {
	buildMigrationSql,
	sanitizeProjectName,
	isR2NotEnabled,
	ghSecretEligibility
} from './setup-lib.ts';

describe('buildMigrationSql', () => {
	it('creates schema_migrations and records each file after its body, in order', () => {
		const sql = buildMigrationSql([
			{ name: '0000_a.sql', sql: 'CREATE TABLE a (id integer);' },
			{ name: '0001_b.sql', sql: 'CREATE TABLE b (id integer);' }
		]);
		expect(sql).toContain(
			'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);'
		);
		// Each migration body is followed by its own INSERT with the basename key.
		const aBody = sql.indexOf('CREATE TABLE a');
		const aInsert = sql.indexOf("VALUES ('0000_a.sql'");
		const bBody = sql.indexOf('CREATE TABLE b');
		const bInsert = sql.indexOf("VALUES ('0001_b.sql'");
		expect(aBody).toBeGreaterThanOrEqual(0);
		expect(aBody).toBeLessThan(aInsert);
		expect(aInsert).toBeLessThan(bBody);
		expect(bBody).toBeLessThan(bInsert);
	});

	it('uses INSERT OR IGNORE keyed by basename so re-running is idempotent', () => {
		const sql = buildMigrationSql([{ name: '0000_a.sql', sql: 'SELECT 1;' }]);
		expect(sql).toContain(
			"INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('0000_a.sql', datetime('now'));"
		);
	});

	it('trims trailing whitespace from each body', () => {
		const sql = buildMigrationSql([{ name: '0000_a.sql', sql: 'SELECT 1;\n\n  ' }]);
		expect(sql).toContain('SELECT 1;\nINSERT OR IGNORE');
	});

	it('emits only the create when there are no migrations', () => {
		const sql = buildMigrationSql([]);
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
		expect(sql).not.toContain('INSERT OR IGNORE');
	});

	it('escapes single quotes in a basename', () => {
		const sql = buildMigrationSql([{ name: "0000_o'brien.sql", sql: 'SELECT 1;' }]);
		expect(sql).toContain("VALUES ('0000_o''brien.sql'");
	});
});

describe('sanitizeProjectName', () => {
	it('lowercases and turns dots, underscores, and spaces into hyphens', () => {
		expect(sanitizeProjectName('Sparky.Ink')).toBe('sparky-ink');
		expect(sanitizeProjectName('My Cool_Fork')).toBe('my-cool-fork');
	});

	it('drops characters that are not alphanumeric or hyphen', () => {
		expect(sanitizeProjectName('café#site!')).toBe('cafsite');
	});

	it('collapses and trims hyphens', () => {
		expect(sanitizeProjectName('--a..b__c--')).toBe('a-b-c');
	});

	it('caps length at 58 chars without a trailing hyphen', () => {
		const out = sanitizeProjectName('a'.repeat(60) + '-tail');
		expect(out.length).toBeLessThanOrEqual(58);
		expect(out.endsWith('-')).toBe(false);
	});

	it('falls back to sona when nothing usable remains', () => {
		expect(sanitizeProjectName('...')).toBe('sona');
		expect(sanitizeProjectName('')).toBe('sona');
	});
});

describe('isR2NotEnabled', () => {
	it('detects the 10042 error code', () => {
		expect(isR2NotEnabled('Failed [code: 10042]: R2 not enabled')).toBe(true);
	});

	it('detects an "enable R2" prose message', () => {
		expect(isR2NotEnabled('You need to enable R2 for this account.')).toBe(true);
	});

	it('does not flag a benign already-exists failure', () => {
		expect(isR2NotEnabled('A bucket with that name already exists')).toBe(false);
	});

	it('does not flag empty/success output', () => {
		expect(isR2NotEnabled('')).toBe(false);
		expect(isR2NotEnabled('Created bucket sona-images')).toBe(false);
	});
});

describe('ghSecretEligibility', () => {
	const ok = {
		ghInstalled: true,
		ghAuthenticated: true,
		hasGithubOrigin: true,
		apiToken: 'tok',
		accountId: 'acct'
	};

	it('is eligible when everything is present', () => {
		expect(ghSecretEligibility(ok)).toEqual({ eligible: true });
	});

	it('skips (with a reason) when gh is not installed', () => {
		const r = ghSecretEligibility({ ...ok, ghInstalled: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/not installed/);
	});

	it('skips when gh is not authenticated', () => {
		const r = ghSecretEligibility({ ...ok, ghAuthenticated: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/authenticated/);
	});

	it('skips when there is no GitHub origin', () => {
		const r = ghSecretEligibility({ ...ok, hasGithubOrigin: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/origin/);
	});

	it('skips when the CLOUDFLARE_* env values are absent (wrangler login)', () => {
		expect(ghSecretEligibility({ ...ok, apiToken: undefined }).eligible).toBe(false);
		expect(ghSecretEligibility({ ...ok, accountId: '' }).eligible).toBe(false);
	});
});
