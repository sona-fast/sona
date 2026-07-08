import { describe, it, expect } from 'vitest';
import { POST } from './+server';

const CRON_SECRET = 'test-cron-secret';

function postEvent(env: Record<string, unknown>, { secret = CRON_SECRET } = {}) {
	const url = new URL('http://localhost/api/cron/resync-telegram');
	const request = new Request(url, {
		method: 'POST',
		headers: secret ? { authorization: `Bearer ${secret}` } : {}
	});
	return { request, url, platform: { env } } as never;
}

describe('POST /api/cron/resync-telegram', () => {
	it('rejects requests without a valid cron secret', async () => {
		await expect(POST(postEvent({ CRON_SECRET }, { secret: '' }))).rejects.toMatchObject({
			status: 401
		});
		await expect(POST(postEvent({ CRON_SECRET }, { secret: 'wrong' }))).rejects.toMatchObject({
			status: 401
		});
	});

	// A fork can set CRON_SECRET for cron in general without opting into Telegram
	// sticker mirroring. With no bot token the scheduled run must be a graceful
	// no-op 200 (skipped) — NOT a 503 that leaves the workflow perpetually red.
	it('skips with 200 when Telegram is not configured (no bot token)', async () => {
		const res = await POST(postEvent({ CRON_SECRET }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skipped: true, reason: 'telegram not configured' });
	});
});
