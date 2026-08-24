/**
 * CLI password recovery — the offline fallback for an operator locked out of the
 * admin panel (or a fork that never configured Resend/adminEmail for the in-app
 * "Forgot password" flow).
 *
 *   npm run reset-password
 *
 * Prompts for a new password, PBKDF2-hashes it with the SAME parameters as
 * src/lib/server/admin-auth.ts (so the app's verifyPasswordHash accepts it), and
 * writes it to the remote D1 (`adminPasswordHash`), clearing every session. The
 * D1 name is read from wrangler.toml (as `npm run setup` writes it). Requires
 * `wrangler login` (or CLOUDFLARE_API_TOKEN), like the rest of the CLI tooling.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';
import { writePrivateTempSql } from './setup-lib.ts';

// --- PBKDF2 — must stay in lockstep with src/lib/server/admin-auth.ts --------
// (100k iterations is the Cloudflare Workers Web Crypto cap; see admin-auth.ts.)
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Encoded hash `pbkdf2$sha256$<iters>$<saltB64>$<hashB64>`, verifiable by
 * admin-auth.ts's verifyPasswordHash(). Exported for the parity unit test.
 */
export async function hashPasswordPbkdf2(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		key,
		HASH_BYTES * 8
	);
	const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
	return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** Read the D1 database name the app deploys against from wrangler.toml. */
export function readDbName(toml: string): string {
	const match = toml.match(/database_name\s*=\s*"([^"]+)"/);
	if (!match) throw new Error('Could not find database_name in wrangler.toml.');
	return match[1];
}

/**
 * Prompt `query` and read a line WITHOUT echoing it to the terminal (password
 * entry). Node's readline has no built-in hidden-input mode; this is the
 * standard workaround — mute the Interface's per-keystroke echo for the
 * duration of the question, writing the prompt (and the newline the terminal
 * would otherwise have echoed on Enter) ourselves.
 */
export async function askHidden(
	rl: Pick<ReturnType<typeof createInterface>, 'question'>,
	query: string
): Promise<string> {
	const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
	const original = rlAny._writeToOutput;
	rlAny.output.write(query);
	rlAny._writeToOutput = () => {};
	try {
		return await rl.question('');
	} finally {
		rlAny._writeToOutput = original;
		rlAny.output.write('\n');
	}
}

async function main() {
	if (!existsSync('wrangler.toml')) {
		throw new Error('wrangler.toml not found — run this from the project root after `npm run setup`.');
	}
	const dbName = readDbName(readFileSync('wrangler.toml', 'utf8'));

	const rl = createInterface({ input: stdin, output: stdout });
	let sqlDir = '';
	try {
		const pw = await askHidden(rl, `New admin password (min ${MIN_PASSWORD_LENGTH} chars): `);
		if (pw.length < MIN_PASSWORD_LENGTH) {
			throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
		}
		const confirm = await askHidden(rl, 'Confirm new password: ');
		if (pw !== confirm) throw new Error('Passwords do not match.');

		const hash = await hashPasswordPbkdf2(pw);
		// The hash contains `$` separators, so it must NOT go through a shell
		// `--command` string (the shell would expand `$sha256`, `$100000`, …). Write
		// it to a temp .sql file and use `--file`, the same way setup.ts applies SQL.
		const esc = (s: string) => s.replace(/'/g, "''");
		const sql = `INSERT OR REPLACE INTO site_settings (key,value) VALUES ('adminPasswordHash','${esc(hash)}');\nDELETE FROM sessions;\n`;
		const written = writePrivateTempSql(sql, 'sona-reset-');
		sqlDir = written.dir;

		console.log(`\nWriting new password hash to D1 "${dbName}" (remote) and clearing sessions…`);
		// stdin ignored → wrangler's non-TTY path skips the "Ok to proceed?" prompt.
		// argv, not a shell string: the db name comes from wrangler.toml, and an
		// existing deployment may legitimately carry characters a shell would act on.
		execFileSync(
			'npx',
			['wrangler', 'd1', 'execute', dbName, '--remote', `--file=${written.path}`],
			{ stdio: ['ignore', 'inherit', 'inherit'] }
		);
		console.log('\n✔ Admin password reset. Sign in at /admin/login with the new password.');
	} finally {
		rl.close();
		if (sqlDir) {
			try {
				rmSync(sqlDir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
		}
	}
}

// Only run the interactive flow when invoked directly — importing this module
// (e.g. the parity test) must not prompt or touch D1.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err) => {
		console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
