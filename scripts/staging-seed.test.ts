import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { verifyPasswordHash } from '../src/lib/server/admin-auth';
import { hashPasswordPbkdf2 } from './reset-password';

const drizzleDir = new URL('../drizzle/', import.meta.url);
const seedUrl = new URL('./staging-seed.sql', import.meta.url);

/** Apply every drizzle migration in order to a fresh in-memory DB. */
function migratedDb() {
	const sqlite = new Database(':memory:');
	const files = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const name of files) {
		const sql = readFileSync(new URL(name, drizzleDir), 'utf8');
		for (const stmt of sql.split('--> statement-breakpoint')) sqlite.exec(stmt);
	}
	return sqlite;
}

describe('staging-seed.sql', () => {
	it('applies cleanly to a fresh DB after all migrations', () => {
		const sqlite = migratedDb();
		const seed = readFileSync(seedUrl, 'utf8');
		expect(() => sqlite.exec(seed)).not.toThrow();

		// Past first-run setup, so hooks.server.ts won't force the wizard.
		const setup = sqlite
			.prepare("SELECT value FROM site_settings WHERE key = 'setupComplete'")
			.get() as { value: string } | undefined;
		expect(setup?.value).toBe('true');

		// The synthetic artist + its three published images seeded.
		const artists = sqlite.prepare('SELECT COUNT(*) AS n FROM artists').get() as { n: number };
		expect(artists.n).toBe(1);
		const images = sqlite.prepare('SELECT COUNT(*) AS n FROM images WHERE published = 1').get() as { n: number };
		expect(images.n).toBe(3);
	});

	it('ships a placeholder admin hash, never a working credential', () => {
		const seed = readFileSync(seedUrl, 'utf8');
		// The committed seed must not carry a real, verifiable hash.
		expect(seed).toContain('REPLACE_ME_WITH_pbkdf2_HASH');
		expect(seed).not.toMatch(/pbkdf2\$sha256\$\d+\$/);
	});
});

describe('hash-admin-password — seed hash slot round-trips', () => {
	it('a hash generated for the seed verifies against the app once substituted', async () => {
		// hash-admin-password.ts prints exactly this value; substituting it for the
		// placeholder yields an adminPasswordHash the app's verifier accepts.
		const hash = await hashPasswordPbkdf2('staging-admin-pw');
		expect(hash).toMatch(/^pbkdf2\$sha256\$100000\$[^$]+\$[^$]+$/);

		const sqlite = migratedDb();
		const seed = readFileSync(seedUrl, 'utf8').replace('REPLACE_ME_WITH_pbkdf2_HASH', hash);
		sqlite.exec(seed);
		const stored = sqlite
			.prepare("SELECT value FROM site_settings WHERE key = 'adminPasswordHash'")
			.get() as { value: string };
		expect(await verifyPasswordHash('staging-admin-pw', stored.value)).toBe(true);
		expect(await verifyPasswordHash('wrong-pw', stored.value)).toBe(false);
	});
});
