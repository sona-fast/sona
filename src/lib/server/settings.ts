import { eq } from 'drizzle-orm';
import { siteSettings } from './db/schema';
import { APP_NAME } from '$lib/config';
import type { Database } from './db';

export type StorageProviderId = 'uploadthing' | 'r2';

export interface SiteSettings {
	siteName: string;
	/** The site owner's / persona's display name (e.g. shown on the About page).
	 * Empty falls back to `siteName` at the point of use. */
	ownerName: string;
	aboutText: string;
	twitterUrl: string;
	blueskyUrl: string;
	telegramUrl: string;
	furAffinityUrl: string;
	furtrackUrl: string;
	adminAvatarUrl: string;
	/** The site's main character / FurTrack tag — who the site is for. Used to
	 * default the fursuit import and the gallery's fursuit view. */
	primaryCharacter: string;
	/** Active image store for the whole site (gallery + fursuit photos). */
	storageProvider: StorageProviderId;
	/** Public base URL for R2-served images (the bucket's custom domain). */
	r2PublicUrl: string;
	/** When on, the daily cron pulls new stickers into Telegram-sourced packs.
	 * Opt-in — defaults off so the scheduled job does nothing until enabled. */
	autoResyncEnabled: boolean;
	/** Active visual theme (palette family) id — see src/lib/themes. Applied at
	 * SSR via a data-theme-id attribute; orthogonal to the dark/light mode. */
	themeId: string;
	/** Landing-page layout id — see src/lib/landing (e.g. 'mosaic' | 'threePath'). */
	landingLayout: string;
	/** When on, the registry sync overwrites locally-edited artist fields (name,
	 * avatar, socials) for registry-linked artists. Off (default) keeps local
	 * edits and only fills empty fields. */
	registryOverridesLocal: boolean;
}

// Neutral, brand-agnostic defaults. A real deployment overrides these via the
// first-run setup wizard / admin Settings (stored as site_settings rows); the
// example sparky.ink config seeds its own values. Keep these generic so a fresh
// fork starts unbranded rather than impersonating another site.
const DEFAULTS: SiteSettings = {
	siteName: APP_NAME,
	ownerName: '',
	aboutText: 'A personal gallery for collecting and showcasing furry artwork from talented artists.',
	twitterUrl: '',
	blueskyUrl: '',
	telegramUrl: '',
	furAffinityUrl: '',
	furtrackUrl: '',
	adminAvatarUrl: '',
	primaryCharacter: '',
	// Default to UploadThing so existing sites behave exactly as before until an
	// admin explicitly switches/migrates to R2.
	storageProvider: 'uploadthing',
	r2PublicUrl: '',
	// Opt-in: the daily Telegram re-sync cron is a no-op until an admin enables it.
	autoResyncEnabled: false,
	themeId: 'default',
	landingLayout: 'mosaic',
	registryOverridesLocal: false
};

// Short-TTL in-memory cache. siteSettings is global (not per-user) and changes
// rarely, so caching it per-isolate removes a D1 round-trip from the hot path of
// every request. The cache is cleared immediately on save within the writing
// isolate; other isolates converge within SETTINGS_TTL_MS. Pass { fresh: true }
// to bypass it (e.g. the admin settings editor, which must show current values).
const SETTINGS_TTL_MS = 60_000;
let settingsCache: { value: SiteSettings; expires: number } | null = null;

export function clearSettingsCache() {
	settingsCache = null;
}

/**
 * Best-effort settings to fall back to when a live read is too slow (see
 * withTimeout). Prefers the last cached value so a brief D1 stall still renders
 * the real site name/links; only drops to hard defaults on a cold isolate.
 */
export function settingsFallback(): SiteSettings {
	return settingsCache ? settingsCache.value : { ...DEFAULTS };
}

export async function getSettings(
	db: Database,
	{ fresh = false }: { fresh?: boolean } = {}
): Promise<SiteSettings> {
	if (!fresh && settingsCache && settingsCache.expires > Date.now()) {
		return settingsCache.value;
	}
	try {
		const rows = await db.select().from(siteSettings);
		const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

		const value: SiteSettings = {
			siteName: map.siteName ?? DEFAULTS.siteName,
			ownerName: map.ownerName ?? DEFAULTS.ownerName,
			aboutText: map.aboutText ?? DEFAULTS.aboutText,
			twitterUrl: map.twitterUrl ?? DEFAULTS.twitterUrl,
			blueskyUrl: map.blueskyUrl ?? DEFAULTS.blueskyUrl,
			telegramUrl: map.telegramUrl ?? DEFAULTS.telegramUrl,
			furAffinityUrl: map.furAffinityUrl ?? DEFAULTS.furAffinityUrl,
			furtrackUrl: map.furtrackUrl ?? DEFAULTS.furtrackUrl,
			adminAvatarUrl: map.adminAvatarUrl ?? DEFAULTS.adminAvatarUrl,
			primaryCharacter: map.primaryCharacter ?? DEFAULTS.primaryCharacter,
			storageProvider: map.storageProvider === 'r2' ? 'r2' : DEFAULTS.storageProvider,
			r2PublicUrl: map.r2PublicUrl ?? DEFAULTS.r2PublicUrl,
			// Booleans are persisted as the text 'true'/'false'; absent → default.
			autoResyncEnabled: map.autoResyncEnabled === 'true',
			themeId: map.themeId ?? DEFAULTS.themeId,
			landingLayout: map.landingLayout ?? DEFAULTS.landingLayout,
			registryOverridesLocal: map.registryOverridesLocal === 'true'
		};
		settingsCache = { value, expires: Date.now() + SETTINGS_TTL_MS };
		return value;
	} catch {
		// Table may not exist yet during deployment — fall back to defaults.
		// Don't cache the failure so we retry on the next request.
		return { ...DEFAULTS };
	}
}

/** Read a single raw site_settings row (for internal keys not in SiteSettings,
 * e.g. the registry sync cursor). Returns null if absent. */
export async function getRawSetting(db: Database, key: string): Promise<string | null> {
	const row = await db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
	return row?.value ?? null;
}

/** Upsert a single raw site_settings row. */
export async function setRawSetting(db: Database, key: string, value: string): Promise<void> {
	const existing = await db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
	if (existing) {
		await db.update(siteSettings).set({ value }).where(eq(siteSettings.key, key));
	} else {
		await db.insert(siteSettings).values({ key, value });
	}
}

export async function saveSettings(db: Database, settings: Partial<SiteSettings>) {
	for (const [key, rawValue] of Object.entries(settings)) {
		if (rawValue === undefined) continue;
		// The value column is TEXT — coerce non-strings (e.g. boolean toggles) to
		// their string form. No-op for the existing string settings.
		const value = String(rawValue);
		const existing = await db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
		if (existing) {
			await db.update(siteSettings).set({ value }).where(eq(siteSettings.key, key));
		} else {
			await db.insert(siteSettings).values({ key, value });
		}
	}
	// Invalidate so subsequent reads in this isolate see the new values.
	clearSettingsCache();
}
