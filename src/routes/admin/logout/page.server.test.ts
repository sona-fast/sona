import { describe, it, expect } from 'vitest';
import { load, actions } from './+page.server';
import { SESSION_COOKIE, VIEWER_TZ_COOKIE } from '$lib/config';

// Signing out has to clear everything the admin area planted, not just the
// session. The tz cookie (SONA-119) carries the operator's timezone — a coarse
// location hint — with a one-year max-age, so left behind it outlives the
// session it was collected for on a shared machine.

type Deletion = { name: string; path: string | undefined };

function cookieJar(deleted: Deletion[]) {
	return {
		get: () => undefined,
		delete: (name: string, opts?: { path?: string }) => deleted.push({ name, path: opts?.path })
	};
}

/** Both entry points end in a redirect, which SvelteKit throws. */
async function runLogout(run: (event: never) => unknown) {
	const deleted: Deletion[] = [];
	const event = { request: new Request('https://taro.surf/admin/logout'), platform: undefined, cookies: cookieJar(deleted) };
	await expect(run(event as never)).rejects.toMatchObject({ status: 302, location: '/admin/login' });
	return deleted;
}

describe('admin logout — cookies cleared', () => {
	it('clears the session and the tz cookie, each at the path it was written with', async () => {
		const deleted = await runLogout(load);

		// Paths matter: a delete at the wrong path silently leaves the cookie.
		expect(deleted).toEqual(
			expect.arrayContaining([
				{ name: SESSION_COOKIE, path: '/' },
				{ name: VIEWER_TZ_COOKIE, path: '/admin' }
			])
		);
	});

	it('clears the same cookies via the POST action, not just direct navigation', async () => {
		const deleted = await runLogout(actions.default);

		expect(deleted.map((d) => d.name)).toEqual(
			expect.arrayContaining([SESSION_COOKIE, VIEWER_TZ_COOKIE])
		);
	});
});
