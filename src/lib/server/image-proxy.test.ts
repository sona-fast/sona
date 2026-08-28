import { describe, it, expect } from 'vitest';
import { isPrivateHost, isSameOriginUrl } from './image-proxy';

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
