import { dev } from '$app/environment';
import { fail } from '@sveltejs/kit';
import { UTApi } from 'uploadthing/server';
import { getDb } from '$lib/server/db';
import { getSettings, saveSettings } from '$lib/server/settings';
import { deleteOrphansAll } from '$lib/server/storage';
import {
	images,
	artists,
	collections,
	tags,
	imageTags,
	characters,
	imageCharacters
} from '$lib/server/db/schema';
import { sql, inArray } from 'drizzle-orm';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { verifyAdminPassword, setAdminPassword } from '$lib/server/admin-auth';
import { isValidThemeId, DEFAULT_THEME_ID } from '$lib/themes';
import { LANDING_LAYOUTS, DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import type { Actions, PageServerLoad } from './$types';

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

	return {
		settings,
		imageCount: stats?.count || 0,
		totalSize: stats?.totalSize || 0,
		utUsage,
		storageStatus
	};
};

export const actions = {
	save: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const blueskyUrl = sanitizeUrl(data.get('bluesky') as string) || '';
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
			twitterUrl: sanitizeUrl(data.get('twitter') as string) || '',
			blueskyUrl,
			telegramUrl: sanitizeUrl(data.get('telegram') as string) || '',
			furAffinityUrl: sanitizeUrl(data.get('furaffinity') as string) || '',
			furtrackUrl: sanitizeUrl(data.get('furtrack') as string) || '',
			adminAvatarUrl,
			themeId,
			landingLayout,
			// Unchecked checkboxes don't post a field, so absence means false.
			autoResyncEnabled: data.get('autoResyncEnabled') === 'on'
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

	changePassword: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const current = (data.get('currentPassword') as string) ?? '';
		const next = (data.get('newPassword') as string) ?? '';
		const confirm = (data.get('confirmPassword') as string) ?? '';

		if (next.length < 8) {
			return fail(400, { error: 'New password must be at least 8 characters.' });
		}
		if (next !== confirm) {
			return fail(400, { error: 'New passwords do not match.' });
		}
		if (!(await verifyAdminPassword(db, platform?.env, current))) {
			return fail(401, { error: 'Current password is incorrect.' });
		}
		await setAdminPassword(db, next);
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
