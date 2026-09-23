import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Shared paths for the E2E harness. Imported by both playwright.config.ts (to
// point the dev server at the throwaway DB) and seed.ts (to build it), so the
// two processes agree on which config + persist dir to use.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// Throwaway miniflare state hangs off the checkout, so separate worktrees are
// already isolated from each other. Two runs sharing ONE checkout are not —
// parallel review gates in a single worktree seed and read the same D1 files,
// and a seed landing while another run's workerd holds the DB surfaces as a
// fatal SQLITE_BUSY. SONA_E2E_PERSIST_ROOT gives such a run a private root
// (pair it with SONA_E2E_BASE_PORT in playwright.config.ts) — SONA-164.
//
// `||`, not `??`: an env var that is present but EMPTY has to mean "unset". With
// `??` an empty value wins, every persist path silently turns relative, and the
// DB then lands wherever the process happened to be started from.
const persistRoot = process.env.SONA_E2E_PERSIST_ROOT || repoRoot;

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
export const E2E_PERSIST_TO = path.join(persistRoot, '.wrangler-e2e');
export const E2E_PLATFORM_PERSIST = path.join(E2E_PERSIST_TO, 'v3');

// The password-recovery spec mutates shared admin state (sets adminPasswordHash,
// deletes every session), which would break the read-only specs' legacy-password
// login if it ran against the same DB under fullyParallel. So it gets its OWN
// throwaway DB + dev server (a second webServer + the "recovery" project in
// playwright.config.ts); seed.ts targets this dir via SONA_E2E_SEED_PERSIST_TO.
export const E2E_PERSIST_TO_RECOVERY = path.join(persistRoot, '.wrangler-e2e-recovery');
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
export const E2E_PERSIST_TO_UT = path.join(persistRoot, '.wrangler-e2e-uploadthing');
export const E2E_PLATFORM_PERSIST_UT = path.join(E2E_PERSIST_TO_UT, 'v3');
export const E2E_UPLOADTHING_MOCK = path.join(here, 'uploadthing-mock.mjs');

// The upload spec drives a real admin upload through the UploadThing streaming
// put (SONA-136): server-side ingest PUT answered by the uploadthing-mock.mjs
// preload. It needs UPLOADTHING_TOKEN (so it reuses the UT wrangler config +
// preload) but its OWN DB + server: it inserts images, and it relies on the
// active provider staying 'uploadthing' — which the ut-stat spec flips on ITS
// server. Sharing a server would race under fullyParallel.
export const E2E_PERSIST_TO_UPLOAD = path.join(persistRoot, '.wrangler-e2e-upload');
export const E2E_PLATFORM_PERSIST_UPLOAD = path.join(E2E_PERSIST_TO_UPLOAD, 'v3');

// The tag-suggestions spec reads the two admin forms with the lookup endpoint
// intercepted, so it writes no rows — but it runs one worker at a time (a
// client-side navigation landing after a fill detaches the form under the
// assertion), and on the shared server that serial run sits behind the parallel
// chromium project's load, where its admin logins time out. So it gets its OWN
// throwaway DB + dev server. The shared wrangler config is enough: it needs no
// extra token or preload. See playwright.config.ts.
export const E2E_PERSIST_TO_TAGS = path.join(persistRoot, '.wrangler-e2e-tag-suggestions');
export const E2E_PLATFORM_PERSIST_TAGS = path.join(E2E_PERSIST_TO_TAGS, 'v3');

// The suggest-tags spec drives the backfill list, whose Save WRITES tag rows.
// It used to ride the upload server, whose DB the upload spec counts on, and
// the two flaked each other in combined runs. So it gets its OWN throwaway DB
// + dev server, serial like tag-suggestions and on the shared wrangler config:
// the lookup endpoint is intercepted, so no token or preload is needed.
export const E2E_PERSIST_TO_SUGGEST = path.join(persistRoot, '.wrangler-e2e-suggest-tags');
export const E2E_PLATFORM_PERSIST_SUGGEST = path.join(E2E_PERSIST_TO_SUGGEST, 'v3');

// The theme-picker spec saves a theme through the settings form and then reads
// it off a public page. That setting is global: while it is not the default,
// EVERY page on the server renders in another palette and another headline face,
// so on the shared server it would race the specs that read colours or measure
// text. Its own throwaway DB + dev server, on the shared wrangler config (it
// needs no token or preload). See playwright.config.ts (SONA-227).
export const E2E_PERSIST_TO_THEME = path.join(persistRoot, '.wrangler-e2e-theme');
export const E2E_PLATFORM_PERSIST_THEME = path.join(E2E_PERSIST_TO_THEME, 'v3');

// The stickers-content spec needs what the shared fixture deliberately does not
// have: a published sticker pack. nav-gating.spec.ts asserts the gated state
// that ZERO packs produces, so the two cannot share a database. This server
// seeds the shared fixture and then layers fixtures/stickers.sql on top
// (SONA_E2E_SEED_OVERLAY, read by seed.ts). Shared wrangler config: it needs no
// token or preload, and the spec only reads. See playwright.config.ts (SONA-227).
export const E2E_STICKERS_OVERLAY = path.join(here, 'fixtures', 'stickers.sql');
export const E2E_PERSIST_TO_STICKERS = path.join(persistRoot, '.wrangler-e2e-stickers');
export const E2E_PLATFORM_PERSIST_STICKERS = path.join(E2E_PERSIST_TO_STICKERS, 'v3');

// The passport spec needs the homepage on landingLayout = 'passport', which
// would change what every other spec sees at / on the shared server, and it
// needs two databases: the shared fixture (a live convention, an NSFW
// designated ref sheet, VR avatars, socials) and a fresh-site one with no
// content at all, for the stampless empty state. Each server seeds the shared
// fixture and layers its own overlay on top. Both only read. The populated one
// runs FurTrack in mock mode (its own wrangler config) so the fursuit and
// past-event stamps render.
export const E2E_WRANGLER_CONFIG_PASSPORT = path.join(here, 'wrangler.e2e-passport.toml');
export const E2E_PASSPORT_OVERLAY = path.join(here, 'fixtures', 'passport.sql');
export const E2E_PERSIST_TO_PASSPORT = path.join(persistRoot, '.wrangler-e2e-passport');
export const E2E_PLATFORM_PERSIST_PASSPORT = path.join(E2E_PERSIST_TO_PASSPORT, 'v3');
export const E2E_PASSPORT_EMPTY_OVERLAY = path.join(here, 'fixtures', 'passport-empty.sql');
export const E2E_PERSIST_TO_PASSPORT_EMPTY = path.join(persistRoot, '.wrangler-e2e-passport-empty');
export const E2E_PLATFORM_PERSIST_PASSPORT_EMPTY = path.join(E2E_PERSIST_TO_PASSPORT_EMPTY, 'v3');

// The registry-sync spec clicks the admin "Sync now" button with the shared
// registry turned ON (REGISTRY_API_KEY + REGISTRY_URL in
// wrangler.e2e-registry.toml), which makes the settings and artists loads call
// the registry server-side. That can't run on the shared server (no key there,
// on purpose), so it gets its OWN wrangler config, throwaway DB and dev server,
// with the registry interceptor preloaded. The spec steers the interceptor by
// writing a scenario file it reads on every request; it lives under the persist
// dir so seed.ts's wipe clears it before each run.
export const E2E_WRANGLER_CONFIG_REGISTRY = path.join(here, 'wrangler.e2e-registry.toml');
export const E2E_PERSIST_TO_REGISTRY = path.join(persistRoot, '.wrangler-e2e-registry');
export const E2E_PLATFORM_PERSIST_REGISTRY = path.join(E2E_PERSIST_TO_REGISTRY, 'v3');
export const E2E_REGISTRY_MOCK = path.join(here, 'registry-mock.mjs');
// The registry host the interceptor answers. wrangler.e2e-registry.toml has to
// carry the same value as REGISTRY_URL (wrangler vars can't read this file);
// src/lib/e2e-registry-config.test.ts holds the two together. A reserved
// .invalid name: it can never resolve, so a missed interception fails fast.
export const E2E_REGISTRY_URL = 'https://registry.e2e.invalid';
export const E2E_REGISTRY_SCENARIO = path.join(E2E_PERSIST_TO_REGISTRY, 'registry-scenario.json');
