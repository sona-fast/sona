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
