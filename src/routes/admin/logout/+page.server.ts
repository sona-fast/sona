import { redirect, type Cookies } from '@sveltejs/kit';
import { SESSION_COOKIE, VIEWER_TZ_COOKIE } from '$lib/config';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { hashToken } from '$lib/server/admin-auth';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

async function performLogout(request: Request, platform: App.Platform | undefined, cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE);

	if (token && platform?.env.DB) {
		try {
			const db = getDb(platform.env.DB);
			await db.delete(sessions).where(eq(sessions.token, await hashToken(token)));
		} catch {
			// Ignore if table doesn't exist
		}
	}

	cookies.delete(SESSION_COOKIE, { path: '/' });
	// The operator's timezone is a coarse location hint with a one-year max-age
	// (SONA-119). Nothing needs it once signed out, and on a shared machine it
	// would otherwise outlive the session it was collected for. Same path it was
	// written at, or the delete misses.
	cookies.delete(VIEWER_TZ_COOKIE, { path: '/admin' });
}

// Handle direct navigation to /admin/logout (GET) — log out and redirect.
export const load: PageServerLoad = async ({ request, platform, cookies }) => {
	await performLogout(request, platform, cookies);
	redirect(302, '/admin/login');
};

export const actions = {
	default: async ({ request, platform, cookies }) => {
		await performLogout(request, platform, cookies);
		redirect(302, '/admin/login');
	}
} satisfies Actions;
