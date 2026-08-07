import { describe, it, expect } from 'vitest';
import { normalizeHandle, normalizeSocialUrl } from './handle-normalize';

describe('normalizeSocialUrl', () => {
	it('builds the canonical profile URL from a bare handle per platform', () => {
		expect(normalizeSocialUrl('twitter', 'taro')).toBe('https://twitter.com/taro');
		expect(normalizeSocialUrl('bluesky', 'taro')).toBe('https://bsky.app/profile/taro');
		expect(normalizeSocialUrl('telegram', 'taro')).toBe('https://t.me/taro');
		expect(normalizeSocialUrl('furaffinity', 'taro')).toBe('https://www.furaffinity.net/user/taro');
		expect(normalizeSocialUrl('furtrack', 'taro')).toBe('https://www.furtrack.com/user/taro');
		expect(normalizeSocialUrl('deviantart', 'taro')).toBe('https://www.deviantart.com/taro');
		expect(normalizeSocialUrl('patreon', 'taro')).toBe('https://www.patreon.com/taro');
		expect(normalizeSocialUrl('instagram', 'taro')).toBe('https://www.instagram.com/taro');
	});

	it('strips a leading @ from a bare handle', () => {
		expect(normalizeSocialUrl('twitter', '@taro')).toBe('https://twitter.com/taro');
		expect(normalizeSocialUrl('instagram', '@@taro')).toBe('https://www.instagram.com/taro');
	});

	it('trims surrounding whitespace before deciding', () => {
		expect(normalizeSocialUrl('twitter', '  taro  ')).toBe('https://twitter.com/taro');
	});

	it('passes a full profile URL through unchanged', () => {
		expect(normalizeSocialUrl('twitter', 'https://twitter.com/taro')).toBe(
			'https://twitter.com/taro'
		);
		expect(normalizeSocialUrl('bluesky', 'https://bsky.app/profile/taro.bsky.social')).toBe(
			'https://bsky.app/profile/taro.bsky.social'
		);
	});

	it('treats a scheme-less domain / path input as a URL, not a handle', () => {
		expect(normalizeSocialUrl('twitter', 'twitter.com/taro')).toBe('https://twitter.com/taro');
		expect(normalizeSocialUrl('twitter', 'x.com/taro')).toBe('https://x.com/taro');
		expect(normalizeSocialUrl('telegram', 't.me/taro')).toBe('https://t.me/taro');
	});

	it('treats a bare Bluesky handle (name.bsky.social) as a handle, not a URL', () => {
		expect(normalizeSocialUrl('bluesky', 'name.bsky.social')).toBe(
			'https://bsky.app/profile/name.bsky.social'
		);
		expect(normalizeSocialUrl('bluesky', '@custom.domain.dev')).toBe(
			'https://bsky.app/profile/custom.domain.dev'
		);
	});

	it('returns empty for empty/blank input', () => {
		expect(normalizeSocialUrl('twitter', '')).toBe('');
		expect(normalizeSocialUrl('twitter', '   ')).toBe('');
		expect(normalizeSocialUrl('twitter', null)).toBe('');
		expect(normalizeSocialUrl('twitter', undefined)).toBe('');
	});

	it('does not turn a junk handle into a bogus URL', () => {
		expect(normalizeSocialUrl('twitter', 'has spaces')).toBe('');
		expect(normalizeSocialUrl('twitter', 'no@t a handle!')).toBe('');
	});

	it('rejects dangerous schemes rather than building a link', () => {
		expect(normalizeSocialUrl('twitter', 'javascript:alert(1)')).toBe('');
		expect(normalizeSocialUrl('twitter', 'data:text/html,x')).toBe('');
		expect(normalizeSocialUrl('twitter', 'JavaScript:alert(1)')).toBe('');
	});

	it('rejects a scheme hidden behind a leading control character', () => {
		// The denylist above is a local copy of sanitizeUrl's, so it has to run on the
		// same stripped string: a C0 character is not whitespace and survives trim(),
		// which is how '<NUL>javascript:' walks past a check that only sees 'j'.
		expect(normalizeSocialUrl('twitter', '\u0000javascript:alert(1)')).toBe('');
		expect(normalizeSocialUrl('twitter', '\u0000  javascript:alert(1)')).toBe('');
		expect(normalizeSocialUrl('twitter', 'java\u0000script:alert(1)')).toBe('');
		// Strips before deciding, exactly as sanitizeUrl does — this is the visible
		// half of the change, since the three rejections above were already reached
		// (by a longer route) through the bare-handle character check.
		expect(normalizeSocialUrl('twitter', 'ta\u0000ro')).toBe('https://twitter.com/taro');
	});
});

// The regression this guards: Patreon's newer creator URLs are 'patreon.com/c/<user>'.
// If the bare 'patreon.com/' prefix is checked first, the handle collapses to 'c', so
// 'patreon.com/c/<user>' must be tried before 'patreon.com/'.

describe('normalizeHandle (patreon)', () => {
	it('extracts the handle from a bare patreon.com URL', () => {
		expect(normalizeHandle('patreon', 'https://patreon.com/sparky')).toBe('sparky');
		expect(normalizeHandle('patreon', 'www.patreon.com/sparky')).toBe('sparky');
	});

	it('extracts the handle from a patreon.com/c/ creator URL', () => {
		expect(normalizeHandle('patreon', 'https://patreon.com/c/sparky')).toBe('sparky');
		expect(normalizeHandle('patreon', 'patreon.com/c/sparky/')).toBe('sparky');
	});
});
