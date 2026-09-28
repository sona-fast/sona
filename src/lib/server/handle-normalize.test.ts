import { describe, it, expect } from 'vitest';
import { handlesOverlap, normalizeHandle, normalizeSocialUrl } from './handle-normalize';

describe('normalizeSocialUrl', () => {
	it('builds the canonical profile URL from a bare handle per platform', () => {
		expect(normalizeSocialUrl('twitter', 'sona.e2e.example')).toBe('https://twitter.com/sona.e2e.example');
		expect(normalizeSocialUrl('bluesky', 'sona.e2e.example')).toBe('https://bsky.app/profile/sona.e2e.example');
		expect(normalizeSocialUrl('telegram', 'sona.e2e.example')).toBe('https://t.me/sona.e2e.example');
		expect(normalizeSocialUrl('furaffinity', 'sona.e2e.example')).toBe('https://www.furaffinity.net/user/sona.e2e.example');
		expect(normalizeSocialUrl('furtrack', 'sona.e2e.example')).toBe('https://www.furtrack.com/user/sona.e2e.example');
		expect(normalizeSocialUrl('deviantart', 'sona.e2e.example')).toBe('https://www.deviantart.com/sona.e2e.example');
		expect(normalizeSocialUrl('patreon', 'sona.e2e.example')).toBe('https://www.patreon.com/sona.e2e.example');
		expect(normalizeSocialUrl('instagram', 'sona.e2e.example')).toBe('https://www.instagram.com/sona.e2e.example');
	});

	it('strips a leading @ from a bare handle', () => {
		expect(normalizeSocialUrl('twitter', '@sona.e2e.example')).toBe('https://twitter.com/sona.e2e.example');
		expect(normalizeSocialUrl('instagram', '@@sona.e2e.example')).toBe('https://www.instagram.com/sona.e2e.example');
	});

	it('trims surrounding whitespace before deciding', () => {
		expect(normalizeSocialUrl('twitter', '  sona.e2e.example  ')).toBe('https://twitter.com/sona.e2e.example');
	});

	it('passes a full profile URL through unchanged', () => {
		expect(normalizeSocialUrl('twitter', 'https://twitter.com/sona.e2e.example')).toBe(
			'https://twitter.com/sona.e2e.example'
		);
		expect(normalizeSocialUrl('bluesky', 'https://bsky.app/profile/sona.e2e.example.bsky.social')).toBe(
			'https://bsky.app/profile/sona.e2e.example.bsky.social'
		);
	});

	it('treats a scheme-less domain / path input as a URL, not a handle', () => {
		expect(normalizeSocialUrl('twitter', 'twitter.com/sona.e2e.example')).toBe('https://twitter.com/sona.e2e.example');
		expect(normalizeSocialUrl('twitter', 'x.com/sona.e2e.example')).toBe('https://x.com/sona.e2e.example');
		expect(normalizeSocialUrl('telegram', 't.me/sona.e2e.example')).toBe('https://t.me/sona.e2e.example');
	});

	it('keeps a legacy patreon.com/user?u= link as a URL', () => {
		expect(normalizeSocialUrl('patreon', 'https://www.patreon.com/user?u=123')).toBe(
			'https://www.patreon.com/user?u=123'
		);
		expect(normalizeSocialUrl('patreon', 'patreon.com/user?u=123')).toBe('https://patreon.com/user?u=123');
	});

	it('stores every Patreon creator URL spelling as patreon.com/<name>, casing kept', () => {
		expect(normalizeSocialUrl('patreon', 'https://www.patreon.com/cw/Bob_Art/')).toBe(
			'https://www.patreon.com/Bob_Art'
		);
		expect(normalizeSocialUrl('patreon', 'patreon.com/c/bob')).toBe('https://www.patreon.com/bob');
		expect(normalizeSocialUrl('patreon', 'https://patreon.com/bob?ref=x')).toBe('https://www.patreon.com/bob');
		expect(normalizeSocialUrl('patreon', 'www.patreon.com/cw/bob/posts')).toBe('https://www.patreon.com/bob');
		expect(normalizeSocialUrl('patreon', 'http://patreon.com/bob')).toBe('https://www.patreon.com/bob');
		expect(normalizeSocialUrl('patreon', 'bob')).toBe('https://www.patreon.com/bob');
	});

	it('leaves a Patreon link with no creator in it as sanitizeUrl returns it', () => {
		expect(normalizeSocialUrl('patreon', 'https://www.patreon.com/cw')).toBe('https://www.patreon.com/cw');
		expect(normalizeSocialUrl('patreon', 'https://www.patreon.com/posts/some-post-42')).toBe(
			'https://www.patreon.com/posts/some-post-42'
		);
	});

	it('does not rewrite a non-patreon.com URL pasted into the Patreon field', () => {
		// extractHandle alone would read "evil.example" off this as a handle.
		expect(normalizeSocialUrl('patreon', 'https://evil.example/bob')).toBe('https://evil.example/bob');
		expect(normalizeSocialUrl('patreon', 'https://notpatreon.com/bob')).toBe('https://notpatreon.com/bob');
	});

	it('does not flatten other platforms', () => {
		expect(normalizeSocialUrl('twitter', 'https://twitter.com/Bob_Art/status/1?ref=x')).toBe(
			'https://twitter.com/Bob_Art/status/1?ref=x'
		);
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
		expect(normalizeSocialUrl('twitter', 'sona\u0000.e2e.example')).toBe('https://twitter.com/sona.e2e.example');
	});
});

// The regression this guards: Patreon's newer creator URLs are 'patreon.com/c/<user>'
// and 'patreon.com/cw/<user>'. If the bare 'patreon.com/' prefix is checked first, the
// handle collapses to 'c' or 'cw', so both must be tried before 'patreon.com/'.

describe('normalizeHandle (patreon)', () => {
	it('extracts the handle from a bare patreon.com URL', () => {
		expect(normalizeHandle('patreon', 'https://patreon.com/sparky')).toBe('sparky');
		expect(normalizeHandle('patreon', 'www.patreon.com/sparky')).toBe('sparky');
	});

	it('extracts the handle from a patreon.com/c/ creator URL', () => {
		expect(normalizeHandle('patreon', 'https://patreon.com/c/sparky')).toBe('sparky');
		expect(normalizeHandle('patreon', 'patreon.com/c/sparky/')).toBe('sparky');
	});

	it('extracts the handle from a patreon.com/cw/ creator URL', () => {
		expect(normalizeHandle('patreon', 'https://www.patreon.com/cw/alice-art')).toBe('alice-art');
		expect(normalizeHandle('patreon', 'patreon.com/cw/Alice-Art/')).toBe('alice-art');
		expect(normalizeHandle('patreon', 'https://www.patreon.com/cw/bob-art/posts')).toBe('bob-art');
	});

	it('yields no handle for a link whose path names a Patreon section, not a creator', () => {
		expect(normalizeHandle('patreon', 'https://www.patreon.com/user?u=123')).toBe('');
		expect(normalizeHandle('patreon', 'https://www.patreon.com/posts/some-post-42')).toBe('');
		expect(normalizeHandle('patreon', 'https://patreon.com/cw')).toBe('');
		expect(normalizeHandle('patreon', 'https://patreon.com/c')).toBe('');
		expect(normalizeHandle('patreon', 'patreon.com/C/')).toBe('');
	});

	it('keeps a bare creator whose name starts with "cw"', () => {
		expect(normalizeHandle('patreon', 'patreon.com/cwolf')).toBe('cwolf');
	});
});

describe('handlesOverlap (patreon /cw/)', () => {
	it('does not match two different /cw/ creators', () => {
		expect(
			handlesOverlap(
				{ patreonUrl: 'https://www.patreon.com/cw/alice-art' },
				{ patreonUrl: 'https://www.patreon.com/cw/bob-art' }
			)
		).toBe(false);
	});

	it('does not match two different legacy user?u= links', () => {
		// Both used to normalize to the handle 'user' and read as one creator.
		expect(
			handlesOverlap(
				{ patreonUrl: 'https://www.patreon.com/user?u=1' },
				{ patreonUrl: 'https://www.patreon.com/user?u=2' }
			)
		).toBe(false);
	});

	it('does not match two different /posts/ links', () => {
		expect(
			handlesOverlap(
				{ patreonUrl: 'https://www.patreon.com/posts/first-post-1' },
				{ patreonUrl: 'https://www.patreon.com/posts/second-post-2' }
			)
		).toBe(false);
	});

	it('matches the same /cw/ creator across spellings', () => {
		expect(
			handlesOverlap(
				{ patreonUrl: 'https://www.patreon.com/cw/bob-art' },
				{ patreonUrl: 'patreon.com/cw/Bob-Art/' }
			)
		).toBe(true);
	});
});

// The reserved-segment check covers Patreon only. Other platforms' site
// segments are left as main had them (read as a plain handle) to stay in step
// with the registry, whose normalize reserves only Patreon segments.
describe('normalizeHandle (site segments on other platforms)', () => {
	it('reads a bare Telegram site path as a plain handle', () => {
		expect(normalizeHandle('telegram', 'https://t.me/s')).toBe('s');
	});

	it('reads the channel out of a Telegram t.me/s/ preview link', () => {
		expect(normalizeHandle('telegram', 't.me/s/chan')).toBe('chan');
	});

	it('reads a Twitter site path as a plain handle', () => {
		expect(normalizeHandle('twitter', 'twitter.com/home')).toBe('home');
	});
});
