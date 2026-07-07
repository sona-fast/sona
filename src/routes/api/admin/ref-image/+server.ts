import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

// GET /api/admin/ref-image?id=<imageId>  (admin-only via hooks — everything
// under /api except /api/cron/ requires the admin session).
//
// Streams the stored image bytes same-origin so the ref-sheet color picker can
// read canvas pixels when the original URL would taint the canvas (e.g. dev
// pointing at prod-origin storage URLs). The image URL is looked up BY ID in
// the DB — this endpoint never fetches a caller-supplied URL (SSRF). Defense in
// depth on top of that: private/link-local upstream hosts are rejected before
// fetching, redirects are not followed, and only image/* content types are
// echoed back (anything else is served as an opaque download-safe blob).

// Loopback / unspecified / RFC1918 / link-local / ULA hosts a stored URL must
// never point the server-side fetch at.
function isPrivateHost(hostname: string): boolean {
	// A trailing dot is an FQDN spelling of the same host ("localhost." ==
	// "localhost") — strip it before matching.
	let host = hostname.toLowerCase().replace(/\.$/, '');
	if (host === 'localhost') return true;
	if (host.startsWith('[')) {
		// IPv4-mapped IPv6 (::ffff:a.b.c.d): unwrap the embedded IPv4 and fall
		// through to the IPv4 checks. WHATWG URL normalizes the dotted form to
		// two hex pieces (::ffff:7f00:1), so handle both spellings.
		const dotted = /^\[::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(host);
		const hexed = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
		if (dotted) {
			host = dotted[1];
		} else if (hexed) {
			const hi = parseInt(hexed[1], 16);
			const lo = parseInt(hexed[2], 16);
			host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
		} else {
			// Loopback (::1), ULA (fc00::/7), link-local (fe80::/10).
			return /^\[(::1\]$|f[cd]|fe80:)/.test(host);
		}
	}
	// IPv4 loopback / unspecified / RFC1918 / link-local.
	return /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

export const GET: RequestHandler = async ({ url, platform, fetch }) => {
	const id = Number(url.searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) error(400, 'Invalid image id');

	const db = getDb(platform!.env.DB);
	const row = await db
		.select({ imageUrl: images.imageUrl })
		.from(images)
		.where(eq(images.id, id))
		.get();
	if (!row) error(404, 'Image not found');

	// Root-relative URLs have no hostname (they resolve same-origin via
	// event.fetch); absolute URLs must not target internal hosts.
	let host = '';
	try {
		host = new URL(row.imageUrl).hostname;
	} catch {
		// not an absolute URL — same-origin, fine
	}
	if (isPrivateHost(host)) error(502, 'Could not fetch the stored image');

	// A storage host answering with a redirect is unexpected — treat it as an
	// upstream error rather than following it to an arbitrary location.
	const upstream = await fetch(row.imageUrl, { redirect: 'manual' });
	if (!upstream.ok || !upstream.body) error(502, 'Could not fetch the stored image');

	const contentType = upstream.headers.get('content-type') ?? '';
	return new Response(upstream.body, {
		headers: {
			'Content-Type': contentType.startsWith('image/') ? contentType : 'application/octet-stream',
			'Content-Disposition': 'inline',
			'Cache-Control': 'private, no-store'
		}
	});
};
