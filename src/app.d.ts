// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			admin?: boolean;
			/**
			 * Set by handleError when it records a detailed 5xx error sample, so the
			 * request `handle` skips its generic fallback sample for the same 5xx and
			 * avoids a duplicate row in the error ring (see hooks.server.ts).
			 */
			errorSampled?: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB: D1Database;
				/**
				 * Legacy admin password (plaintext secret). Optional: new installs set
				 * the password through the first-run wizard, which stores a PBKDF2 hash
				 * in the DB (site_settings `adminPasswordHash`). When only this env is
				 * present, login accepts it once and auto-migrates to the hash.
				 */
				ADMIN_PASSWORD?: string;
				/**
				 * One-time bootstrap token for /admin/setup, set by the setup CLI
				 * (`wrangler pages secret put SETUP_TOKEN`). Required to run the
				 * first-run wizard in production; the route closes once setup completes.
				 */
				SETUP_TOKEN?: string;
				UPLOADTHING_TOKEN: string;
				/** Fursuit photos feature gate: 'off' (default) | 'mock' | 'live'. */
				FURTRACK_MODE?: string;
				/**
				 * Telegram Bot API token (from @BotFather). Gates the sticker
				 * importer: when unset, Telegram import is hidden and only manual
				 * upload works. Set via `wrangler secret put TELEGRAM_BOT_TOKEN`.
				 */
				TELEGRAM_BOT_TOKEN?: string;
				/**
				 * Shared secret for the machine-to-machine cron re-sync endpoint
				 * (POST /api/cron/resync-telegram), presented as
				 * `Authorization: Bearer <CRON_SECRET>`. Set via
				 * `wrangler pages secret put CRON_SECRET` — never committed. When unset
				 * the endpoint refuses (503) rather than running open.
				 */
				CRON_SECRET?: string;
				/** R2 bucket for self-hosted images (active when storageProvider = 'r2'). */
				IMAGES: R2Bucket;
				/**
				 * Shared artist registry (sona-registry). Base URL defaults to
				 * REGISTRY_DEFAULT_URL in config.ts; override here per deployment.
				 */
				REGISTRY_URL?: string;
				/**
				 * Per-fork API key for the registry's authenticated submit endpoints.
				 * When unset, registry features (search/pull/submit/sync) are disabled —
				 * the site runs entirely on its local artists table.
				 */
				REGISTRY_API_KEY?: string;
				/**
				 * Resend API key. Gates the admin "Forgot password" flow: when unset,
				 * /admin/forgot silently no-ops (still returns the generic response) and
				 * the only recovery path is the `npm run reset-password` CLI. Set via
				 * `wrangler pages secret put RESEND_API_KEY`.
				 */
				RESEND_API_KEY?: string;
				/**
				 * Sender identity for reset email, format `Name <addr@domain>`. Optional;
				 * defaults to `"<siteName>" <onboarding@resend.dev>` using the fork's own
				 * siteName. A custom domain must be verified in this fork's own Resend
				 * account first.
				 */
				RESEND_FROM?: string;
				/**
				 * Optional Cloudflare edge-analytics enrichment (issue #6, Observability).
				 * All three must be present for the "Cloudflare edge" panel to appear;
				 * absence just hides it. The token needs exactly one scope —
				 * Account · Account Analytics · Read (read-only, this account only). Set
				 * via `wrangler pages secret put CF_ANALYTICS_TOKEN` (+ CF_ACCOUNT_ID,
				 * CF_ZONE_ID). Zone analytics need a custom domain; a bare pages.dev has
				 * no zone. Never stored in the DB; disconnect by deleting the secret.
				 */
				CF_ANALYTICS_TOKEN?: string;
				CF_ACCOUNT_ID?: string;
				CF_ZONE_ID?: string;
			};
			/**
			 * Cloudflare execution context. `waitUntil` lets fire-and-forget work
			 * (e.g. the observability metric writes) outlive the response without
			 * adding latency to it. Optional so non-CF runtimes / tests still type.
			 */
			context?: {
				waitUntil(promise: Promise<unknown>): void;
			};
		}
	}
}

export {};
