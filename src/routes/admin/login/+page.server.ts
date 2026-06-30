import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import { verifyPassword } from '$lib/server/auth';
import { SESSION_COOKIE } from '$lib/config';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { lt } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.admin) {
		redirect(302, '/admin/images');
	}
};

export const actions = {
	default: async ({ request, platform, cookies }) => {
		const data = await request.formData();
		const password = data.get('password') as string;

		if (!password) {
			return fail(400, { error: 'Password is required' });
		}

		const adminPassword = platform?.env?.ADMIN_PASSWORD;
		if (!adminPassword || !verifyPassword(password, adminPassword)) {
			return fail(401, { error: 'Invalid password' });
		}

		const db = getDb(platform!.env.DB);
		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

		// Sweep expired sessions before issuing a new one.
		await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));

		// Store session in D1
		await db.insert(sessions).values({ token, expiresAt });

		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			secure: !dev,
			sameSite: 'lax',
			maxAge: SESSION_DURATION
		});

		redirect(302, '/admin/images');
	}
} satisfies Actions;
