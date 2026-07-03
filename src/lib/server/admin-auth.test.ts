import { describe, it, expect } from 'vitest';
import {
	hashPassword,
	verifyPasswordHash,
	constantTimeEqual,
	loginThrottleCheck,
	loginThrottleFailure,
	loginThrottleReset
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
