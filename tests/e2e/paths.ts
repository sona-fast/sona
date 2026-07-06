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
