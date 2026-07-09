import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordMetric = vi.fn();
vi.mock('$lib/server/metrics', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, recordMetric: (...a: unknown[]) => recordMetric(...a) };
});
vi.mock('$lib/server/db', () => ({ getDb: () => ({}) }));

import { POST } from './+server';

const ORIGIN = 'https://example.test';
const url = new URL(`${ORIGIN}/api/metrics/download`);

function call(opts: { origin?: string | null; enabled?: boolean; db?: boolean } = {}) {
	const headers = new Headers();
	if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
	const env = {
		...(opts.db === false ? {} : { DB: {} }),
		OBSERVABILITY_ENABLED: opts.enabled === false ? 'false' : 'true'
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return POST({ request: new Request(url, { method: 'POST', headers }), url, platform: { env } } as any);
}

beforeEach(() => recordMetric.mockReset());

describe('POST /api/metrics/download — open write endpoint, kept boring', () => {
	it('counts a same-origin press', async () => {
		const res = await call();
		expect(res.status).toBe(204);
		expect(recordMetric).toHaveBeenCalledTimes(1);
		// The aggregate download counter — db handle plus the 'download' metric.
		expect(recordMetric).toHaveBeenCalledWith(expect.anything(), 'download');
	});

	it('refuses a cross-origin press so another site cannot drive the counter', async () => {
		const res = await call({ origin: 'https://evil.test' });
		expect(res.status).toBe(403);
		expect(recordMetric).not.toHaveBeenCalled();
	});

	it('refuses a request with no Origin header at all', async () => {
		const res = await call({ origin: null });
		expect(res.status).toBe(403);
		expect(recordMetric).not.toHaveBeenCalled();
	});

	it('is a no-op when observability is off — no DB write on forks that opted out', async () => {
		const res = await call({ enabled: false });
		expect(res.status).toBe(204);
		expect(recordMetric).not.toHaveBeenCalled();
	});

	it('never lets a DB failure break the visitor download', async () => {
		recordMetric.mockRejectedValueOnce(new Error('d1 down'));
		const res = await call();
		expect(res.status).toBe(204);
	});
});
