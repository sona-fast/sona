import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { hashPassword } from '$lib/server/admin-auth';
import { validateResetToken, PASSWORD_RESET_SETTING } from '$lib/server/password-reset';
import { siteSettings, sessions } from '$lib/server/db/schema';
import { RESET_TOKEN_COOKIE } from '$lib/config';
import type { Actions, PageServerLoad } from './$types';

const MIN_PASSWORD_LENGTH = 8;
// Comfortably covers the click-through from the email without extending
// exposure past the token's own 30-minute TTL (see password-reset.ts).
const RESET_COOKIE_MAX_AGE_S = 10 * 60;

export const load: PageServerLoad = async ({ platform, url, cookies }) => {
	const queryToken = url.searchParams.get('token');
	if (queryToken) {
		// The raw token would otherwise sit in the URL — browser history, proxy/CDN
		// access logs — for the rest of its TTL. Move it into a short-lived, scoped
		// cookie instead and redirect to the clean URL; the form action below reads
		// it back from there.
		cookies.set(RESET_TOKEN_COOKIE, queryToken, {
			path: '/admin/reset',
			httpOnly: true,
			secure: !dev,
			// Lax, not Strict: webmail wraps the reset link (Gmail routes it through
			// google.com/url), so following it is cross-site — a Strict cookie is
			// withheld on the GET→303→clean-URL redirect and the admin is silently
			// locked out. Lax IS sent on the top-level 303 but still not on a
			// cross-site POST, so the form action's CSRF posture is unchanged (and
			// this matches the session cookie in admin/login).
			sameSite: 'lax',
			maxAge: RESET_COOKIE_MAX_AGE_S
		});
		redirect(303, '/admin/reset');
	}
	const token = cookies.get(RESET_TOKEN_COOKIE) ?? '';
	const valid = await validateResetToken(getDb(platform!.env.DB), token);
	return { valid };
};

export const actions = {
	default: async ({ request, platform, cookies }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		// Coerce non-strings (a File entry has no usable .length) to ''.
		const asStr = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
		const token = cookies.get(RESET_TOKEN_COOKIE) ?? '';
		const password = asStr(data.get('password'));
		const confirm = asStr(data.get('confirmPassword'));

		// Re-validate on submit — the token may have expired since the page loaded.
		if (!(await validateResetToken(db, token))) {
			return fail(400, { invalidToken: true, error: 'This reset link is invalid or has expired.' });
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
		}
		if (password !== confirm) {
			return fail(400, { error: 'Passwords do not match.' });
		}

		// One atomic batch (D1 has no interactive transactions): set the new hash,
		// revoke EVERY admin session, and consume the reset token. A partial failure
		// can't leave the new password set with stale sessions, or the token reusable.
		const passwordHash = await hashPassword(password);
		await db.batch([
			db
				.insert(siteSettings)
				.values({ key: 'adminPasswordHash', value: passwordHash })
				.onConflictDoUpdate({ target: siteSettings.key, set: { value: passwordHash } }),
			db.delete(sessions),
			db.delete(siteSettings).where(eq(siteSettings.key, PASSWORD_RESET_SETTING))
		]);

		cookies.delete(RESET_TOKEN_COOKIE, { path: '/admin/reset' });
		// No auto-login — send them to sign in with the new password.
		redirect(303, '/admin/login?reset=1');
	}
} satisfies Actions;
