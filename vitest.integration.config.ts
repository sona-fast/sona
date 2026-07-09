import { defineConfig } from 'vitest/config';

// Integration tests that need real external tooling (wrangler + a local D1) and
// are therefore too slow/heavy for the fast unit suite (`npm test`). They live
// under tests/integration/ — outside vitest.config.ts's include globs — and run
// via `npm run test:integration`, gated in CI to where wrangler is available.
export default defineConfig({
	test: {
		include: ['tests/integration/**/*.{test,spec}.ts'],
		environment: 'node',
		// Real wrangler migrate + miniflare boot is far slower than a unit test.
		testTimeout: 180_000,
		hookTimeout: 60_000,
		// These tests mutate process-global CWD (process.chdir), so they must not
		// run concurrently with each other — isolate each file in its own process
		// and disable file parallelism.
		pool: 'forks',
		fileParallelism: false
	}
});
