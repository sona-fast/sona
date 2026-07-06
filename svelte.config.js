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
				// server against a throwaway local D1 in an isolated persist dir.
				configPath: process.env.WRANGLER_CONFIG ?? 'wrangler.toml',
				persist: process.env.WRANGLER_PERSIST_TO
					? { path: process.env.WRANGLER_PERSIST_TO }
					: undefined
			}
		})
	}
};

export default config;
