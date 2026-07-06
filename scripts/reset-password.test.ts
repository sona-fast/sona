import { describe, it, expect } from 'vitest';
import { verifyPasswordHash } from '../src/lib/server/admin-auth';
import { hashPasswordPbkdf2, readDbName } from './reset-password';

describe('reset-password CLI — hash parity with admin-auth', () => {
	it('produces a hash the app verifies as correct', async () => {
		const hash = await hashPasswordPbkdf2('correct horse battery staple');
		expect(hash).toMatch(/^pbkdf2\$sha256\$100000\$[^$]+\$[^$]+$/);
		expect(await verifyPasswordHash('correct horse battery staple', hash)).toBe(true);
	});

	it('produces a hash the app rejects for the wrong password', async () => {
		const hash = await hashPasswordPbkdf2('s3cret-pw');
		expect(await verifyPasswordHash('s3cret-pX', hash)).toBe(false);
	});
});

describe('reset-password CLI — reads the D1 name from wrangler.toml', () => {
	it('extracts database_name', () => {
		const toml = `name = "my-fork"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "my-fork-db"\ndatabase_id = "abc"\n`;
		expect(readDbName(toml)).toBe('my-fork-db');
	});

	it('throws when database_name is absent', () => {
		expect(() => readDbName('name = "x"\n')).toThrow(/database_name/);
	});
});
