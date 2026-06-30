import { eq } from 'drizzle-orm';
import { siteSettings } from './db/schema';
import type { Database } from './db';

export type StorageProviderId = 'uploadthing' | 'r2';

export interface SiteSettings {
	siteName: string;
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
}

const DEFAULTS: SiteSettings = {
	siteName: 'sparky.ink',
	aboutText: 'A personal gallery for collecting and showcasing furry artwork from talented artists.',
	twitterUrl: 'https://twitter.com/sparkyfen',
	blueskyUrl: 'https://bsky.app/profile/sparky.social',
	telegramUrl: 'https://t.me/sparkyfen',
	furAffinityUrl: 'https://www.furaffinity.net/user/sparkyyy',
	furtrackUrl: 'https://www.furtrack.com/user/sparkyfen',
	adminAvatarUrl: '',
	primaryCharacter: '',
	// Default to UploadThing so existing sites behave exactly as before until an
	// admin explicitly switches/migrates to R2.
	storageProvider: 'uploadthing',
	r2PublicUrl: 'https://cdn.sparky.ink',
	// Opt-in: the daily Telegram re-sync cron is a no-op until an admin enables it.
	autoResyncEnabled: false
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
			autoResyncEnabled: map.autoResyncEnabled === 'true'
		};
		settingsCache = { value, expires: Date.now() + SETTINGS_TTL_MS };
		return value;
	} catch {
		// Table may not exist yet during deployment — fall back to defaults.
		// Don't cache the failure so we retry on the next request.
		return { ...DEFAULTS };
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
