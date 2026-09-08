import { describe, it, expect } from 'vitest';
import { isPrivateHost, isSameOriginUrl, proxyStoredImage } from './image-proxy';

// The guard both byte proxies rely on. Driven directly rather than through a
// route, because the boundaries are the whole point and a route test only ever
// exercises one of them.
describe('isPrivateHost', () => {
	it('blocks IPv4 loopback, unspecified, RFC1918 and link-local', () => {
		for (const host of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.1', '169.254.1.1', '172.16.0.1', '172.31.255.255']) {
			expect(isPrivateHost(host), host).toBe(true);
		}
	});

	// Not RFC1918, but not the public internet either: CGNAT is what a carrier or
	// an overlay network hands out, benchmarking space is routed to lab gear, and
	// the IETF protocol block holds NAT64/DS-Lite endpoints. A stored URL naming
	// one of them reaches a machine on the operator's network.
	it('blocks CGNAT, benchmarking and IETF protocol space', () => {
		for (const host of ['100.64.0.1', '100.100.5.5', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1']) {
			expect(isPrivateHost(host), host).toBe(true);
		}
	});

	it('keeps those three prefixes exact, one address either side', () => {
		// Written per-prefix rather than per-octet: 100.63 and 100.128 sit outside
		// the /10, 198.17 and 198.20 outside the /15, and 192.0.1 outside the /24.
		// A lazier regex (100., 198., 192.0.) would blackhole real public hosts.
		for (const host of ['100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1', '192.0.1.1']) {
			expect(isPrivateHost(host), host).toBe(false);
		}
	});

	// Not a gap to close, a normalisation to pin: the callers read
	// `new URL(...).hostname`, and WHATWG parses an integer or hex-spelled IPv4
	// host into dotted-decimal before the regex ever sees it. Anything here that
	// stopped normalising would be a platform change, not a missing branch.
	it('sees decimal and hex spellings of loopback already normalised by URL', () => {
		expect(new URL('http://2130706433/x.jpg').hostname).toBe('127.0.0.1');
		expect(new URL('http://0x7f000001/x.jpg').hostname).toBe('127.0.0.1');
		expect(isPrivateHost(new URL('http://2130706433/x.jpg').hostname)).toBe(true);
		expect(isPrivateHost(new URL('http://0x7f000001/x.jpg').hostname)).toBe(true);
	});

	it('blocks localhost however it is spelled', () => {
		expect(isPrivateHost('localhost')).toBe(true);
		// A trailing dot is an FQDN spelling of the same host.
		expect(isPrivateHost('LOCALHOST.')).toBe(true);
	});

	it('unwraps IPv4-mapped IPv6 in both spellings', () => {
		expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
		// WHATWG URL normalizes the dotted form to two hex pieces.
		expect(isPrivateHost('[::ffff:7f00:1]')).toBe(true);
	});

	it('blocks the whole of link-local, not just the fe80 block', () => {
		// fe80::/10 is a TEN bit prefix: it runs fe80 through febf. Matching only
		// 'fe80:' left fe90 and above reachable while the comment above the regex
		// claimed the whole range was covered.
		for (const host of ['[fe80::1]', '[fe90::1]', '[feaf::1]', '[febf::1]']) {
			expect(isPrivateHost(host), host).toBe(true);
		}
	});

	it('blocks loopback, unspecified and ULA', () => {
		for (const host of ['[::1]', '[::]', '[fc00::1]', '[fd12::1]']) {
			expect(isPrivateHost(host), host).toBe(true);
		}
	});

	it('allows ordinary public hosts, including ones that merely start with fe', () => {
		for (const host of ['cdn.bsky.app', 'utfs.io', 'example.com', '[2606:4700::1]', '[fe08::1]']) {
			expect(isPrivateHost(host), host).toBe(false);
		}
	});
});

describe('isSameOriginUrl', () => {
	const origin = 'https://fork.example';

	it('treats root-relative as same-origin but not protocol-relative', () => {
		expect(isSameOriginUrl('/img/avatars/owner/face.jpg', origin)).toBe(true);
		// '//host/path' borrows the scheme and is a DIFFERENT host.
		expect(isSameOriginUrl('//evil.example/x.png', origin)).toBe(false);
	});

	it('compares absolute URLs by origin', () => {
		expect(isSameOriginUrl('https://fork.example/img/x.png', origin)).toBe(true);
		expect(isSameOriginUrl('https://cdn.bsky.app/img/x', origin)).toBe(false);
		// Same host, different scheme is a different origin.
		expect(isSameOriginUrl('http://fork.example/img/x.png', origin)).toBe(false);
	});
});

// The response the proxy builds. Three callers share this file (artist-lookup,
// avatar, ref-image) and only one of them pins the content-type fold, so a
// regression here would silently turn the other two's images into downloads.
describe('proxyStoredImage', () => {
	function fetcherAnswering(contentType: string): typeof fetch {
		return (async () =>
			new Response('bytes', { headers: { 'content-type': contentType } })) as unknown as typeof fetch;
	}

	async function proxy(contentType: string): Promise<Response> {
		const res = await proxyStoredImage('https://cdn.example/img.png', fetcherAnswering(contentType));
		if (!res) throw new Error('proxyStoredImage returned null');
		return res;
	}

	// Media types are case-insensitive, so the upstream's own spelling is echoed
	// back rather than demoted to a download.
	it('passes an image content type through whatever its case', async () => {
		expect((await proxy('Image/PNG')).headers.get('content-type')).toBe('Image/PNG');
		expect((await proxy('image/png')).headers.get('content-type')).toBe('image/png');
	});

	// The type parameters an upstream may attach are not part of the media type.
	it('passes an allowed type through with its parameters', async () => {
		const res = await proxy('Image/JPEG; charset=binary');
		expect(res.headers.get('content-type')).toBe('Image/JPEG; charset=binary');
		expect(res.headers.get('content-disposition')).toBe('inline');
	});

	// Narrower than image/*: SVG is an image type that carries script, so it is
	// demoted exactly like a text/html payload wearing an image URL.
	it('demotes svg and non-image types to a download', async () => {
		for (const type of ['image/svg+xml', 'text/html']) {
			const res = await proxy(type);
			expect(res.headers.get('content-type'), type).toBe('application/octet-stream');
			expect(res.headers.get('content-disposition'), type).toBe('attachment');
		}
	});

	it('serves inline and never caches', async () => {
		const res = await proxy('image/png');
		expect(res.headers.get('content-disposition')).toBe('inline');
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});

	// A second, redundant layer: even a response a browser decided to render
	// gets an opaque origin with scripts off.
	it('sandboxes the response', async () => {
		expect((await proxy('image/png')).headers.get('content-security-policy')).toBe('sandbox');
		expect((await proxy('text/html')).headers.get('content-security-policy')).toBe('sandbox');
	});

	it('refuses a private host without fetching', async () => {
		let called = false;
		const fetcher = (async () => {
			called = true;
			return new Response('bytes', { headers: { 'content-type': 'image/png' } });
		}) as unknown as typeof fetch;
		expect(await proxyStoredImage('http://127.0.0.1/img.png', fetcher)).toBeNull();
		expect(called).toBe(false);
	});

	// A fetch that REJECTS rather than answering — DNS failure, reset connection,
	// TLS error. Handled here rather than in each route, so all three callers
	// report the stored image as unreachable instead of throwing a 500.
	it('answers null when the fetch rejects', async () => {
		const rejecting = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		expect(await proxyStoredImage('https://cdn.example/img.png', rejecting)).toBeNull();
	});
});
