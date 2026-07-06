import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import { lt } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { sessions, characters } from '$lib/server/db/schema';
import { saveSettings, getRawSetting, setRawSetting } from '$lib/server/settings';
import { sanitizeText } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import {
	isSetupComplete,
	setAdminPassword,
	markSetupComplete,
	constantTimeEqual,
	hashToken
} from '$lib/server/admin-auth';
import { isValidThemeId, DEFAULT_THEME_ID } from '$lib/themes';
import { LANDING_LAYOUTS, DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import { SESSION_COOKIE } from '$lib/config';
import type { Actions, PageServerLoad } from './$types';

const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days
const MIN_PASSWORD_LENGTH = 8;

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	// Already configured → the wizard is closed.
	if (await isSetupComplete(db, platform?.env)) {
		redirect(302, '/admin/login');
	}

	const hasToken = !!platform?.env.SETUP_TOKEN;
	return {
		// In production the bootstrap token is mandatory; if it's missing the deploy
		// can't be safely claimed, so we block rather than run an open wizard.
		tokenRequired: !dev && hasToken,
		setupBlocked: !dev && !hasToken
	};
};

export const actions = {
	default: async ({ request, platform, cookies }) => {
		const db = getDb(platform!.env.DB);
		const env = platform?.env;

		// Defense in depth: never run setup twice. Unlike the load (which fails
		// toward showing the wizard), the ACTION fails CLOSED — if we can't read the
		// setup state (e.g. a transient D1 error), refuse rather than risk a takeover
		// re-running setup on an already-configured site.
		let alreadyComplete: boolean;
		try {
			alreadyComplete =
				!!env?.ADMIN_PASSWORD ||
				(await getRawSetting(db, 'setupComplete')) === 'true' ||
				!!(await getRawSetting(db, 'adminPasswordHash'));
		} catch {
			return fail(503, { error: 'Could not verify setup state — try again shortly.' });
		}
		if (alreadyComplete) redirect(302, '/admin/login');

		const hasToken = !!platform?.env.SETUP_TOKEN;
		if (!dev && !hasToken) {
			return fail(503, {
				error:
					'SETUP_TOKEN is not configured. Set it with `wrangler pages secret put SETUP_TOKEN` (the setup CLI does this) and redeploy before running setup.'
			});
		}

		const data = await request.formData();

		// 1. Bootstrap token (required in production).
		if (!dev && hasToken) {
			const token = (data.get('setupToken') as string) ?? '';
			if (!constantTimeEqual(token, platform!.env.SETUP_TOKEN!)) {
				return fail(401, { error: 'Invalid setup token.' });
			}
		}

		// 2. Admin password.
		const password = (data.get('password') as string) ?? '';
		const confirm = (data.get('confirmPassword') as string) ?? '';
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
		}
		if (password !== confirm) {
			return fail(400, { error: 'Passwords do not match.' });
		}

		// 3. Branding + config.
		const siteName = sanitizeText(data.get('siteName') as string, 100);
		if (!siteName) {
			return fail(400, { error: 'Site name is required.' });
		}
		const fursonaName = sanitizeText(data.get('fursonaName') as string, 100);
		// An empty field means "no choice made" and takes the default; a present but
		// unrecognized value is a real error — silently substituting the default here
		// made a theme pick vanish without feedback (#34).
		const themeRaw = (data.get('themeId') as string) ?? '';
		if (themeRaw && !isValidThemeId(themeRaw)) {
			return fail(400, { error: `Unrecognized theme "${themeRaw}".` });
		}
		const themeId = themeRaw || DEFAULT_THEME_ID;
		const layoutRaw = (data.get('landingLayout') as string) ?? '';
		if (layoutRaw && !LANDING_LAYOUTS.some((l) => l.id === layoutRaw)) {
			return fail(400, { error: `Unrecognized landing layout "${layoutRaw}".` });
		}
		const landingLayout = layoutRaw || DEFAULT_LANDING_LAYOUT;

		// NB: storageProvider / r2PublicUrl are NOT set here — the setup CLI decides
		// the storage backend (it's the only thing that can create a bucket / set a
		// token). Switching later is a migration in Settings → Storage Provider.
		//
		// A BLANK optional wizard field means "no answer", not "clear it" — the
		// setup CLI may have already seeded these (e.g. primaryCharacter), and a
		// first-run wizard has nothing deliberate to clear. Only filled-in values
		// are saved (#60). siteName is required above; theme/layout default by
		// design when unchosen.
		const optional: Record<string, string> = {
			ownerName: sanitizeText(data.get('ownerName') as string, 100),
			aboutText: sanitizeText(data.get('aboutText') as string, 2000),
			twitterUrl: normalizeSocialUrl('twitter', data.get('twitter') as string),
			blueskyUrl: normalizeSocialUrl('bluesky', data.get('bluesky') as string),
			telegramUrl: normalizeSocialUrl('telegram', data.get('telegram') as string),
			furAffinityUrl: normalizeSocialUrl('furaffinity', data.get('furaffinity') as string),
			furtrackUrl: normalizeSocialUrl('furtrack', data.get('furtrack') as string),
			primaryCharacter: sanitizeText(data.get('primaryCharacter') as string, 100)
		};
		for (const key of Object.keys(optional)) if (!optional[key]) delete optional[key];

		await saveSettings(db, {
			siteName,
			themeId,
			landingLayout,
			...optional
		});

		// Optional admin recovery email (raw setting, never client-exposed). Only
		// persist when provided — an empty field leaves password recovery disabled
		// until it's set in Settings → Security.
		const adminEmail = sanitizeText(data.get('adminEmail') as string, 200);
		if (adminEmail) await setRawSetting(db, 'adminEmail', adminEmail);

		// 4. The fursona this site is about (stickers/fursuit resolve one character).
		//    Flag it is_owner so it's excluded from the public "Featured Characters"
		//    cast (which showcases guests / other characters), matching the
		//    sticker-import auto-create path. resolveSiteCharacterId still resolves it
		//    by the primaryCharacter name / first row, so stickers/fursuit/hero are
		//    unaffected — only its inclusion in the Featured cast changes.
		const characterName = fursonaName || siteName;
		const existing = await db.select({ id: characters.id }).from(characters).get();
		if (!existing) {
			await db.insert(characters).values({ name: characterName, isOwner: true });
		}

		// 5. Admin credential (hashed) + flip the gate.
		await setAdminPassword(db, password);
		await markSetupComplete(db);

		// 6. Log the operator straight in.
		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();
		await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
		await db.insert(sessions).values({ token: await hashToken(token), expiresAt });
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			secure: !dev,
			sameSite: 'lax',
			maxAge: SESSION_DURATION
		});

		redirect(303, '/admin');
	}
} satisfies Actions;
