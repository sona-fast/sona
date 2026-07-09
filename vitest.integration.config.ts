import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Integration tests that need real external tooling (wrangler + a local D1) and
// are therefore too slow/heavy for the fast unit suite (`npm test`). They live
// under tests/integration/ — outside vitest.config.ts's include globs — and run
// via `npm run test:integration`, gated in CI to where wrangler is available.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/environment': fileURLToPath(new URL('./vitest-stubs/app-environment.ts', import.meta.url))
		}
	},
	test: {
		include: ['tests/integration/**/*.{test,spec}.ts'],
		environment: 'node',
		// Real wrangler migrate + miniflare boot is far slower than a unit test.
		testTimeout: 180_000,
		hookTimeout: 60_000
	}
});
