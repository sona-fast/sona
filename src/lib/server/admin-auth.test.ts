import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { makeD1 } from './test/d1';
import {
	hashPassword,
	verifyPasswordHash,
	constantTimeEqual,
	loginThrottleCheck,
	loginThrottleFailure,
	loginThrottleReset,
	getSetupState,
	__resetSetupCache
} from './admin-auth';

describe('password hashing (PBKDF2)', () => {
	it('verifies a correct password', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(await verifyPasswordHash('correct horse battery staple', hash)).toBe(true);
	});

	it('rejects a wrong password', async () => {
		const hash = await hashPassword('s3cret-pw');
		expect(await verifyPasswordHash('s3cret-pX', hash)).toBe(false);
	});

	it('produces a salted, prefixed encoding (different each call)', async () => {
		const a = await hashPassword('same');
		const b = await hashPassword('same');
		expect(a).toMatch(/^pbkdf2\$sha256\$\d+\$[^$]+\$[^$]+$/);
		expect(a).not.toBe(b); // random salt
		// both still verify
		expect(await verifyPasswordHash('same', a)).toBe(true);
		expect(await verifyPasswordHash('same', b)).toBe(true);
	});

	it('keeps iterations within the Cloudflare Workers PBKDF2 cap (≤100k)', async () => {
		// Workers' Web Crypto throws (NotSupportedError) above 100k iterations, so a
		// higher count passes in Node/CI but 500s every hash in production.
		const iterations = Number((await hashPassword('pw')).split('$')[2]);
		expect(iterations).toBeGreaterThan(0);
		expect(iterations).toBeLessThanOrEqual(100_000);
	});

	it('rejects malformed stored hashes', async () => {
		expect(await verifyPasswordHash('x', 'not-a-hash')).toBe(false);
		expect(await verifyPasswordHash('x', 'pbkdf2$sha256$abc$salt$hash')).toBe(false);
		expect(await verifyPasswordHash('x', '')).toBe(false);
	});
});

describe('constantTimeEqual', () => {
	it('matches equal strings and rejects others (incl. length diffs)', () => {
		expect(constantTimeEqual('abc', 'abc')).toBe(true);
		expect(constantTimeEqual('abc', 'abd')).toBe(false);
		expect(constantTimeEqual('abc', 'abcd')).toBe(false);
		expect(constantTimeEqual('', '')).toBe(true);
	});
});

describe('login throttle', () => {
	it('locks after the failure threshold and recovers on reset', () => {
		const ip = 'test-ip-1';
		const t0 = 1_000_000;
		expect(loginThrottleCheck(ip, t0)).toBeNull();
		for (let i = 0; i < 5; i++) loginThrottleFailure(ip, t0);
		expect(loginThrottleCheck(ip, t0)).not.toBeNull(); // locked
		loginThrottleReset(ip);
		expect(loginThrottleCheck(ip, t0)).toBeNull(); // cleared
	});

	it('expires the window over time', () => {
		const ip = 'test-ip-2';
		const t0 = 2_000_000;
		for (let i = 0; i < 5; i++) loginThrottleFailure(ip, t0);
		expect(loginThrottleCheck(ip, t0)).not.toBeNull();
		// 16 minutes later (> 15 min window)
		expect(loginThrottleCheck(ip, t0 + 16 * 60 * 1000)).toBeNull();
	});
});

// SONA-186. The distinction these tests protect: a read that FAILED is not a
// read that found nothing. Collapsing the two is what redirected a whole live
// site to /admin/setup during a D1 blip.
describe('getSetupState', () => {
	// setupCompleteCache is module-level and latches permanently, and vitest
	// isolates per FILE, not per test — without this reset the cases below run
	// against a latch set by whichever test happened to go first, and pass while
	// asserting nothing.
	beforeEach(() => {
		__resetSetupCache();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function db(setup?: (sqlite: { exec(sql: string): void }) => void) {
		const sqlite = new Database(':memory:');
		setup?.(sqlite);
		return drizzle(makeD1(sqlite), { schema });
	}

	function configured() {
		return db((s) => {
			s.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
			s.exec(`INSERT INTO site_settings (key, value) VALUES ('adminPasswordHash', 'x');`);
		});
	}

	const empty = () =>
		db((s) => s.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`));

	// No site_settings table at all — the read throws inside drizzle, which is
	// how a D1 outage presents to this code.
	const broken = () => db();

	it('reports complete when a password hash is stored', async () => {
		expect(await getSetupState(configured(), undefined)).toBe('complete');
	});

	it('reports complete on the explicit setupComplete flag', async () => {
		const d = db((s) => {
			s.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
			s.exec(`INSERT INTO site_settings (key, value) VALUES ('setupComplete', 'true');`);
		});
		expect(await getSetupState(d, undefined)).toBe('complete');
	});

	it('reports complete on the legacy ADMIN_PASSWORD env without reading the DB', async () => {
		expect(await getSetupState(broken(), { ADMIN_PASSWORD: 'legacy' } as never)).toBe('complete');
	});

	it('reports incomplete when the read SUCCEEDS and finds nothing', async () => {
		expect(await getSetupState(empty(), undefined)).toBe('incomplete');
	});

	it('reports unknown when the read FAILS — not incomplete', async () => {
		expect(await getSetupState(broken(), undefined)).toBe('unknown');
	});

	it('warns on unknown, since a degraded site logs nothing else', async () => {
		await getSetupState(broken(), undefined);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('setup-state read failed'),
			expect.anything()
		);
	});

	// The warn is throttled per isolate so a sustained outage can't drown the log
	// budget — but the READ must still happen every time, or the site would stop
	// self-healing the moment it went quiet.
	it('throttles the warn without throttling the read', async () => {
		expect(await getSetupState(broken(), undefined)).toBe('unknown');
		expect(await getSetupState(broken(), undefined)).toBe('unknown');
		expect(await getSetupState(broken(), undefined)).toBe('unknown');

		expect(console.warn).toHaveBeenCalledTimes(1);
		// Still recovers immediately once the DB answers.
		expect(await getSetupState(empty(), undefined)).toBe('incomplete');
	});

	it('never caches unknown — the site recovers on the first read that works', async () => {
		expect(await getSetupState(broken(), undefined)).toBe('unknown');
		expect(await getSetupState(empty(), undefined)).toBe('incomplete');
		expect(await getSetupState(configured(), undefined)).toBe('complete');
	});

	it('caches complete, so a later broken read still answers complete', async () => {
		expect(await getSetupState(configured(), undefined)).toBe('complete');
		expect(await getSetupState(broken(), undefined)).toBe('complete');
	});
});
