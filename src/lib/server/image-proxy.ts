/**
 * Same-origin byte proxy for images the page has to READ rather than merely
 * display.
 *
 * The two are governed by different CSP directives and the app's policy treats
 * them very differently: `img-src` allows `https:`, so any remote image
 * displays fine, while `connect-src` is `'self'` (svelte.config.js), so
 * `fetch()` and XHR reach nothing off-origin. Anything that reads pixels or
 * bytes — a canvas sampler, a data-URI embed — therefore needs the image to
 * arrive same-origin, no matter how permissive the remote host's CORS is.
 *
 * Callers pass a URL the SERVER looked up (a stored row, a setting), never one
 * the client supplied, which is what keeps this from being an SSRF hole. On top
 * of that: private and link-local hosts are refused, redirects are not
 * followed, and only image/* content types are echoed back.
 */

// Loopback / unspecified / RFC1918 / link-local / ULA hosts a stored URL must
// never point the server-side fetch at.
export function isPrivateHost(hostname: string): boolean {
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
			// Loopback (::1), unspecified (:: — connect() reaches loopback, same
			// as its IPv4 twin 0.0.0.0), ULA (fc00::/7), link-local (fe80::/10).
			return /^\[(::1?\]$|f[cd]|fe80:)/.test(host);
		}
	}
	// IPv4 loopback / unspecified / RFC1918 / link-local.
	return /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/** Whether a URL is already readable by a same-origin `fetch` from the page. */
export function isSameOriginUrl(imageUrl: string, origin: string): boolean {
	if (imageUrl.startsWith('//')) return false;
	if (imageUrl.startsWith('/')) return true;
	try {
		return new URL(imageUrl).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Stream a stored image's bytes back to the page. `imageUrl` MUST come from the
 * server's own lookup; passing a caller-supplied URL here reopens SSRF.
 */
export async function proxyStoredImage(
	imageUrl: string,
	fetcher: typeof fetch
): Promise<Response | null> {
	// Root-relative URLs have no hostname (they resolve same-origin via
	// event.fetch); absolute URLs must not target internal hosts.
	let host = '';
	try {
		host = new URL(imageUrl).hostname;
	} catch {
		// not an absolute URL — same-origin, fine
	}
	if (isPrivateHost(host)) return null;

	// A storage host answering with a redirect is unexpected — treat it as an
	// upstream error rather than following it to an arbitrary location.
	const upstream = await fetcher(imageUrl, { redirect: 'manual' });
	if (!upstream.ok || !upstream.body) return null;

	const contentType = upstream.headers.get('content-type') ?? '';
	return new Response(upstream.body, {
		headers: {
			'Content-Type': contentType.startsWith('image/') ? contentType : 'application/octet-stream',
			'Content-Disposition': 'inline',
			'Cache-Control': 'private, no-store'
		}
	});
}
