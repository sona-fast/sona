import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from './timeout';

// withTimeout is the resilience guard around D1 reads: it must return the real
// value when the read is fast, the fallback when it's slow OR failing, and it
// must never let a slow read block past the deadline.

afterEach(() => {
	vi.useRealTimers();
});

describe('withTimeout', () => {
	it('returns the resolved value when it settles before the timeout', async () => {
		const result = await withTimeout(Promise.resolve('real'), 1000, 'fallback');
		expect(result).toBe('real');
	});

	it('returns the fallback when the promise rejects', async () => {
		const result = await withTimeout(Promise.reject(new Error('D1 down')), 1000, 'fallback');
		expect(result).toBe('fallback');
	});

	it('returns the fallback when the promise outlives the timeout', async () => {
		vi.useFakeTimers();
		// A promise that never settles within the test.
		const never = new Promise<string>(() => {});
		const p = withTimeout(never, 5000, 'fallback');
		await vi.advanceTimersByTimeAsync(5000);
		expect(await p).toBe('fallback');
	});

	it('prefers the real value when it wins the race against a longer timeout', async () => {
		vi.useFakeTimers();
		const slowish = new Promise<string>((resolve) => setTimeout(() => resolve('real'), 100));
		const p = withTimeout(slowish, 5000, 'fallback');
		await vi.advanceTimersByTimeAsync(100);
		expect(await p).toBe('real');
	});
});
