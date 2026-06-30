// Build/deploy-time configuration constants.
//
// Unlike SiteSettings (runtime, CMS-editable, stored in D1 — see
// `src/lib/server/settings.ts`), these values are either baked into the
// deployment artifact or needed *before* the database is available (e.g. the
// session cookie name is read in hooks/auth before any DB query runs). A fork
// changes these by editing this file, not through the admin UI.

/**
 * Default brand / application name. The public-facing site identity is the
 * runtime `siteName` setting; this is only the generic fallback used before
 * settings have loaded (or when no DB is available).
 */
export const APP_NAME = 'Sona';

/**
 * Admin session cookie name. Read in `hooks.server.ts` / `auth.ts` before any
 * DB access, so it must be a build-time constant rather than a setting.
 */
export const SESSION_COOKIE = 'sona_admin_session';

/**
 * Cookie holding the visitor's dark/light *mode* preference. A cookie (not
 * localStorage) so the server can read it and emit the correct `data-theme` at
 * SSR — avoiding a flash of the wrong mode on first paint.
 */
export const THEME_MODE_COOKIE = 'sona-mode';

/** localStorage key for the gallery grid/list view preference. */
export const GALLERY_VIEW_STORAGE_KEY = 'sona-gallery-view';

/** Base filename for the admin settings JSON backup export. */
export const BACKUP_FILENAME_BASE = 'sona-backup';

/**
 * User-Agent sent on outbound third-party fetches (e.g. the FurTrack importer).
 * Identifies the software; FurTrack itself gates on Origin/Referer, not this.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; ${APP_NAME}/1.0; +https://sona.fast)`;
