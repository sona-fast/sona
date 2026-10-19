import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-D1 harness for the password-reset write (PR #493).
//
// The reset action writes the new password with a conditional upsert —
// INSERT ... SELECT ... WHERE EXISTS(<the validated reset row>) ON CONFLICT DO
// UPDATE — and reads a revoked link off `meta.changes === 0` on its result. The
// unit suite runs that against a better-sqlite3 shim whose meta.changes is the
// shim's own arithmetic. If real D1 rejected the statement shape, or reported
// changes differently for it, every reset would fail with "invalid link" in
// production while the unit suite stayed green. This runs the real action,
// bundled into a worker (worker-fixtures/reset-worker.ts), against Miniflare's
// D1 with the repo's real migrations applied.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Verdict {
	outcome: { kind: 'redirect'; status: number; location: string } | { kind: 'fail'; status: number; data: { invalidToken?: boolean } };
	/** Raw D1 meta per statement, per batch the action sent: [upsert, sessions, reset row]. */
	batches: { changes: number; rowsWritten: number }[][];
	hashChanged: boolean;
	storedHashPresent: boolean;
	newPasswordWorks: boolean;
	oldPasswordWorks: boolean;
	sessions: string[];
	resetRowPresent: boolean;
	cookieCleared: boolean;
}

let mf: Miniflare;
let workerOrigin: string;

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [path.join(repoRoot, 'tests/integration/worker-fixtures/reset-worker.ts')],
		bundle: true,
		write: false,
		format: 'esm',
		conditions: ['workerd', 'worker', 'browser'],
		platform: 'browser',
		target: 'es2022',
		// $app/environment is a SvelteKit virtual module; $lib comes from
		// tsconfig paths, which esbuild doesn't read. Same stub vitest uses
		// (dev=false, matching a prod build).
		alias: {
			'$app/environment': path.join(repoRoot, 'vitest-stubs/app-environment.ts'),
			$lib: path.join(repoRoot, 'src/lib')
		}
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		// Matches wrangler.toml.example.
		compatibilityDate: '2025-04-01',
		
		d1Databases: ['DB']
	});
	workerOrigin = String(await mf.ready);

	// Apply the real drizzle migrations, in order, one statement at a time.
	const db = await mf.getD1Database('DB');
	const dir = path.join(repoRoot, 'drizzle');
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		const statements = readFileSync(path.join(dir, file), 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
		await db.batch(statements.map((s) => db.prepare(s)));
	}
}, 120_000);

afterAll(async () => {
	await mf?.dispose();
});

async function scenario(name: string): Promise<Verdict> {
	const url = new URL('/', workerOrigin);
	url.searchParams.set('scenario', name);
	const res = await fetch(url);
	const text = await res.text();
	if (!res.ok) throw new Error(`worker failed: ${res.status} ${text}`);
	return JSON.parse(text);
}

describe('password reset write under real D1', () => {
	it('upserts over the existing password hash, revokes sessions, and consumes the link', async () => {
		const v = await scenario('valid');

		expect(v.outcome).toEqual({ kind: 'redirect', status: 303, location: '/admin/login?reset=1' });
		expect(v.batches).toHaveLength(1);
		const [upsert, sessionDelete, resetDelete] = v.batches[0];
		// ON CONFLICT DO UPDATE over the existing adminPasswordHash row: D1 must
		// report it as a change, or the action reads it as a revoked link.
		expect(upsert.changes).toBeGreaterThanOrEqual(1);
		expect(sessionDelete.changes).toBe(2);
		expect(resetDelete.changes).toBe(1);
		expect(v.hashChanged).toBe(true);
		expect(v.newPasswordWorks).toBe(true);
		expect(v.oldPasswordWorks).toBe(false);
		expect(v.sessions).toEqual([]);
		expect(v.resetRowPresent).toBe(false);
		expect(v.cookieCleared).toBe(true);
	});

	it('inserts the password hash when none is stored yet', async () => {
		const v = await scenario('valid-no-existing-hash');

		expect(v.outcome).toEqual({ kind: 'redirect', status: 303, location: '/admin/login?reset=1' });
		expect(v.batches[0][0].changes).toBe(1);
		expect(v.storedHashPresent).toBe(true);
		expect(v.newPasswordWorks).toBe(true);
		expect(v.sessions).toEqual([]);
		expect(v.resetRowPresent).toBe(false);
	});

	it('writes nothing when the reset row is rebound just before the batch', async () => {
		const v = await scenario('revoked-before-batch');

		expect(v.outcome).toMatchObject({ kind: 'fail', status: 400, data: { invalidToken: true } });
		expect(v.batches).toHaveLength(1);
		const [upsert, sessionDelete] = v.batches[0];
		expect(upsert.changes).toBe(0);
		expect(sessionDelete.changes).toBe(0);
		expect(v.hashChanged).toBe(false);
		expect(v.oldPasswordWorks).toBe(true);
		expect(v.newPasswordWorks).toBe(false);
		expect(v.sessions).toEqual(['sess-a', 'sess-b']);
		expect(v.cookieCleared).toBe(false);
	});

	it('writes nothing when the reset row is removed just before the batch', async () => {
		const v = await scenario('removed-before-batch');

		expect(v.outcome).toMatchObject({ kind: 'fail', status: 400, data: { invalidToken: true } });
		const [upsert, sessionDelete] = v.batches[0];
		expect(upsert.changes).toBe(0);
		expect(sessionDelete.changes).toBe(0);
		expect(v.hashChanged).toBe(false);
		expect(v.oldPasswordWorks).toBe(true);
		expect(v.sessions).toEqual(['sess-a', 'sess-b']);
		expect(v.resetRowPresent).toBe(false);
	});
});
