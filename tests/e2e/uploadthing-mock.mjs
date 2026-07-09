// E2E-only interceptor for the UploadThing usage-info call in the admin storage panel.
//
// The settings load (src/routes/admin/settings/+page.server.ts) calls
// `new UTApi({ token }).getUsageInfo()` SERVER-SIDE whenever UPLOADTHING_TOKEN is
// present — that POSTs to https://api.uploadthing.com/v6/getUsageInfo from inside
// the dev server process, so Playwright's `page.route` (which only sees the
// browser's own requests) can NOT intercept it. Same shape as resend-mock.mjs:
// this module is preloaded into the dev-server Node process via
// NODE_OPTIONS=--import (wired in playwright.config.ts) and monkeypatches the
// process-global `fetch`. UTApi captures `globalThis.fetch` in its constructor,
// which the load runs per-request AFTER this preload, so the patched fetch is the
// one it uses. Every other request passes through untouched.
//
// The payload is deterministic so the spec can assert exact values: filesUploaded
// drives the "UT Files" stat, and appTotalBytes (mapped to usedBytes server-side)
// must be > 0 so the "UploadThing still holds …" leftover prompt renders once the
// active provider is R2 — that leftover is what proves the R2 assertion is testing
// the provider guard, not a null-usage check.

const USAGE_INFO_URL = 'https://api.uploadthing.com/v6/getUsageInfo';

// Deterministic usage the spec asserts against. filesUploaded is a distinctive
// value (not a plausible seeded image count or size) so the R2 test can assert the
// exact NUMBER is absent anywhere on the page — that catches a NEW unguarded render
// of the count (a bare `{data.utUsage.filesUploaded}`), which is the whole point.
const USAGE = {
	filesUploaded: 4242,
	appTotalBytes: 5 * 1024 * 1024, // 5 MB — non-zero so the R2 leftover prompt shows
	totalBytes: 5 * 1024 * 1024,
	limitBytes: 2 * 1024 * 1024 * 1024 // 2 GB
};

const realFetch = globalThis.fetch;

function urlOf(input) {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (input && typeof input.url === 'string') return input.url; // Request
	return String(input);
}

globalThis.fetch = async function patchedFetch(input, init) {
	if (urlOf(input).startsWith(USAGE_INFO_URL)) {
		// Mimic UploadThing's 2xx usage response so UTApi.getUsageInfo() resolves
		// and the load populates data.utUsage. Fields match GetUsageInfoResponse.
		return new Response(JSON.stringify(USAGE), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	return realFetch(input, init);
};
