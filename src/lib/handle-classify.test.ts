import { describe, it, expect } from 'vitest';
import { classifyQuery, normalizeHandle } from './handle-classify';

describe('classifyQuery — plain names', () => {
	it('treats ordinary text as a name search', () => {
		for (const s of ['Lunar Paws', 'kuttoya', 'a', 'Two Words', '  spaced name  ']) {
			expect(classifyQuery(s).kind).toBe('name');
		}
	});
	it('empty / whitespace / bare @ classify as name', () => {
		for (const s of ['', '   ', '@', '@@']) {
			const c = classifyQuery(s);
			expect(c.kind).toBe('name');
			expect(c.handleParam).toBe('');
		}
	});
	it('a bare bluesky-style handle (dots, no domain/slash) stays a name', () => {
		// Only full bsky.app/profile/… URLs are treated as handles; a bare
		// "name.bsky.social" is ambiguous with a name and left as a name search.
		expect(classifyQuery('kuttoya.bsky.social').kind).toBe('name');
	});
});

describe('classifyQuery — @handles', () => {
	it('classifies @handle with unknown platform, matching by bare handle', () => {
		const c = classifyQuery('@kuttoya');
		expect(c.kind).toBe('handle');
		expect(c.platform).toBeUndefined();
		expect(c.handleParam).toBe('kuttoya');
		expect(c.handle).toBe('kuttoya');
	});
	it('strips trailing slash / query junk from an @handle', () => {
		expect(classifyQuery('@kuttoya/').handleParam).toBe('kuttoya');
		expect(classifyQuery('@kuttoya?x=1').handleParam).toBe('kuttoya');
	});
});

describe('classifyQuery — social URLs per platform', () => {
	const cases: Array<[string, string, string]> = [
		// input, expected platform, expected normalized handle
		['twitter.com/kuttoya', 'twitter', 'kuttoya'],
		['https://x.com/kuttoya', 'twitter', 'kuttoya'],
		['https://mobile.twitter.com/kuttoya', 'twitter', 'kuttoya'],
		['https://bsky.app/profile/kuttoya.bsky.social', 'bluesky', 'kuttoya.bsky.social'],
		['t.me/kuttoya', 'telegram', 'kuttoya'],
		['furaffinity.net/user/kuttoya', 'furaffinity', 'kuttoya'],
		['https://www.deviantart.com/kuttoya', 'deviantart', 'kuttoya'],
		['patreon.com/kuttoya', 'patreon', 'kuttoya'],
		['patreon.com/c/kuttoya', 'patreon', 'kuttoya'],
		['instagram.com/kuttoya', 'instagram', 'kuttoya']
	];
	for (const [input, platform, handle] of cases) {
		it(`${input} → ${platform}/${handle}`, () => {
			const c = classifyQuery(input);
			expect(c.kind).toBe('handle');
			expect(c.platform).toBe(platform);
			expect(c.handle).toBe(handle);
			expect(c.handleParam).toBe(input.trim());
		});
	}

	it('is case-insensitive on the domain and strips trailing slash + query string', () => {
		expect(classifyQuery('HTTPS://Twitter.com/Kuttoya/').handle).toBe('kuttoya');
		expect(classifyQuery('twitter.com/kuttoya?ref=abc').handle).toBe('kuttoya');
	});
});

describe('classifyQuery — non-social URLs', () => {
	it('treats any pasted http(s) URL as a handle so it never becomes a name', () => {
		const c = classifyQuery('https://example.com/whoever');
		expect(c.kind).toBe('handle');
		expect(c.platform).toBeUndefined();
		expect(c.handleParam).toBe('https://example.com/whoever');
	});
});

describe('normalizeHandle', () => {
	it('normalizes patreon creator URLs without collapsing to "c"', () => {
		expect(normalizeHandle('patreon', 'https://patreon.com/c/kuttoya')).toBe('kuttoya');
	});
});
