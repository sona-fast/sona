import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workerd-parity harness for the supporter-key expiry dates (SONA-119).
//
// The whole fix rests on Intl.DateTimeFormat accepting a named IANA zone
// server-side. Nothing else in this repo had ever asked the server for a named
// zone, and the rest of the suite cannot answer whether it works in production:
// the unit tests run in Node, and the e2e harness serves through `vite dev`,
// which is also Node. Workerd is a different runtime with its own ICU build, and
// a runtime that rejects the zone would not throw — viewerTimeZone catches and
// falls back to UTC, so every operator would silently keep seeing UTC dates and
// every existing test would stay green. That silence is what this pins.
//
// Same shape as storage-streaming.integration.test.ts: bundle the REAL module
// into a worker and run it under Miniflare's workerd.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// exp is end-of-day UTC, so the last covered instant is 2026-08-17T23:59:59Z —
// still the 17th in UTC, already the 18th anywhere east of it.
const EXP = Date.UTC(2026, 7, 18, 0, 0, 0);
const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

let mf: Miniflare;
let workerOrigin: string;

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [path.join(repoRoot, 'tests/integration/worker-fixtures/timezone-worker.ts')],
		bundle: true,
		write: false,
		format: 'esm',
		conditions: ['workerd', 'worker', 'browser'],
		platform: 'browser',
		target: 'es2022',
		// The module reaches $lib/index for formatDate; tsconfig paths don't apply
		// to esbuild.
		alias: { $lib: path.join(repoRoot, 'src/lib') }
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		// Matches wrangler.toml.example.
		compatibilityDate: '2025-04-01'
	});
	workerOrigin = String(await mf.ready);
}, 120_000);

afterAll(async () => {
	await mf?.dispose();
});

async function resolve(tz: string): Promise<{ zone: string; validUntil: string; daysRemaining: number }> {
	const url = new URL('/', workerOrigin);
	url.searchParams.set('tz', tz);
	url.searchParams.set('exp', String(EXP));
	url.searchParams.set('now', String(NOW));
	const res = await fetch(url);
	const text = await res.text();
	if (!res.ok) throw new Error(`worker failed: ${res.status} ${text}`);
	return JSON.parse(text);
}

describe('supporter-key expiry dates under real workerd', () => {
	it('honours a named IANA zone rather than silently falling back to UTC', async () => {
		const tokyo = await resolve('Asia/Tokyo');

		// The assertion that matters: if workerd's ICU rejected the zone name,
		// viewerTimeZone would have returned 'UTC' and the date would read
		// 2026.08.17 — green everywhere else, wrong in production.
		expect(tokyo.zone).toBe('Asia/Tokyo');
		expect(tokyo.validUntil).toBe('2026.08.18');
		expect(tokyo.daysRemaining).toBe(6);
	});

	it('reads a zone west of UTC in that zone too', async () => {
		const la = await resolve('America/Los_Angeles');

		expect(la.zone).toBe('America/Los_Angeles');
		expect(la.validUntil).toBe('2026.08.17');
		expect(la.daysRemaining).toBe(5);
	});

	it('agrees with UTC when the zone is UTC', async () => {
		const utc = await resolve('UTC');

		expect(utc.validUntil).toBe('2026.08.17');
		expect(utc.daysRemaining).toBe(5);
	});

	it('falls back to UTC on a zone workerd does not know, without throwing', async () => {
		// The cookie is attacker-suppliable, and an unguarded RangeError here would
		// take down the admin layout load on every admin page.
		const junk = await resolve('Not/AZone');

		expect(junk.zone).toBe('UTC');
		expect(junk.validUntil).toBe('2026.08.17');
	});
});
