import { defineConfig, devices } from '@playwright/test';
import {
	E2E_PLATFORM_PERSIST,
	E2E_PLATFORM_PERSIST_RECOVERY,
	E2E_PERSIST_TO_RECOVERY,
	E2E_WRANGLER_CONFIG,
	E2E_RESEND_CAPTURE,
	E2E_RESEND_MOCK
} from './tests/e2e/paths';

// The shared read-only DB/server (gallery, palette) and an isolated one for the
// session-mutating password-recovery spec — see below.
const PORT = 4179;
const RECOVERY_PORT = 4180;

// Point `vite dev` at the E2E-only wrangler config + throwaway persist dir (see
// svelte.config.js, which honours these envs) so tests run against the DB the
// webServer seed step builds, in isolation from the developer's real dev
// database. The SONA_E2E_ prefix keeps these from colliding with real wrangler env.
const sharedServerEnv = {
	SONA_E2E_WRANGLER_CONFIG: E2E_WRANGLER_CONFIG,
	SONA_E2E_PERSIST_TO: E2E_PLATFORM_PERSIST
};

// The recovery spec sets adminPasswordHash and deletes every session, which would
// break the other specs' legacy-password login if it shared their DB under
// fullyParallel — so it gets its own seeded DB (SONA_E2E_SEED_PERSIST_TO) + server.
// NODE_OPTIONS preloads the Resend interceptor (tests/e2e/resend-mock.mjs) into
// this server so the spec can capture the reset link from the server-side send
// (Playwright can't route server-side fetch); the capture path is threaded through
// for the preload to write and the spec to read.
const recoveryServerEnv = {
	SONA_E2E_WRANGLER_CONFIG: E2E_WRANGLER_CONFIG,
	SONA_E2E_PERSIST_TO: E2E_PLATFORM_PERSIST_RECOVERY,
	SONA_E2E_SEED_PERSIST_TO: E2E_PERSIST_TO_RECOVERY,
	SONA_E2E_RESEND_CAPTURE: E2E_RESEND_CAPTURE,
	NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${E2E_RESEND_MOCK}`.trim()
};

const RECOVERY_SPEC = '**/forgot-reset.spec.ts';

// Seed a fresh throwaway D1 first, then boot the dev server against it. Seeding
// here (not in globalSetup) guarantees it finishes before the server reads the
// DB — playwright starts webServer before globalSetup. reuseExistingServer:false
// + --strictPort: never reuse a squatter on the port (stale data) — fail loudly.
const webServer = (port: number, env: Record<string, string>) => ({
	command: `npm run test:e2e:seed && npm run dev -- --port ${port} --strictPort`,
	url: `http://localhost:${port}`,
	env,
	reuseExistingServer: false,
	timeout: 120_000
});

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	use: {
		// View Transitions animate the variant swap; reduce motion so assertions
		// aren't racing a transition.
		reducedMotion: 'reduce',
		trace: 'on-first-retry'
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: RECOVERY_SPEC,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` }
		},
		{
			name: 'recovery',
			testMatch: RECOVERY_SPEC,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${RECOVERY_PORT}` }
		}
	],
	webServer: [webServer(PORT, sharedServerEnv), webServer(RECOVERY_PORT, recoveryServerEnv)]
});
