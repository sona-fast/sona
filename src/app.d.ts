// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			admin?: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB: D1Database;
				ADMIN_PASSWORD: string;
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
			};
		}
	}
}

export {};
