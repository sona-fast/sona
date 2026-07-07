import { describe, it, expect } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { load } from './+page.server';

// The opt-in gate (issue #6) redirects the dashboard away BEFORE touching the DB,
// so no D1 shim is needed — an env with the flag unset/off must bounce to /admin.
async function redirectFor(env: Record<string, string>): Promise<{ status: number; location: string } | null> {
	try {
		await (load as (arg: unknown) => Promise<unknown>)({ platform: { env } });
		return null;
	} catch (e) {
		if (isRedirect(e)) return { status: e.status, location: e.location };
		throw e;
	}
}

describe('observability load — opt-in gate (issue #6)', () => {
	it('redirects to /admin when the flag is unset/off', async () => {
		expect(await redirectFor({})).toEqual({ status: 302, location: '/admin' });
		expect(await redirectFor({ OBSERVABILITY_ENABLED: 'off' })).toEqual({ status: 302, location: '/admin' });
	});
});
