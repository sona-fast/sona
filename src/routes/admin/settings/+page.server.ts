import { dev } from '$app/environment';
import { fail } from '@sveltejs/kit';
import { UTApi } from 'uploadthing/server';
import { getDb } from '$lib/server/db';
import {
	getSettings,
	saveSettings,
	getRawSetting,
	setRawSetting,
	clearSettingsCache,
	parseSonaColors
} from '$lib/server/settings';
import { deleteOrphansAll, collectReferencedUrls } from '$lib/server/storage';
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
import { MAX_SONA_COLORS, dedupePalette } from '$lib/palette-merge';
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
import { resolveRefImage, refImageSource } from '$lib/server/ref-image';
import { isObservabilityEnabled } from '$lib/server/metrics';
import { isValidThemeId, DEFAULT_THEME_ID } from '$lib/themes';
import { LANDING_LAYOUTS, DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import { isValidGallerySort, DEFAULT_GALLERY_SORT, type GallerySort } from '$lib/gallery';
import type { Actions, PageServerLoad } from './$types';

const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);
	// The editor must render current persisted values, not a cached snapshot.
	const settings = await getSettings(db, { fresh: true });

	// Ref-sheet color picker: resolve the sheet (same precedence as /art) and
	// pre-compute how the client can draw it on a canvas without tainting it.
	// null = no sheet yet; the palette editor shows a designate-one hint instead.
	const refImage = await resolveRefImage(db);
	const refImageSrc = refImage
		? refImageSource(refImage, { origin: url.origin, r2PublicUrl: settings.r2PublicUrl, dev })
		: null;

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
	// Raw setting (never part of the client-exposed SiteSettings) — surfaced only
	// to the admin Security form so the recovery address can be edited.
	const adminEmail = (await getRawSetting(db, 'adminEmail')) ?? '';
	return {
		settings,
		refImageSrc,
		adminEmail,
		imageCount: stats?.count || 0,
		totalSize: stats?.totalSize || 0,
		utUsage,
		storageStatus,
		registryEnabled: isRegistryEnabled(renv),
		registryHasSecret: !!platform?.env?.REGISTRY_API_KEY,
		// Presence-only flags for the password-reset setup guide. The secret VALUES
		// are deploy-time env and must never reach the client — only whether they exist.
		resendKeySet: !!platform?.env?.RESEND_API_KEY,
		resendFromSet: !!platform?.env?.RESEND_FROM,
		// Presence-only flag for the Observability tab's Cloudflare edge entry (issue
		// #6). All three secrets are needed for the edge panel; the values never
		// reach the client — only whether the connection is complete.
		cfAnalyticsConnected: !!(
			platform?.env?.CF_ANALYTICS_TOKEN &&
			platform?.env?.CF_ACCOUNT_ID &&
			platform?.env?.CF_ZONE_ID
		),
		// Opt-in gate (issue #6): hides the Observability settings tab + section when off.
		observabilityEnabled: isObservabilityEnabled(platform?.env)
	};
};

export const actions = {
	// One save per tab: each action persists ONLY its tab's fields (saveSettings
	// writes just the keys it's given), so saving one tab can never clobber
	// another tab's pending edits.
	saveSite: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		// A field ABSENT from the POST means "this form doesn't manage that
		// setting" — skip it (saveSettings only writes provided keys). A field
		// PRESENT but blank is a deliberate clear. Without this split, saves from
		// forms that conditionally render fields (splash subtitle, the sona sheet,
		// theme pickers) silently blank whatever they don't render (#60).
		const text = (key: string, max: number) =>
			data.has(key) ? sanitizeText(data.get(key) as string, max) : undefined;
		const social = (platformKey: Parameters<typeof normalizeSocialUrl>[0], key: string) =>
			data.has(key) ? normalizeSocialUrl(platformKey, data.get(key) as string) : undefined;

		// The avatar re-resolves only when this form carries the bluesky field;
		// clearing bluesky clears the derived avatar with it (paired on purpose).
		let blueskyUrl: string | undefined;
		let adminAvatarUrl: string | undefined;
		if (data.has('bluesky')) {
			blueskyUrl = normalizeSocialUrl('bluesky', data.get('bluesky') as string);
			adminAvatarUrl = blueskyUrl ? ((await resolveAvatarUrl({ blueskyUrl })) ?? '') : '';
		}

		let themeId: string | undefined;
		if (data.has('themeId')) {
			const themeRaw = (data.get('themeId') as string) ?? '';
			themeId = isValidThemeId(themeRaw) ? themeRaw : DEFAULT_THEME_ID;
		}
		let landingLayout: string | undefined;
		if (data.has('landingLayout')) {
			const layoutRaw = (data.get('landingLayout') as string) ?? '';
			landingLayout = LANDING_LAYOUTS.some((l) => l.id === layoutRaw)
				? layoutRaw
				: DEFAULT_LANDING_LAYOUT;
		}
		let galleryDefaultSort: GallerySort | undefined;
		if (data.has('galleryDefaultSort')) {
			const sortRaw = (data.get('galleryDefaultSort') as string) ?? '';
			galleryDefaultSort = isValidGallerySort(sortRaw) ? sortRaw : DEFAULT_GALLERY_SORT;
		}

		await saveSettings(db, {
			siteName: text('siteName', 100),
			ownerName: text('ownerName', 100),
			aboutText: text('aboutText', 2000),
			primaryCharacter: text('primaryCharacter', 100),
			twitterUrl: social('twitter', 'twitter'),
			blueskyUrl,
			telegramUrl: social('telegram', 'telegram'),
			furAffinityUrl: social('furaffinity', 'furaffinity'),
			furtrackUrl: social('furtrack', 'furtrack'),
			adminAvatarUrl,
			themeId,
			landingLayout,
			galleryDefaultSort,
			splashSubtitle: text('splashSubtitle', 100),
			// Three-path profile fields — feed the /art, /connect and /share pages.
			contactEmail: text('contactEmail', 200),
			sonaSpecies: text('sonaSpecies', 200),
			sonaBuild: text('sonaBuild', 200),
			sonaKeyFeatures: text('sonaKeyFeatures', 500),
			// Re-parse + re-serialize the swatch JSON so only well-formed { name, hex }
			// survive, deduped by hex, then clamped to the palette cap (the UI
			// enforces both too).
			sonaColors: data.has('sonaColors')
				? JSON.stringify(
						dedupePalette(
							parseSonaColors((data.get('sonaColors') as string) || '[]').filter((c) =>
								/^#[0-9a-fA-F]{3,8}$/.test(c.hex)
							)
						).slice(0, MAX_SONA_COLORS)
					)
				: undefined,
			sonaDos: text('sonaDos', 1000),
			sonaDonts: text('sonaDonts', 1000)
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
		let r2PublicUrl = sanitizeUrl(data.get('r2PublicUrl') as string) || '';
		// The public base must be an ORIGIN only. Orphan cleanup derives storage
		// keys from URL pathnames, so a path-bearing base (https://example.com/cdn)
		// would yield keys like 'cdn/artwork/x.png' that never match stored keys —
		// every referenced object would be judged an orphan on the next sweep.
		// Reject loudly rather than silently stripping the path, so an admin
		// fronting the bucket through a sub-path proxy learns it isn't supported.
		// (R2 custom domains are origin-only anyway.)
		if (r2PublicUrl) {
			let origin = '';
			try {
				const u = new URL(r2PublicUrl);
				if (u.pathname === '/' && !u.search && !u.hash) origin = u.origin;
			} catch {
				// not an absolute URL (e.g. a root-relative path) — rejected below
			}
			if (!origin) {
				return fail(400, {
					error: 'R2 public URL must be an origin only, like https://cdn.example.com — no path, query, or fragment.'
				});
			}
			r2PublicUrl = origin;
		}

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

	connectRegistry: async ({ request, platform, url }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		// A deploy-time secret already connects the fork; nothing to do here.
		if (env?.REGISTRY_API_KEY) {
			return fail(400, {
				error: 'A REGISTRY_API_KEY secret is already configured at deploy time.'
			});
		}
		// Already holding a fork key: connecting again would mint a brand-new key on
		// the registry that we can't revoke (there's no self-revocation endpoint),
		// leaving an orphan. Refuse — disconnect first to rotate.
		if (await getRawSetting(db, REGISTRY_API_KEY_SETTING)) {
			return fail(400, {
				alreadyConnected: true,
				error: 'Already connected — disconnect first to rotate the key.'
			});
		}
		const data = await request.formData();
		const signupToken = sanitizeText(data.get('signupToken') as string, 200);
		const registryUrl = sanitizeUrl(data.get('registryUrl') as string) || '';
		// Label the fork key so the registry maintainer can tell keys apart (a NULL
		// label makes registry-side hygiene guesswork). Prefer an explicit form
		// value, else the configured site name, else this site's hostname.
		const siteName = (await getRawSetting(db, 'siteName'))?.trim();
		const label =
			sanitizeText(data.get('label') as string, 200) || siteName || url.hostname;
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

	saveSecurityEmail: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		// adminEmail is a raw site_settings row, never mapped into SiteSettings.
		// Writing an empty value clears the recovery address (disables email reset).
		const adminEmail = sanitizeText(data.get('adminEmail') as string, 200);
		await setRawSetting(db, 'adminEmail', adminEmail);
		return { recoveryEmailSaved: true };
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
			// The reference set is EVERY URL-bearing column in the schema plus the
			// URL-ish settings — not just images.imageUrl. Anything missed there
			// (sticker files, thumbnails, avatars, covers) would be deleted as an
			// "orphan". See collectReferencedUrls + its completeness guard test.
			const referenced = await collectReferencedUrls(db, settings);
			// Remove orphans from every configured provider (R2 + UploadThing), but
			// only objects older than an hour: /api/upload stores bytes before any
			// D1 row exists, so an upload racing this button would look orphaned.
			// The button's purpose is stale junk, not just-uploaded bytes.
			const { deleted, errors } = await deleteOrphansAll(platform?.env, settings, referenced, {
				olderThan: new Date(Date.now() - 60 * 60 * 1000)
			});
			// A configured provider failing mid-cleanup used to be swallowed as
			// "not configured" — surface it so the admin isn't told success.
			if (errors.length) {
				return fail(500, { error: `Failed to clear cache: ${errors.join('; ')}` });
			}
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
		// Deliberately fail-soft: don't fail the wipe if storage cleanup errors
		// (deleteOrphansAll reports provider errors instead of throwing).
		const filesDeleted = (await deleteOrphansAll(platform?.env, settings, [])).deleted;

		return {
			success: true,
			message: `Deleted ${imageCount} images, ${filesDeleted} stored files, and all metadata.`
		};
	}
} satisfies Actions;
