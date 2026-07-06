import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { hashPassword } from '$lib/server/admin-auth';
import { validateResetToken, PASSWORD_RESET_SETTING } from '$lib/server/password-reset';
import { siteSettings, sessions } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

const MIN_PASSWORD_LENGTH = 8;

export const load: PageServerLoad = async ({ platform, url }) => {
	const token = url.searchParams.get('token') ?? '';
	const valid = await validateResetToken(getDb(platform!.env.DB), token);
	// The token is the caller's own reset link — echoing it into the form is no
	// additional exposure, and lets the POST re-present it for a fresh check.
	return { valid, token };
};

export const actions = {
	default: async ({ request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		// Coerce non-strings (a File entry has no usable .length) to ''.
		const asStr = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
		const token = asStr(data.get('token')) || (url.searchParams.get('token') ?? '');
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

		// No auto-login — send them to sign in with the new password.
		redirect(303, '/admin/login?reset=1');
	}
} satisfies Actions;
