import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import {
	verifyAdminPassword,
	loginThrottleCheck,
	loginThrottleFailure,
	loginThrottleReset,
	hashToken
} from '$lib/server/admin-auth';
import { SESSION_COOKIE } from '$lib/config';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { verifyTurnstile } from '$lib/server/turnstile';
import { lt } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	if (locals.admin) {
		redirect(302, '/admin/images');
	}
	// The public Turnstile site key, when the fork has configured one — the page
	// renders the widget only when it's present. The secret stays server-side.
	return {
		resetSuccess: url.searchParams.get('reset') === '1',
		turnstileSitekey: platform?.env.TURNSTILE_SITEKEY ?? null
	};
};

export const actions = {
	default: async ({ request, platform, cookies, getClientAddress }) => {
		const data = await request.formData();
		const password = data.get('password') as string;

		if (!password) {
			return fail(400, { error: 'Password is required' });
		}

		// Best-effort brute-force throttle (per-isolate; see admin-auth.ts).
		const ip = getClientAddress();
		const now = Date.now();
		const wait = loginThrottleCheck(ip, now);
		if (wait !== null) {
			return fail(429, {
				error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`
			});
		}

		// Turnstile bot check — enforced ONLY when the fork has configured BOTH keys
		// (opt-in), matching the widget-render condition on the page (which needs the
		// sitekey). Gating on both avoids a half-config lockout: a fork that set only
		// the secret renders no widget, so enforcing would reject every login forever.
		// The decision is server-side and can't be flipped by client input. When
		// enforced, a missing/invalid token or a siteverify failure rejects the login
		// (fail closed), and it runs BEFORE the password verify so a bad token never
		// spends a PBKDF2 hash. Either key absent → skip entirely (throttle+password).
		if (platform?.env.TURNSTILE_SECRET && platform?.env.TURNSTILE_SITEKEY) {
			const token = (data.get('cf-turnstile-response') as string) || '';
			if (!(await verifyTurnstile(platform.env.TURNSTILE_SECRET, token, ip))) {
				return fail(403, { error: 'Verification failed. Please try again.' });
			}
		}

		const db = getDb(platform!.env.DB);
		if (!(await verifyAdminPassword(db, platform?.env, password))) {
			loginThrottleFailure(ip, now);
			return fail(401, { error: 'Invalid password' });
		}
		loginThrottleReset(ip);
		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

		// Sweep expired sessions before issuing a new one.
		await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));

		// Store the session HASH in D1; the cookie carries the raw token.
		await db.insert(sessions).values({ token: await hashToken(token), expiresAt });

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
