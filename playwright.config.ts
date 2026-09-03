import { defineConfig, devices } from '@playwright/test';
import {
	E2E_PLATFORM_PERSIST,
	E2E_PLATFORM_PERSIST_RECOVERY,
	E2E_PERSIST_TO_RECOVERY,
	E2E_WRANGLER_CONFIG,
	E2E_RESEND_CAPTURE,
	E2E_RESEND_MOCK,
	E2E_PLATFORM_PERSIST_UT,
	E2E_PERSIST_TO_UT,
	E2E_WRANGLER_CONFIG_UT,
	E2E_UPLOADTHING_MOCK,
	E2E_PLATFORM_PERSIST_UPLOAD,
	E2E_PERSIST_TO_UPLOAD
} from './tests/e2e/paths';

// The shared read-only DB/server (gallery, palette), an isolated one for the
// session-mutating password-recovery spec, an isolated one for the ut-stat
// spec (needs UPLOADTHING_TOKEN + the UT interceptor, which would perturb the
// shared specs), and an isolated one for the upload spec — see below.
//
// The four ports are derived from one base so a concurrent run can take a
// private block: set SONA_E2E_BASE_PORT and this run binds base..base+3 instead
// of 4179-4182. Without it, every checkout and every agent binds the same four
// ports, and a second run either dies on --strictPort or (worse) gets its
// servers killed by whoever assumes the listener is their own stray (SONA-164).
// `||`, not `??`, for the same reason as persistRoot in tests/e2e/paths.ts: a
// present-but-empty value means "unset". ('0' stays truthy as a string, so an
// explicitly invalid port still trips the check below rather than silently
// falling back.)
const BASE_PORT = Number(process.env.SONA_E2E_BASE_PORT || 4179);
if (!Number.isInteger(BASE_PORT) || BASE_PORT < 1024 || BASE_PORT > 65_532) {
	throw new Error(
		`SONA_E2E_BASE_PORT must be an integer in 1024-65532 (needs 4 consecutive ports), got: ${process.env.SONA_E2E_BASE_PORT}`
	);
}
const PORT = BASE_PORT;
const RECOVERY_PORT = BASE_PORT + 1;
const UT_PORT = BASE_PORT + 2;
const UPLOAD_PORT = BASE_PORT + 3;

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

// The ut-stat spec sets UPLOADTHING_TOKEN so the load fetches live UT usage, and
// mutates the active storage provider (uploadthing -> r2) to prove the file-count
// stat is hidden by the PROVIDER guard, not a null-usage check. Both would leak
// into the shared specs (extra network + flipped storageStatus, and a raced
// provider setting) — so it gets its own seeded DB + server, and its own wrangler
// config that adds the token. NODE_OPTIONS preloads the UT interceptor
// (tests/e2e/uploadthing-mock.mjs) so getUsageInfo() never hits the network.
const utServerEnv = {
	SONA_E2E_WRANGLER_CONFIG: E2E_WRANGLER_CONFIG_UT,
	SONA_E2E_PERSIST_TO: E2E_PLATFORM_PERSIST_UT,
	SONA_E2E_SEED_PERSIST_TO: E2E_PERSIST_TO_UT,
	NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${E2E_UPLOADTHING_MOCK}`.trim()
};

// The upload spec exercises the streaming admin upload against the (mocked)
// UploadThing ingest endpoint: same wrangler config + preload as ut-stat (the
// preload also answers the ingest PUT), but its own DB + server — it inserts
// image rows and depends on the seeded default provider ('uploadthing'), which
// ut-stat flips on its own server. See tests/e2e/paths.ts.
const uploadServerEnv = {
	SONA_E2E_WRANGLER_CONFIG: E2E_WRANGLER_CONFIG_UT,
	SONA_E2E_PERSIST_TO: E2E_PLATFORM_PERSIST_UPLOAD,
	SONA_E2E_SEED_PERSIST_TO: E2E_PERSIST_TO_UPLOAD,
	NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${E2E_UPLOADTHING_MOCK}`.trim()
};

const RECOVERY_SPEC = '**/forgot-reset.spec.ts';
// storage-breakdown rides the ut-stat server: it also flips the storage
// provider, which would race the shared server's specs (SONA-192).
const UT_SPECS = ['**/ut-stat.spec.ts', '**/storage-breakdown.spec.ts'];
const UPLOAD_SPEC = '**/upload.spec.ts';

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
	// Convention: playwright e2e specs are *.spec.ts; *.test.ts is vitest
	// (fixture-integrity.test.ts lives beside the fixture it guards). Without
	// this, playwright's default testMatch also collects .test.ts and explodes
	// importing vitest's describe/it outside vitest's runtime.
	testMatch: '**/*.spec.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	use: {
		// View Transitions animate the variant swap; reduce motion so assertions
		// aren't racing a transition.
		reducedMotion: 'reduce',
		trace: 'on-first-retry',
		// WebGL for the vr-render spec: the GitHub Actions runner has no GPU, and
		// headless chromium refuses software WebGL without an explicit opt-in.
		// --use-angle=swiftshader routes ANGLE onto the bundled SwiftShader CPU
		// rasterizer; --enable-unsafe-swiftshader is the opt-in newer Chromium
		// builds additionally require (older builds ignore unknown flags, so the
		// pair is safe across versions). Harmless for the non-WebGL specs.
		launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: [RECOVERY_SPEC, ...UT_SPECS, UPLOAD_SPEC],
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` }
		},
		{
			name: 'recovery',
			testMatch: RECOVERY_SPEC,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${RECOVERY_PORT}` }
		},
		{
			name: 'ut-stat',
			testMatch: UT_SPECS,
			// Both specs mutate the shared seeded DB's storage provider — one
			// worker keeps the two files from racing each other's saves.
			workers: 1,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${UT_PORT}` }
		},
		{
			name: 'upload',
			testMatch: UPLOAD_SPEC,
			// The upload tests share one seeded dev server and an admin
			// session flow that flakes under parallel load — run them serially.
			workers: 1,
			use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${UPLOAD_PORT}` }
		}
	],
	webServer: [
		webServer(PORT, sharedServerEnv),
		webServer(RECOVERY_PORT, recoveryServerEnv),
		webServer(UT_PORT, utServerEnv),
		webServer(UPLOAD_PORT, uploadServerEnv)
	]
});
