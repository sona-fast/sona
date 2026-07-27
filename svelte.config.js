import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter({
			platformProxy: {
				// E2E tests override these (see playwright.config.ts) to run the dev
				// server against a throwaway local D1 in an isolated persist dir. The
				// SONA_E2E_ prefix keeps them from colliding with any real wrangler env.
				configPath: process.env.SONA_E2E_WRANGLER_CONFIG ?? 'wrangler.toml',
				persist: process.env.SONA_E2E_PERSIST_TO
					? { path: process.env.SONA_E2E_PERSIST_TO }
					: undefined
			}
		}),
		// Origin check is the real CSRF control for admin form POSTs (SameSite=Lax
		// alone is not enough). An empty trustedOrigins list is SvelteKit's strict
		// default (same-origin only), pinned explicitly so a later `['*']` — which
		// disables CSRF protection on every admin action — can't slip in silently.
		// (The deprecated `checkOrigin: true` expresses the same thing but warns on
		// every build and is slated for removal; trustedOrigins is its replacement.)
		csrf: { trustedOrigins: [] }
	}
};

export default config;
