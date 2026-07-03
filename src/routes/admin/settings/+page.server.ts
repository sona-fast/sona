import { dev } from '$app/environment';
import { fail } from '@sveltejs/kit';
import { UTApi } from 'uploadthing/server';
import { getDb } from '$lib/server/db';
import {
	getSettings,
	saveSettings,
	setRawSetting,
	clearSettingsCache
} from '$lib/server/settings';
import { deleteOrphansAll } from '$lib/server/storage';
import {
	images,
	artists,
	collections,
	tags,
	imageTags,
	characters,
	imageCharacters,
	sessions,
	siteSettings
} from '$lib/server/db/schema';
import { sql, inArray } from 'drizzle-orm';
import { SESSION_COOKIE } from '$lib/config';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { verifyAdminPassword, hashPassword, hashToken } from '$lib/server/admin-auth';
import {
	isRegistryEnabled,
	resolveRegistryEnv,
	registryRegisterFork,
	REGISTRY_API_KEY_SETTING,
	REGISTRY_URL_SETTING
} from '$lib/server/registry';
import { syncArtists } from '$lib/server/artist-sync';
import { isValidThemeId, DEFAULT_THEME_ID } from '$lib/themes';
import { LANDING_LAYOUTS, DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import type { Actions, PageServerLoad } from './$types';

const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	// The editor must render current persisted values, not a cached snapshot.
	const settings = await getSettings(db, { fresh: true });

	const stats = await db
		.select({
			count: sql<number>`COUNT(*)`,
			totalSize: sql<number>`COALESCE(SUM(file_size), 0)`
		})
		.from(images)
		.get();

	// Live UploadThing usage — authoritative, includes files not tracked in D1
	// (e.g. orphans from failed uploads, legacy imports).
	let utUsage: { usedBytes: number; limitBytes: number; filesUploaded: number } | null = null;
	const token = platform?.env.UPLOADTHING_TOKEN;
	if (token) {
		try {
			const utapi = new UTApi({ token });
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const info = await Promise.race([
				(utapi as unknown as {
					getUsageInfo(): Promise<{
						appTotalBytes: number;
						totalBytes: number;
						limitBytes: number;
						filesUploaded: number;
					}>;
				}).getUsageInfo(),
				new Promise<never>((_, reject) => {
					controller.signal.addEventListener('abort', () => reject(new Error('UT timeout')));
				})
			]);
			clearTimeout(timeout);
			utUsage = {
				usedBytes: info.appTotalBytes,
				limitBytes: info.limitBytes,
				filesUploaded: info.filesUploaded
			};
		} catch {
			// UT API slow or down — fall through and show the SQL total only.
		}
	}

	// Whether each provider's deploy-time config is present (secrets/bindings live
	// in env, never in settings). utUsage succeeding also proves the UT token works.
	const storageStatus = {
		uploadthing: !!platform?.env.UPLOADTHING_TOKEN,
		uploadthingVerified: !!utUsage,
		r2: !!platform?.env.IMAGES
	};

	// Registry can be connected either by a deploy-time secret OR an in-app
	// (D1-stored) fork key — resolve both. registryHasSecret tells the UI to hide
	// the connect/disconnect controls (a secret can't be managed from here).
	const renv = await resolveRegistryEnv(db, platform?.env);
	return {
		settings,
		imageCount: stats?.count || 0,
		totalSize: stats?.totalSize || 0,
		utUsage,
		storageStatus,
		registryEnabled: isRegistryEnabled(renv),
		registryHasSecret: !!platform?.env?.REGISTRY_API_KEY
	};
};

export const actions = {
	// One save per tab: each action persists ONLY its tab's fields (saveSettings
	// writes just the keys it's given), so saving one tab can never clobber
	// another tab's pending edits.
	saveSite: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const blueskyUrl = normalizeSocialUrl('bluesky', data.get('bluesky') as string);
		const adminAvatarUrl = blueskyUrl
			? (await resolveAvatarUrl({ blueskyUrl })) ?? ''
			: '';

		const themeRaw = (data.get('themeId') as string) ?? '';
		const themeId = isValidThemeId(themeRaw) ? themeRaw : DEFAULT_THEME_ID;
		const layoutRaw = (data.get('landingLayout') as string) ?? '';
		const landingLayout = LANDING_LAYOUTS.some((l) => l.id === layoutRaw)
			? layoutRaw
			: DEFAULT_LANDING_LAYOUT;

		await saveSettings(db, {
			siteName: sanitizeText(data.get('siteName') as string, 100),
			ownerName: sanitizeText(data.get('ownerName') as string, 100),
			aboutText: sanitizeText(data.get('aboutText') as string, 2000),
			primaryCharacter: sanitizeText(data.get('primaryCharacter') as string, 100),
			twitterUrl: normalizeSocialUrl('twitter', data.get('twitter') as string),
			blueskyUrl,
			telegramUrl: normalizeSocialUrl('telegram', data.get('telegram') as string),
			furAffinityUrl: normalizeSocialUrl('furaffinity', data.get('furaffinity') as string),
			furtrackUrl: normalizeSocialUrl('furtrack', data.get('furtrack') as string),
			adminAvatarUrl,
			themeId,
			landingLayout
		});

		return { success: true };
	},

	saveConnections: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		await saveSettings(db, {
			// Unchecked checkboxes don't post a field, so absence means false.
			autoResyncEnabled: data.get('autoResyncEnabled') === 'on',
			registryOverridesLocal: data.get('registryOverridesLocal') === 'on'
		});

		return { success: true };
	},

	saveStorage: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const provider = data.get('storageProvider') === 'r2' ? 'r2' : 'uploadthing';
		const r2PublicUrl = sanitizeUrl(data.get('r2PublicUrl') as string) || '';

		await saveSettings(db, { storageProvider: provider, r2PublicUrl });

		return {
			success: true,
			message: `Active storage provider set to ${provider === 'r2' ? 'Cloudflare R2' : 'UploadThing'}. New uploads will use it; existing images are unaffected until migrated.`
		};
	},

	syncNow: async ({ platform }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		const renv = await resolveRegistryEnv(db, env);
		if (!isRegistryEnabled(renv)) return fail(400, { error: 'Shared registry is not configured.' });
		const settings = await getSettings(db, { fresh: true });
		const summary = await syncArtists(db, renv, settings);
		return {
			success: true,
			syncMessage: `Sync complete — ${summary.refreshed} refreshed, ${summary.linked} newly linked.`
		};
	},

	connectRegistry: async ({ request, platform }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		// A deploy-time secret already connects the fork; nothing to do here.
		if (env?.REGISTRY_API_KEY) {
			return fail(400, {
				error: 'A REGISTRY_API_KEY secret is already configured at deploy time.'
			});
		}
		const data = await request.formData();
		const signupToken = sanitizeText(data.get('signupToken') as string, 200);
		const registryUrl = sanitizeUrl(data.get('registryUrl') as string) || '';
		const label = sanitizeText(data.get('label') as string, 200) || undefined;
		if (!signupToken) return fail(400, { error: 'An invite token is required to connect.' });

		const result = await registryRegisterFork({
			url: registryUrl || undefined,
			signupToken,
			label
		});
		if ('error' in result) return fail(400, { error: `Could not connect: ${result.error}.` });

		// Store the one-time fork key (and any custom URL) in D1 so the connection
		// survives without a deploy. The key never goes back to the client.
		await setRawSetting(db, REGISTRY_API_KEY_SETTING, result.key);
		await setRawSetting(db, REGISTRY_URL_SETTING, registryUrl);
		clearSettingsCache();
		return { success: true, registryMessage: 'Connected to the shared registry.' };
	},

	disconnectRegistry: async ({ platform }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		await setRawSetting(db, REGISTRY_API_KEY_SETTING, '');
		await setRawSetting(db, REGISTRY_URL_SETTING, '');
		clearSettingsCache();
		return { success: true, registryMessage: 'Disconnected from the shared registry.' };
	},

	changePassword: async ({ request, platform, cookies }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		// Form fields can arrive as File entries; coerce non-strings to '' so a File
		// can't slip past the length check (a File's .length is undefined).
		const asStr = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');
		const current = asStr(data.get('currentPassword'));
		const next = asStr(data.get('newPassword'));
		const confirm = asStr(data.get('confirmPassword'));

		if (next.length < 8) {
			return fail(400, { error: 'New password must be at least 8 characters.' });
		}
		if (next !== confirm) {
			return fail(400, { error: 'New passwords do not match.' });
		}
		if (!(await verifyAdminPassword(db, platform?.env, current))) {
			return fail(401, { error: 'Current password is incorrect.' });
		}
		// D1 has no interactive transactions; db.batch() is atomic (all-or-nothing).
		// Store the new password hash AND rotate sessions in one batch, so a partial
		// failure can't leave the new credential set with old sessions still valid.
		// Revoking ALL sessions defeats any stolen token (including the current one);
		// the fresh row below keeps the admin who just changed it signed in.
		// ('adminPasswordHash' is the same site_settings key admin-auth reads.)
		const passwordHash = await hashPassword(next);
		const token = crypto.randomUUID();
		const tokenHash = await hashToken(token);
		const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();
		await db.batch([
			db
				.insert(siteSettings)
				.values({ key: 'adminPasswordHash', value: passwordHash })
				.onConflictDoUpdate({ target: siteSettings.key, set: { value: passwordHash } }),
			db.delete(sessions),
			db.insert(sessions).values({ token: tokenHash, expiresAt })
		]);
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			secure: !dev,
			sameSite: 'lax',
			maxAge: SESSION_DURATION
		});
		return { passwordChanged: true };
	},

	export: async ({ platform }) => {
		const db = getDb(platform!.env.DB);

		const [allImages, allArtists, allCollections, allTags, allCharacters, allImageTags, allImageCharacters, settings] =
			await Promise.all([
				db.select().from(images),
				db.select().from(artists),
				db.select().from(collections),
				db.select().from(tags),
				db.select().from(characters),
				db.select().from(imageTags),
				db.select().from(imageCharacters),
				getSettings(db)
			]);

		const backup = {
			version: 1,
			exportedAt: new Date().toISOString(),
			settings,
			images: allImages,
			artists: allArtists,
			collections: allCollections,
			tags: allTags,
			characters: allCharacters,
			imageTags: allImageTags,
			imageCharacters: allImageCharacters
		};

		return { success: true, export: JSON.stringify(backup, null, 2) };
	},

	resetTags: async ({ platform }) => {
		const db = getDb(platform!.env.DB);
		await db.delete(imageTags);
		await db.delete(tags);
		return { success: true, message: 'All tags removed.' };
	},

	clearCache: async ({ platform }) => {
		// Dev shares the live UploadThing token; "orphans" in a dev DB may still be
		// referenced by prod, so only allow this from production.
		if (dev) {
			return fail(400, {
				error: 'Clear cache is disabled in dev — it would delete from the live UploadThing account that production uses.'
			});
		}

		const db = getDb(platform!.env.DB);

		try {
			const settings = await getSettings(db);
			const dbUrls = (await db.select({ imageUrl: images.imageUrl }).from(images)).map((i) => i.imageUrl);
			// Remove orphans from every configured provider (R2 + UploadThing).
			const deleted = await deleteOrphansAll(platform?.env, settings, dbUrls);
			return {
				success: true,
				message: deleted === 0 ? 'No orphaned files found.' : `Deleted ${deleted} orphaned file${deleted === 1 ? '' : 's'}.`
			};
		} catch (e) {
			return fail(500, { error: `Failed to clear cache: ${e instanceof Error ? e.message : 'unknown error'}` });
		}
	},

	deleteAll: async ({ platform }) => {
		// Shares the live UploadThing token in dev — refuse there.
		if (dev) {
			return fail(400, {
				error: 'Delete all is disabled in dev — it would wipe the live UploadThing account that production uses.'
			});
		}

		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const imageCount = (await db.select({ imageUrl: images.imageUrl }).from(images)).length;

		// Delete from D1
		await db.delete(imageTags);
		await db.delete(imageCharacters);
		await db.delete(images);
		await db.delete(tags);
		await db.delete(characters);
		await db.delete(collections);
		await db.delete(artists);

		// With no DB rows left, every stored object is an orphan — wipe both stores.
		let filesDeleted = 0;
		try {
			filesDeleted = await deleteOrphansAll(platform?.env, settings, []);
		} catch {
			// Don't fail the wipe if storage cleanup errors.
		}

		return {
			success: true,
			message: `Deleted ${imageCount} images, ${filesDeleted} stored files, and all metadata.`
		};
	}
} satisfies Actions;
