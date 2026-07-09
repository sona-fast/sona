import { getDb } from '$lib/server/db';
import { recordDownload, isObservabilityEnabled } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/metrics/download — beacon fired when a visitor presses an image's
// download button. Public by necessity: the presser is an anonymous visitor, and
// the download itself goes straight from the browser to the storage provider, so
// this is the only point at which it can be observed.
//
// Exempted from the admin gate in hooks.server.ts. To keep an open write endpoint
// as boring as possible it:
//   - accepts no body and reads nothing from the request beyond Origin,
//   - requires a same-origin POST, so a cross-site page can't drive the counter,
//   - stores no ip, user-agent, image id or timestamp beyond the UTC day bucket,
//   - is a no-op when observability is off (most forks), touching no DB at all.
//
// It increments one bounded UPSERT row per day (`metric='download'`), so a flood
// costs D1 writes but cannot grow the table. The count is inflatable by anyone
// willing to POST in a loop; it is a popularity hint, never an authoritative
// figure. See recordDownload().
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const origin = request.headers.get('origin');
	if (origin !== url.origin) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!platform?.env.DB || !isObservabilityEnabled(platform?.env)) {
		return new Response(null, { status: 204 });
	}

	// Awaited, not fire-and-forget: the browser may tear the request down the moment
	// navigation to the file begins, and waitUntil is unavailable for a response we
	// have not returned yet. The write is a single UPSERT, so this stays sub-ms.
	try {
		await recordDownload(getDb(platform.env.DB));
	} catch {
		// Counting must never break downloading. The <a download> navigation is
		// already underway regardless of what we answer here.
	}
	return new Response(null, { status: 204 });
};
