import { eq, inArray } from 'drizzle-orm';
import { siteSettings } from './db/schema';
import { APP_NAME } from '$lib/config';
import { DEFAULT_GALLERY_SORT, isValidGallerySort, type GallerySort } from '$lib/gallery';
import { resolveSupporterKeyStatus, type SupporterKeyStatus } from './supporter-key';
import type { Database } from './db';

export type StorageProviderId = 'uploadthing' | 'r2';

export interface SiteSettings {
	siteName: string;
	/** The site owner's / persona's display name (e.g. shown on the About page).
	 * Empty falls back to `siteName` at the point of use. */
	ownerName: string;
	aboutText: string;
	/** Contact email shown on /share for larger photo batches. */
	contactEmail: string;
	/** Canonical https origin (no trailing slash) used to build links in outgoing
	 * emails (e.g. the password-reset link), so an alias/preview host hitting the
	 * form doesn't mail a link to itself. Empty → the request origin is used. */
	siteUrl: string;
	/** Locale for automated emails (e.g. password resets). One of the site's
	 * available locales; empty/invalid → the base locale. */
	emailLanguage: string;
	/** Owner-editable override for the /privacy page body (plain text). Empty →
	 * the code-accurate default policy from `$lib/legal` is shown instead. */
	privacyPolicy: string;
	/** Owner-editable override for the /terms page body (plain text). Empty →
	 * the default terms from `$lib/legal` are shown instead. */
	termsOfService: string;
	/** Date (YYYY-MM-DD) the /privacy override text was last changed, stamped when
	 * that page's override is saved. Drives its "Last updated" line when an
	 * override is set. Empty → the page shows the built-in defaults' date instead. */
	privacyUpdatedAt: string;
	/** Date (YYYY-MM-DD) the /terms override text was last changed, stamped when
	 * that page's override is saved. Drives its "Last updated" line when an
	 * override is set. Empty → the page shows the built-in defaults' date instead. */
	termsUpdatedAt: string;
	/** Whether the /ai disclosure page (and its footer link) is served. Stored
	 * as 'true'/'false'; ABSENT MEANS ON (SONA-167).
	 *
	 * The polarity is a deliberate operator decision, not an oversight. Every
	 * site that is already live keeps the page on, and the Settings toggle is
	 * how an owner turns it off; the marketing site carries a platform-level
	 * version of the same disclosure (SONA-178), so the software's use of AI is
	 * explained for every fork whether or not that fork publishes its own page.
	 *
	 * New installs do not rely on the default: the setup wizard writes the row
	 * explicitly from its affirmation checkbox, so the first-person claims in
	 * the default copy are owner-affirmed there. One path skips that — a fork
	 * bootstrapped with the ADMIN_PASSWORD env var counts as setup-complete
	 * (see isSetupComplete) and never runs the wizard, so it lands on the
	 * absent default like a pre-existing install. Both cases are covered by the
	 * SONA-167 section in UPDATING.md, which names the claims the page makes in
	 * the owner's voice and where to turn it off. */
	aiPageEnabled: boolean;
	/** Owner-editable override for the /ai page body (plain text). Empty → the
	 * default disclosure copy from `$lib/ai-disclosure` is shown instead.
	 * Server-only beyond /ai itself: it is absent from the public allowlist
	 * below, so no public payload carries it, and /ai's own load returns it. */
	aiPageText: string;
	/** Date (YYYY-MM-DD) the /ai override text was last changed, stamped when
	 * that page's override is saved. Drives its "Last updated" line when an
	 * override is set. Empty → no line (the default copy shows none). */
	aiPageUpdatedAt: string;

	// --- Sona / reference profile (shown on /art, part of the threePath landing) ---
	// The reference sheet itself is the most recent published gallery image
	// tagged "reference" — not stored here (see /art load).
	sonaSpecies: string;
	sonaBuild: string;
	sonaKeyFeatures: string;
	/** JSON array of { name, hex } color swatches. */
	sonaColors: string;
	/** Newline-separated "do" items (what artists are encouraged to do). */
	sonaDos: string;
	/** Newline-separated "don't" items. */
	sonaDonts: string;

	twitterUrl: string;
	blueskyUrl: string;
	telegramUrl: string;
	furAffinityUrl: string;
	instagramUrl: string;
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
	/** Subtitle under the wordmark on the threePath splash. Empty falls back to
	 * the localized default (m.splash_subtitle) at the point of use. */
	splashSubtitle: string;
	/** When on, the registry sync overwrites locally-edited artist fields (name,
	 * avatar, socials) for registry-linked artists. Off (default) keeps local
	 * edits and only fills empty fields. */
	registryOverridesLocal: boolean;
	/** Default gallery sort when a request carries no ?sort= param. One of the
	 * four gallery sort keys; an explicit param still wins. */
	galleryDefaultSort: GallerySort;
}

export interface SonaColor {
	name: string;
	hex: string;
}

/** Parse the stored sonaColors JSON into a typed array, tolerating bad data. */
export function parseSonaColors(raw: string): SonaColor[] {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((c) => c && typeof c.hex === 'string')
			.map((c) => ({ name: String(c.name ?? ''), hex: String(c.hex) }));
	} catch {
		return [];
	}
}

/** Split a newline-separated list setting into trimmed, non-empty lines. */
export function parseLines(raw: string): string[] {
	return raw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * The settings that may ride a public page's client payload.
 *
 * An allowlist, not a denylist: a field added to `SiteSettings` stays
 * server-only until it is named here, so nothing reaches every visitor by
 * default. settings.classification.test.ts fails when a key is in neither this
 * list nor SERVER_ONLY_SETTINGS_KEYS, which forces the call at review time.
 */
export const PUBLIC_SETTINGS_KEYS = [
	'siteName',
	'ownerName',
	'aboutText',
	'contactEmail',
	'siteUrl',
	'emailLanguage',
	'privacyPolicy',
	'termsOfService',
	'privacyUpdatedAt',
	'termsUpdatedAt',
	'aiPageEnabled',
	'aiPageUpdatedAt',
	'sonaSpecies',
	'sonaBuild',
	'sonaKeyFeatures',
	'sonaColors',
	'sonaDos',
	'sonaDonts',
	'twitterUrl',
	'blueskyUrl',
	'telegramUrl',
	'furAffinityUrl',
	'instagramUrl',
	'furtrackUrl',
	'adminAvatarUrl',
	'primaryCharacter',
	'storageProvider',
	'r2PublicUrl',
	'autoResyncEnabled',
	'themeId',
	'landingLayout',
	'splashSubtitle',
	'registryOverridesLocal',
	'galleryDefaultSort'
] as const satisfies readonly (keyof SiteSettings)[];

/**
 * Settings deliberately withheld from public payloads. Naming a key here is
 * what lets the classification test pass without publishing it.
 *
 * `aiPageText`: the (public) layout load rides every public page, so shipping
 * the override there would keep publishing a fork's /ai copy after the owner
 * turned the page off. /ai's own load returns it, behind that route's 404 gate.
 */
export const SERVER_ONLY_SETTINGS_KEYS = [
	'aiPageText'
] as const satisfies readonly (keyof SiteSettings)[];

/** The settings shape public pages receive — exactly PUBLIC_SETTINGS_KEYS. */
export type PublicSiteSettings = Pick<SiteSettings, (typeof PUBLIC_SETTINGS_KEYS)[number]>;

/**
 * Narrow full settings to the public allowlist. Every public load returns
 * settings through this helper, so a new one cannot forget the narrowing.
 *
 * The input is a fully-populated `SiteSettings` (what getSettings and
 * settingsFallback return): every allowlisted key is emitted, so a partial
 * object would yield those keys with undefined values rather than absent.
 */
export function toPublicSettings(settings: SiteSettings): PublicSiteSettings {
	return Object.fromEntries(
		PUBLIC_SETTINGS_KEYS.map((key) => [key, settings[key]])
	) as PublicSiteSettings;
}

// Neutral, brand-agnostic defaults. A real deployment overrides these via the
// first-run setup wizard / admin Settings (stored as site_settings rows); the
// example sparky.ink config seeds its own values. Keep these generic so a fresh
// fork starts unbranded rather than impersonating another site.
//
// Exported because the compiler forces this literal to carry every
// `SiteSettings` key, which makes it the runtime inventory of the interface —
// what the classification test checks the public/server-only lists against.
export const DEFAULTS: SiteSettings = {
	siteName: APP_NAME,
	ownerName: '',
	aboutText: 'A personal gallery for collecting and showcasing furry artwork from talented artists.',
	// The three-path pages (/art, /connect, /share) render gracefully with these
	// empty — sections that have no data simply don't show.
	contactEmail: '',
	// Empty → outgoing-email links use the request origin; emails render in baseLocale.
	siteUrl: '',
	emailLanguage: '',
	// Empty → /privacy and /terms render the code-accurate defaults from $lib/legal.
	privacyPolicy: '',
	termsOfService: '',
	// Empty → the legal pages show the built-in defaults' date (LEGAL_DEFAULTS_UPDATED).
	privacyUpdatedAt: '',
	termsUpdatedAt: '',
	// The /ai disclosure page defaults ON fleet-wide; '' override → the default
	// copy from $lib/ai-disclosure.
	aiPageEnabled: true,
	aiPageText: '',
	aiPageUpdatedAt: '',
	sonaSpecies: '',
	sonaBuild: '',
	sonaKeyFeatures: '',
	sonaColors: '[]',
	sonaDos: '',
	sonaDonts: '',
	twitterUrl: '',
	blueskyUrl: '',
	telegramUrl: '',
	furAffinityUrl: '',
	instagramUrl: '',
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
	// Empty → the splash renders the localized default subtitle.
	splashSubtitle: '',
	registryOverridesLocal: false,
	galleryDefaultSort: DEFAULT_GALLERY_SORT
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
			contactEmail: map.contactEmail ?? DEFAULTS.contactEmail,
			siteUrl: map.siteUrl ?? DEFAULTS.siteUrl,
			emailLanguage: map.emailLanguage ?? DEFAULTS.emailLanguage,
			privacyPolicy: map.privacyPolicy ?? DEFAULTS.privacyPolicy,
			termsOfService: map.termsOfService ?? DEFAULTS.termsOfService,
			privacyUpdatedAt: map.privacyUpdatedAt ?? DEFAULTS.privacyUpdatedAt,
			termsUpdatedAt: map.termsUpdatedAt ?? DEFAULTS.termsUpdatedAt,
			// Default-ON boolean: only an explicit stored 'false' turns the /ai
			// page off (unlike the default-off toggles below, which require 'true').
			aiPageEnabled: map.aiPageEnabled !== 'false',
			aiPageText: map.aiPageText ?? DEFAULTS.aiPageText,
			aiPageUpdatedAt: map.aiPageUpdatedAt ?? DEFAULTS.aiPageUpdatedAt,
			sonaSpecies: map.sonaSpecies ?? DEFAULTS.sonaSpecies,
			sonaBuild: map.sonaBuild ?? DEFAULTS.sonaBuild,
			sonaKeyFeatures: map.sonaKeyFeatures ?? DEFAULTS.sonaKeyFeatures,
			sonaColors: map.sonaColors ?? DEFAULTS.sonaColors,
			sonaDos: map.sonaDos ?? DEFAULTS.sonaDos,
			sonaDonts: map.sonaDonts ?? DEFAULTS.sonaDonts,
			twitterUrl: map.twitterUrl ?? DEFAULTS.twitterUrl,
			blueskyUrl: map.blueskyUrl ?? DEFAULTS.blueskyUrl,
			telegramUrl: map.telegramUrl ?? DEFAULTS.telegramUrl,
			furAffinityUrl: map.furAffinityUrl ?? DEFAULTS.furAffinityUrl,
			instagramUrl: map.instagramUrl ?? DEFAULTS.instagramUrl,
			furtrackUrl: map.furtrackUrl ?? DEFAULTS.furtrackUrl,
			adminAvatarUrl: map.adminAvatarUrl ?? DEFAULTS.adminAvatarUrl,
			primaryCharacter: map.primaryCharacter ?? DEFAULTS.primaryCharacter,
			storageProvider:
				map.storageProvider === 'r2' || map.storageProvider === 'uploadthing'
					? map.storageProvider
					: DEFAULTS.storageProvider,
			r2PublicUrl: map.r2PublicUrl ?? DEFAULTS.r2PublicUrl,
			// Booleans are persisted as the text 'true'/'false'; absent → default.
			autoResyncEnabled: map.autoResyncEnabled === 'true',
			themeId: map.themeId ?? DEFAULTS.themeId,
			landingLayout: map.landingLayout ?? DEFAULTS.landingLayout,
			splashSubtitle: map.splashSubtitle ?? DEFAULTS.splashSubtitle,
			registryOverridesLocal: map.registryOverridesLocal === 'true',
			galleryDefaultSort: isValidGallerySort(map.galleryDefaultSort ?? '')
				? (map.galleryDefaultSort as GallerySort)
				: DEFAULTS.galleryDefaultSort
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

/**
 * Read several raw rows in ONE query. Like getRawSetting this bypasses the
 * settings cache and lets D1 errors propagate, which is what callers that must
 * fail closed need — they just should not pay a round-trip per key to get it.
 */
export async function getRawSettings(
	db: Database,
	keys: string[]
): Promise<Record<string, string | null>> {
	const rows = await db.select().from(siteSettings).where(inArray(siteSettings.key, keys));
	const found = Object.fromEntries(rows.map((r) => [r.key, r.value]));
	return Object.fromEntries(keys.map((k) => [k, found[k] ?? null]));
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

// Resolved supporter-key status, memoized per isolate next to the settings cache
// above (SONA-118). The admin layout load runs this on every authenticated admin
// page request; uncached it costs a D1 read of the `supporterKey` row plus an
// Ed25519 verify each time.
//
// The entry is keyed on the UTC day the status was resolved for, because that is
// what `daysRemaining` is a function of: `exp` is end-of-day UTC, so the
// countdown holds steady all day and ticks over at midnight UTC. Keying on the
// caller's `now` (rather than only on the wall clock) also keeps a caller that
// passes an explicit date from reading a status resolved for another day.
//
// SETTINGS_TTL_MS bounds a different staleness: the key row can be written by
// another isolate, whose `clearSupporterKeyStatusCache` this isolate never sees.
// Without the TTL an operator who saved or removed a key could keep seeing the
// old expiry notice here until midnight UTC.
let supporterKeyStatusCache:
	| { day: string; value: SupporterKeyStatus | null; expires: number }
	| null = null;

export function clearSupporterKeyStatusCache() {
	supporterKeyStatusCache = null;
}

/** The UTC calendar day (YYYY-MM-DD) a status was resolved for. */
function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Read and verify the stored supporter key, memoized as described above.
 *
 * D1 errors propagate (like `getRawSetting`, which this wraps) and are not
 * cached, so a caller that must fail closed still can and a transient failure
 * doesn't stick. The admin layout catches them to degrade just its notice; the
 * settings page deliberately does NOT use this — it reads and verifies loudly
 * on every request so a D1 error there can never render as "no key".
 */
export async function getSupporterKeyStatus(
	db: Database,
	now: Date
): Promise<SupporterKeyStatus | null> {
	const day = utcDay(now);
	const cached = supporterKeyStatusCache;
	if (cached && cached.day === day && cached.expires > Date.now()) {
		return cached.value;
	}
	const token = await getRawSetting(db, 'supporterKey');
	const value = await resolveSupporterKeyStatus(token ?? '', now);
	supporterKeyStatusCache = { day, value, expires: Date.now() + SETTINGS_TTL_MS };
	return value;
}

export async function saveSettings(db: Database, settings: Partial<SiteSettings>) {
	for (const [key, rawValue] of Object.entries(settings)) {
		if (rawValue === undefined) continue;
		// The value column is TEXT — coerce non-strings (e.g. boolean toggles) to
		// their string form. No-op for the existing string settings.
		await setRawSetting(db, key, String(rawValue));
	}
	// Invalidate so subsequent reads in this isolate see the new values.
	clearSettingsCache();
}
