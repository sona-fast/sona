import { defineConfig, devices } from '@playwright/test';
import { E2E_PLATFORM_PERSIST, E2E_WRANGLER_CONFIG } from './tests/e2e/paths';

const PORT = 4179;

// Point `vite dev` at the E2E-only wrangler config + throwaway persist dir (see
// svelte.config.js, which honours these envs) so tests run against the DB that
// global-setup seeds, in isolation from the developer's real dev database.
const devServerEnv = {
	WRANGLER_CONFIG: E2E_WRANGLER_CONFIG,
	WRANGLER_PERSIST_TO: E2E_PLATFORM_PERSIST
};

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
		// View Transitions animate the variant swap; reduce motion so assertions
		// aren't racing a transition.
		reducedMotion: 'reduce',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		// Seed a fresh throwaway D1 first, then boot the dev server against it.
		// Seeding here (not in globalSetup) guarantees it finishes before the
		// server reads the DB — playwright starts webServer before globalSetup.
		command: `npm run test:e2e:seed && npm run dev -- --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		env: devServerEnv,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
