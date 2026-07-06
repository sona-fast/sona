import { describe, it, expect, vi } from 'vitest';
import { POST } from './+server';

// The suite-wide `$app/environment` stub (vitest-stubs/app-environment.ts)
// reports dev:false; this file overrides it to dev:true to exercise the
// fail-closed dev guard. vi.mock applies module-wide, hence a separate file.
vi.mock('$app/environment', () => ({
	dev: true,
	browser: false,
	building: false,
	version: 'test'
}));

describe('POST /api/cron/cleanup-orphans (dev)', () => {
	it('fails closed with 400 in dev, before touching the DB or storage', async () => {
		// No DB/IMAGES in env on purpose: the guard must trip before either is used.
		const platform = { env: { CRON_SECRET: 'test-cron-secret' } } as unknown as App.Platform;
		const request = new Request('http://localhost/api/cron/cleanup-orphans', {
			method: 'POST',
			headers: { authorization: 'Bearer test-cron-secret' }
		});
		const url = new URL(request.url);
		await expect(POST({ request, url, platform } as never)).rejects.toMatchObject({
			status: 400
		});
	});
});
