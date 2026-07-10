/**
 * Print a PBKDF2 admin-password hash for the staging seed.
 *
 *   echo -n 'your-staging-password' | npx tsx scripts/hash-admin-password.ts
 *
 * Reads the password from stdin (so it never lands in shell history or argv) and
 * writes the encoded `pbkdf2$sha256$...` hash to stdout — the same format the
 * app's verifyPasswordHash() accepts. Substitute the printed value for the
 * REPLACE_ME_WITH_pbkdf2_HASH placeholder in scripts/staging-seed.sql before
 * loading the seed (see docs/staging.md). Reuses reset-password.ts's hasher so
 * there is exactly one PBKDF2 implementation for the CLI tooling.
 */
import { fileURLToPath } from 'node:url';
import { hashPasswordPbkdf2 } from './reset-password';

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	// Trim only the trailing newline `echo`/a heredoc adds, not interior chars.
	const password = (await readStdin()).replace(/\r?\n$/, '');
	if (!password) {
		throw new Error('No password on stdin. Usage: echo -n <password> | npx tsx scripts/hash-admin-password.ts');
	}
	process.stdout.write((await hashPasswordPbkdf2(password)) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err) => {
		console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
