import { describe, it, expect } from 'vitest';
import { load } from './+page.server';

// The /ai disclosure page's toggle gate (SONA-167). The rule the trust page
// itself claims — visibility decided in the server load, drafts/disabled
// content indistinguishable from nonexistent — must hold for the page too.

function loadWith(aiPageEnabled: boolean) {
	return load({
		parent: async () => ({ settings: { aiPageEnabled } })
	} as never);
}

describe('/ai load', () => {
	it('serves the page when the toggle is on (the fleet default)', async () => {
		await expect(loadWith(true)).resolves.toEqual({});
	});

	it('404s the route when a fork turned the page off', async () => {
		await expect(loadWith(false)).rejects.toMatchObject({ status: 404 });
	});
});
