import { describe, it, expect } from 'vitest';
import { parseArtistLink } from './artist-from-link';

// Paste a link (SONA-236): every row of the design doc's link-shape table,
// plus the links that must not read as one.

describe('parseArtistLink: links that name an account', () => {
	const rows: [string, string, string, string][] = [
		['an X post', 'https://x.com/Artist_B/status/1843920577201', 'twitter', 'Artist_B'],
		['a Twitter post', 'https://twitter.com/artist_b/status/1', 'twitter', 'artist_b'],
		[
			'a Bluesky post',
			'https://bsky.app/profile/artist-a.bsky.social/post/3m2kq7xv4ts2c',
			'bluesky',
			'artist-a.bsky.social'
		],
		['a Telegram channel post', 'https://t.me/artist_a/412', 'telegram', 'artist_a'],
		['a DeviantArt piece', 'https://www.deviantart.com/someuser/art/Title-123', 'deviantart', 'someuser'],
		['a Patreon creator page', 'https://www.patreon.com/cw/someuser', 'patreon', 'someuser'],
		['a link pasted without its scheme', 'x.com/artist_b/status/1', 'twitter', 'artist_b']
	];

	for (const [name, link, platform, handle] of rows) {
		it(`reads ${name} as ${platform} ${handle}`, () => {
			expect(parseArtistLink(link)).toMatchObject({ ok: true, platform, handle });
		});
	}

	it("builds the account's profile link, never the post that was pasted", () => {
		const expected: Record<string, string> = {
			'https://x.com/Artist_B/status/1843920577201': 'https://twitter.com/Artist_B',
			'https://bsky.app/profile/artist-a.bsky.social/post/3m2kq7xv4ts2c': 'https://bsky.app/profile/artist-a.bsky.social',
			'https://t.me/artist_a/412': 'https://t.me/artist_a',
			'https://www.deviantart.com/someuser/art/Title-123': 'https://www.deviantart.com/someuser',
			'https://www.patreon.com/cw/someuser': 'https://www.patreon.com/someuser'
		};
		for (const [link, profile] of Object.entries(expected)) {
			const parsed = parseArtistLink(link);
			expect(parsed, link).toMatchObject({ ok: true, profileUrl: profile });
			expect(parsed.ok && parsed.profileUrl).not.toBe(link);
			expect(parsed.ok && parsed.profileUrl, link).not.toMatch(/status|post|art\/|412/);
		}
	});
});

describe('parseArtistLink: links that name no account', () => {
	const rows: [string, string][] = [
		['a private Telegram channel message', 'https://t.me/c/123456/78'],
		['a Telegram invite', 'https://t.me/+AbCdEfGh'],
		['a FurAffinity submission', 'https://www.furaffinity.net/view/58123456/'],
		['a Patreon post', 'https://www.patreon.com/posts/title-123'],
		['an Instagram post', 'https://www.instagram.com/p/abc/'],
		// A DID names an account, but not one the owner could have stored.
		['a Bluesky post by DID', 'https://bsky.app/profile/did:plc:abc123/post/3m2']
	];
	for (const [name, link] of rows) {
		it(`says ${name} has no handle`, () => {
			expect(parseArtistLink(link)).toEqual({ ok: false, reason: 'no_handle' });
		});
	}
});

describe('parseArtistLink: what is not a link Sona reads', () => {
	it('refuses links on sites no artist field covers', () => {
		for (const link of ['https://vgen.co/artist_h', 'https://example.com/taro/status/1', 'https://x.com.evil.example/taro']) {
			expect(parseArtistLink(link), link).toEqual({ ok: false, reason: 'unsupported' });
		}
	});

	it('refuses scripts, other schemes, and text that is no link', () => {
		for (const link of [
			'javascript:alert(1)',
			'JavaScript:alert(document.cookie)',
			'data:text/html,hi',
			'ftp://x.com/taro',
			'artist g bsky',
			'',
			'   ',
			`https://x.com/${'a'.repeat(2100)}`
		]) {
			expect(parseArtistLink(link), link.slice(0, 40)).toEqual({ ok: false, reason: 'invalid' });
		}
	});
});

describe('parseArtistLink: older link shapes', () => {
	it('reads a legacy DeviantArt subdomain as the account, whatever the path', () => {
		for (const link of [
			'https://someuser.deviantart.com/art/Title-123',
			'https://someuser.deviantart.com/gallery',
			'https://someuser.deviantart.com/'
		]) {
			expect(parseArtistLink(link), link).toEqual({
				ok: true,
				platform: 'deviantart',
				handle: 'someuser',
				profileUrl: 'https://www.deviantart.com/someuser'
			});
		}
	});

	it('says a FurAffinity gallery link has no handle it reads', () => {
		// FurAffinity profiles are /user/<name>; a /gallery/<name> path isn't one
		// the artist fields store.
		expect(parseArtistLink('https://www.furaffinity.net/gallery/someuser/')).toEqual({ ok: false, reason: 'no_handle' });
	});
});
