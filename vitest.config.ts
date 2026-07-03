import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests are pure-TS unit tests (no Svelte components), so we skip the
// SvelteKit/Paraglide plugins from vite.config and keep this config minimal.
// We DO map the `$lib` alias and stub `$app/environment` so server modules
// (storage, stickers, sticker-import) are importable without the full SvelteKit
// build — the same modules resolve those specifiers via SvelteKit at runtime.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/environment': fileURLToPath(new URL('./vitest-stubs/app-environment.ts', import.meta.url))
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
		environment: 'node'
	}
});
