import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Shared paths for the E2E harness. Imported by both playwright.config.ts (to
// point the dev server at the throwaway DB) and seed.ts (to build it), so the
// two processes agree on which config + persist dir to use.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const E2E_DB_NAME = 'sona-e2e-db';
export const E2E_WRANGLER_CONFIG = path.join(here, 'wrangler.e2e.toml');

// Throwaway miniflare state, wiped and rebuilt on every run (gitignored).
//
// Two tools touch this DB and nest under it DIFFERENTLY, so they need different
// paths to land on the same files:
//   - `wrangler d1 execute --persist-to X`  writes  X/v3/d1/...   (adds /v3)
//   - getPlatformProxy({ persist: { path: X } })  writes  X/d1/... (no /v3)
// seed.ts seeds via the CLI (E2E_PERSIST_TO); the dev server reads via
// getPlatformProxy, so it is pointed one level deeper (E2E_PLATFORM_PERSIST) to
// meet the CLI's /v3 subdir.
export const E2E_PERSIST_TO = path.join(repoRoot, '.wrangler-e2e');
export const E2E_PLATFORM_PERSIST = path.join(E2E_PERSIST_TO, 'v3');

// The password-recovery spec mutates shared admin state (sets adminPasswordHash,
// deletes every session), which would break the read-only specs' legacy-password
// login if it ran against the same DB under fullyParallel. So it gets its OWN
// throwaway DB + dev server (a second webServer + the "recovery" project in
// playwright.config.ts); seed.ts targets this dir via SONA_E2E_SEED_PERSIST_TO.
export const E2E_PERSIST_TO_RECOVERY = path.join(repoRoot, '.wrangler-e2e-recovery');
export const E2E_PLATFORM_PERSIST_RECOVERY = path.join(E2E_PERSIST_TO_RECOVERY, 'v3');

// The recovery spec's Resend interceptor (tests/e2e/resend-mock.mjs, preloaded
// into its dev server) appends captured reset links here; the spec polls it.
// Lives under the recovery persist dir so seed.ts's wipe clears stale links
// before each run. Absolute path resolved here so config + preload + spec agree.
export const E2E_RESEND_MOCK = path.join(here, 'resend-mock.mjs');
export const E2E_RESEND_CAPTURE = path.join(E2E_PERSIST_TO_RECOVERY, 'resend-capture.jsonl');

// The ut-stat spec drives /admin/settings with UPLOADTHING_TOKEN set so the load
// fetches live UT usage — which fires a server-side getUsageInfo() call. That
// token can't go in the shared config (it would make the other specs' settings
// loads hit the network), so this spec gets its OWN wrangler config (adds the
// token) + throwaway DB + dev server, with the UT interceptor preloaded. See
// playwright.config.ts and wrangler.e2e-uploadthing.toml.
export const E2E_WRANGLER_CONFIG_UT = path.join(here, 'wrangler.e2e-uploadthing.toml');
export const E2E_PERSIST_TO_UT = path.join(repoRoot, '.wrangler-e2e-uploadthing');
export const E2E_PLATFORM_PERSIST_UT = path.join(E2E_PERSIST_TO_UT, 'v3');
export const E2E_UPLOADTHING_MOCK = path.join(here, 'uploadthing-mock.mjs');
