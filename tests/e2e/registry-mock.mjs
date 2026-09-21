// E2E-only interceptor for the shared artist registry, used by the registry-sync
// spec's dedicated dev server.
//
// The sync (src/lib/server/artist-sync.ts) calls the registry SERVER-SIDE from
// inside the dev server process, so Playwright's `page.route` (which only sees the
// browser's own requests) can NOT intercept it. Same shape as resend-mock.mjs and
// uploadthing-mock.mjs: preloaded via NODE_OPTIONS=--import (playwright.config.ts)
// and monkeypatching the process-global `fetch`. Every request to REGISTRY_URL
// (wrangler.e2e-registry.toml) is answered here; everything else passes through.
//
// What it answers with is read from a scenario file on EVERY request
// (SONA_E2E_REGISTRY_SCENARIO), so the spec can switch the registry's behaviour
// between tests without restarting the server: it writes the file, clicks "Sync
// now", and reads the toast. No file, or no entry for an endpoint, means a healthy
// empty answer.
//
// Scenario shape (JSON):
//   { "delta":  { "status": 200, "json": { "artists": [], "nextCursor": null } },
//     "search": { "status": 403, "html": true, "mitigated": "challenge" } }
// `json` sends that body as application/json; `html` sends a challenge-style HTML
// page instead; `mitigated` adds a cf-mitigated header (a zone block in front of
// the registry, the 2026-09-17 incident shape); `ray` adds a cf-ray header.

import { existsSync, readFileSync } from 'node:fs';

// Both come from playwright.config.ts (tests/e2e/paths.ts holds the values).
// Without the host this preload would silently answer nothing and the sync
// would send the throwaway key wherever wrangler.e2e-registry.toml points.
const REGISTRY_URL = process.env.SONA_E2E_REGISTRY_URL;
const SCENARIO = process.env.SONA_E2E_REGISTRY_SCENARIO;
if (!REGISTRY_URL || !SCENARIO) {
	throw new Error('registry-mock.mjs needs SONA_E2E_REGISTRY_URL and SONA_E2E_REGISTRY_SCENARIO');
}

const HEALTHY = {
	delta: { status: 200, json: { artists: [], nextCursor: null } },
	search: { status: 200, json: { artists: [] } }
};

const realFetch = globalThis.fetch;

function urlOf(input) {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (input && typeof input.url === 'string') return input.url; // Request
	return String(input);
}

function scenario() {
	// Not written yet (a test that never called setRegistry): a healthy registry.
	if (!existsSync(SCENARIO)) return HEALTHY;
	// Present but unparseable is a harness bug, not a mood: the spec renames the
	// file into place whole, so this can't be a torn read. Throwing here keeps the
	// healthy-registry test from passing for the wrong reason.
	return { ...HEALTHY, ...JSON.parse(readFileSync(SCENARIO, 'utf8')) };
}

function answer(spec) {
	const headers = {};
	if (spec.mitigated) headers['cf-mitigated'] = spec.mitigated;
	if (spec.ray) headers['cf-ray'] = spec.ray;
	if (spec.html) {
		headers['content-type'] = 'text/html';
		return new Response('<html><body>Just a moment...</body></html>', { status: spec.status, headers });
	}
	headers['content-type'] = 'application/json';
	// `'json' in spec`, not `??`: a scenario that says json: null means "answer
	// null" (the single-artist lookup's not-found shape), not "answer {}".
	return new Response(JSON.stringify('json' in spec ? spec.json : {}), { status: spec.status, headers });
}

globalThis.fetch = async function patchedFetch(input, init) {
	const url = urlOf(input);
	if (url.startsWith(REGISTRY_URL + '/')) {
		const { pathname } = new URL(url);
		const s = scenario();
		// The delta feed is GET /v1/artists (with a query); the handle search is
		// /v1/artists/search; a single lookup is /v1/artists/<globalId>, whose
		// client expects an artist or null, never a page.
		if (pathname === '/v1/artists/search') return answer(s.search);
		if (pathname === '/v1/artists') return answer(s.delta);
		if (pathname.startsWith('/v1/artists/')) return answer({ status: 200, json: null });
		// Anything else on the registry (submissions list, fork registration): an
		// empty success, so unrelated admin loads on this server stay quiet.
		return new Response(JSON.stringify({ submissions: [] }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	return realFetch(input, init);
};
