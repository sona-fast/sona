import { redirect, type Cookies } from '@sveltejs/kit';
import { getSessionToken } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

async function performLogout(request: Request, platform: App.Platform | undefined, cookies: Cookies) {
	const token = getSessionToken(request.headers.get('cookie'));

	if (token && platform?.env.DB) {
		try {
			const db = getDb(platform.env.DB);
			await db.delete(sessions).where(eq(sessions.token, token));
		} catch {
			// Ignore if table doesn't exist
		}
	}

	cookies.delete('sparky_admin_session', { path: '/' });
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
