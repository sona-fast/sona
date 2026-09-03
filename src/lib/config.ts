import { dev } from '$app/environment';

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
 * 64 MB: the buffered-upload cap. Comfortably above any real artwork/fursuit
 * photo or Telegram sticker — but with no memory headroom to spare: a single
 * buffered copy is already half the 128 MB isolate ceiling, and bufferStream's
 * assemble step briefly holds ~2x, which is why its remote-body callers pass
 * smaller explicit caps instead of this default. (Storage-wise, at 64 MB per
 * object ~160 max-size uploads fill the 10 GB R2 free tier.)
 * Lives here (client-safe) because the admin media picker pre-checks it before
 * sending a byte; the server side re-exports it as
 * $lib/server/storage/buffer's MAX_BUFFER_BYTES and enforces it for real.
 */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * `accept` string for the admin gallery upload picker, and the filter dropped
 * files are partitioned by. MIME types only, mirroring the server's
 * ALLOWED_IMAGE_TYPES (`$lib/server/storage`): /api/upload validates the
 * DECLARED type and reads an empty one as application/octet-stream, so accepting
 * a bare `.png` here would upload the whole file just to collect a 415.
 * Client-safe, and pinned to the server set by a test in config.test.ts — the
 * two drifting apart either refuses a file the server would store or uploads one
 * it will refuse.
 */
export const GALLERY_ACCEPT = 'image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif';

/**
 * `accept` string for the VR avatar form's media picker and drop zone: every
 * image the gallery takes, plus the one video type the showcase renders. Derived
 * from GALLERY_ACCEPT rather than spelled out again, so the two can't drift.
 */
export const VR_MEDIA_ACCEPT = `${GALLERY_ACCEPT},video/webm`;

/**
 * Admin session cookie name. Read in `hooks.server.ts` / `auth.ts` before any
 * DB access, so it must be a build-time constant rather than a setting.
 *
 * In production the `__Host-` prefix makes the browser enforce that the cookie
 * is Secure, `path=/`, and has NO `Domain` attribute (host-only) — so one host
 * can never receive another host's session (defense-in-depth for any future
 * subdomain-per-tenant deployment; harmless for single-host self-hosts, which
 * already set the cookie host-only). The prefix REQUIRES Secure, which we only
 * set when `!dev`, so dev keeps the bare name over plain-HTTP localhost.
 * Upgrading forces a one-time admin re-login (the old cookie name is dropped).
 */
export const SESSION_COOKIE = dev ? 'sona_admin_session' : '__Host-sona_admin_session';

/**
 * Cookie carrying the operator's IANA timezone, written by the admin layout and
 * read in hooks (SONA-119). Prefixed like every other cookie we own, so a fork
 * sharing a hostname with something else can't collide. Client-safe because the
 * writer is the browser; the reader is `locals.timeZone`.
 *
 * Not `__Host-` like the session: that prefix forbids a Path, and this one is
 * deliberately scoped to /admin so it never rides a public request.
 */
export const VIEWER_TZ_COOKIE = 'sona_tz';

/**
 * Cookie holding the visitor's dark/light *mode* preference. A cookie (not
 * localStorage) so the server can read it and emit the correct `data-theme` at
 * SSR — avoiding a flash of the wrong mode on first paint.
 */
export const THEME_MODE_COOKIE = 'sona-mode';

/**
 * Cookie that carries a /admin/reset token from the query string (see the
 * route's load) into the form POST, so the raw token doesn't sit in the URL —
 * browser history, proxy/CDN access logs — for its whole TTL.
 */
export const RESET_TOKEN_COOKIE = 'sona_reset_token';

/** localStorage key for the gallery grid/list view preference. */
export const GALLERY_VIEW_STORAGE_KEY = 'sona-gallery-view';

/** Base filename for the admin settings JSON backup export. */
export const BACKUP_FILENAME_BASE = 'sona-backup';

/**
 * Cloudflare R2's free-tier storage allowance, shown against the DB-tracked
 * usage total by the settings Storage tab and the admin VR storage line (R2
 * has no simple usage API). One constant so the two gauges can't drift.
 */
export const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * User-Agent sent on outbound third-party fetches (e.g. the FurTrack importer).
 * Identifies the software; FurTrack itself gates on Origin/Referer, not this.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; ${APP_NAME}/1.0; +https://sona.fast)`;

/**
 * Default base URL of the shared artist registry (sona-registry). Overridable
 * per-deployment with the REGISTRY_URL env var. Registry features are off unless
 * a REGISTRY_API_KEY secret is also set.
 */
export const REGISTRY_DEFAULT_URL = 'https://registry.sona.fast';
