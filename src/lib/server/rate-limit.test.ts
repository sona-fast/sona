import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
	it('allows up to max requests in a window, then blocks', () => {
		const rl = new RateLimiter(3, 1000);
		const now = 1000;
		expect(rl.check('ip', now)).toBe(true);
		expect(rl.check('ip', now)).toBe(true);
		expect(rl.check('ip', now)).toBe(true);
		expect(rl.check('ip', now)).toBe(false); // 4th over the cap of 3
	});

	it('resets after the window elapses', () => {
		const rl = new RateLimiter(1, 1000);
		expect(rl.check('ip', 0)).toBe(true);
		expect(rl.check('ip', 500)).toBe(false); // still in window
		expect(rl.check('ip', 1000)).toBe(true); // window elapsed
	});

	it('tracks keys independently', () => {
		const rl = new RateLimiter(1, 1000);
		expect(rl.check('a', 0)).toBe(true);
		expect(rl.check('b', 0)).toBe(true); // different key, own budget
		expect(rl.check('a', 0)).toBe(false);
	});

	it('evicts stale windows instead of growing unbounded', () => {
		const rl = new RateLimiter(5, 1000);
		expect(rl.check('a', 0)).toBe(true); // window for 'a' expires at 1000
		expect(rl.size).toBe(1);
		// A later check past 'a' window prunes it before recording the new key.
		expect(rl.check('b', 1500)).toBe(true);
		expect(rl.size).toBe(1); // 'a' evicted, only 'b' remains
	});
});
