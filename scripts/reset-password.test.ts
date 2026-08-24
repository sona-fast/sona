import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPasswordHash } from '../src/lib/server/admin-auth';
import { hashPasswordPbkdf2, readDbName, askHidden } from './reset-password';

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

// The last shell string in the setup workflow. The db name comes from
// wrangler.toml, which an existing deployment may have written before setup
// validated names at all, and the temp path is ours — argv keeps both literal.
describe('reset-password CLI ↔ no shell for the D1 execute', () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'reset-password.ts'), 'utf8');

	it('runs wrangler through execFileSync with an argv array', () => {
		expect(src).toMatch(/execFileSync\(\s*'npx',\s*\[\s*'wrangler',\s*'d1',\s*'execute',\s*dbName,/s);
		expect(src).not.toMatch(/execSync\(\s*`/);
	});

	it('writes the hash through the shared private temp-file helper', () => {
		expect(src).toMatch(/writePrivateTempSql\(\s*sql,\s*'sona-reset-'\s*\)/);
	});
});
