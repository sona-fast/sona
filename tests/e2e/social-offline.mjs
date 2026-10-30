// E2E-only: keeps the commissions spec's dev server off X and Bluesky.
//
// Adding an artist from a pasted link looks up their avatar SERVER-SIDE
// (src/lib/server/avatar.ts), and Playwright's `page.route` can't see that, so
// without this the run would call api.x.com and the Bluesky API for real, from
// whoever runs it. Same shape as registry-mock.mjs: preloaded via
// NODE_OPTIONS=--import (playwright.config.ts), patching the process-global
// `fetch`. Every request to an X or Bluesky host gets a 503, which the lookup
// treats as "no avatar"; everything else passes through.
const SOCIAL_HOST = /(^|\.)(x\.com|twitter\.com|twimg\.com|bsky\.app|bsky\.social|bsky\.network)$/;

const realFetch = globalThis.fetch;

function urlOf(input) {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (input && typeof input.url === 'string') return input.url; // Request
	return String(input);
}

globalThis.fetch = async function socialOfflineFetch(input, init) {
	let host = '';
	try {
		host = new URL(urlOf(input)).hostname;
	} catch {
		// Not an absolute URL: not a social host either.
	}
	if (SOCIAL_HOST.test(host)) return new Response('offline in e2e', { status: 503 });
	return realFetch(input, init);
};
