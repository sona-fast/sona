import { describe, it, expect } from 'vitest';
import { existsSync, statSync, rmSync } from 'node:fs';
import { verifyPasswordHash } from '../src/lib/server/admin-auth';
import { hashPasswordPbkdf2, readDbName, askHidden, writePrivateTempSql } from './reset-password';

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

describe('reset-password CLI — masked password input', () => {
	it('suppresses per-keystroke echo while answering, writes only the prompt + trailing newline, and restores the original handler after', async () => {
		const written: string[] = [];
		const originalEcho = (s: string) => written.push(`echo:${s}`);
		const rl = {
			output: { write: (s: string) => written.push(s) },
			_writeToOutput: originalEcho,
			question: async () => 'hunter2'
		};

		const answer = await askHidden(rl as never, 'Password: ');

		expect(answer).toBe('hunter2');
		// Only our direct writes (prompt, then the newline) — no per-keystroke
		// echo of what was typed made it through.
		expect(written).toEqual(['Password: ', '\n']);
		// The original echo handler is back in place once the question resolves.
		expect(rl._writeToOutput).toBe(originalEcho);
	});
});

describe('reset-password CLI — private temp SQL file', () => {
	it('writes the SQL into a 0700 dir as a 0600 file', () => {
		const sql = "INSERT OR REPLACE INTO site_settings (key,value) VALUES ('adminPasswordHash','x');\n";
		const { dir, path } = writePrivateTempSql(sql);

		try {
			expect(existsSync(path)).toBe(true);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
