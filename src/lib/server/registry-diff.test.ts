import { describe, it, expect } from 'vitest';
import { artistDiffersFromRegistry, registryDiffFields } from './registry-diff';
import type { RegistryArtist } from './registry';

function reg(partial: Partial<RegistryArtist>): RegistryArtist {
	return {
		globalId: 'g1',
		displayName: 'Marrow',
		avatarUrl: null,
		bio: null,
		socials: {},
		status: 'active',
		mergedInto: null,
		version: 1,
		updatedAt: '2026-01-01T00:00:00Z',
		...partial
	};
}

describe('registryDiffFields / artistDiffersFromRegistry', () => {
	it('is empty when name + socials + aliases match (up to date)', () => {
		const local = { name: 'Marrow', twitterUrl: 'https://x.com/marrow', aliases: null };
		const r = reg({ displayName: 'Marrow', socials: { twitterUrl: 'https://twitter.com/Marrow/' } });
		expect(registryDiffFields(local, r)).toEqual([]);
		expect(artistDiffersFromRegistry(local, r)).toBe(false);
	});

	it('treats x.com vs twitter.com, trailing slash, @ and whitespace as noise', () => {
		const local = { name: '  Marrow  ', twitterUrl: '@Marrow', aliases: null };
		const r = reg({ socials: { twitterUrl: 'https://x.com/marrow' } });
		expect(artistDiffersFromRegistry(local, r)).toBe(false);
	});

	it('detects a name change', () => {
		const local = { name: 'Marrow Prime', aliases: null };
		expect(registryDiffFields(local, reg({ displayName: 'Marrow' }))).toEqual(['displayName']);
	});

	it('detects an added, changed, and removed social handle', () => {
		const local = { name: 'Marrow', twitterUrl: 'https://x.com/b', blueskyUrl: 'https://bsky.app/profile/new.bsky.social', aliases: null };
		const r = reg({ socials: { twitterUrl: 'https://x.com/a', telegramUrl: 'https://t.me/gone' } });
		// Emitted in SOCIAL_URL_KEYS order: twitter, bluesky, telegram, …
		expect(registryDiffFields(local, r)).toEqual([
			'socials.twitterUrl', // x.com/a -> x.com/b
			'socials.blueskyUrl', // added
			'socials.telegramUrl' // removed
		]);
	});

	it('detects an added or changed social link that names no handle', () => {
		// patreon.com/user?u=<id> normalizes to no handle; comparing only handles
		// read an added or changed one as unchanged and hid it from submission.
		const added = { name: 'Marrow', patreonUrl: 'https://www.patreon.com/user?u=1', aliases: null };
		expect(registryDiffFields(added, reg({ socials: {} }))).toEqual(['socials.patreonUrl']);
		const changed = reg({ socials: { patreonUrl: 'https://www.patreon.com/user?u=2' } });
		expect(registryDiffFields(added, changed)).toEqual(['socials.patreonUrl']);
		const same = reg({ socials: { patreonUrl: 'https://www.patreon.com/user?u=1' } });
		expect(artistDiffersFromRegistry(added, same)).toBe(false);
	});

	it('treats spelling variants of a link that names no handle as the same link', () => {
		const local = { name: 'Marrow', patreonUrl: 'https://www.patreon.com/user?u=5', aliases: null };
		expect(artistDiffersFromRegistry(local, reg({ socials: { patreonUrl: 'patreon.com/user?u=5/' } }))).toBe(false);
		expect(artistDiffersFromRegistry(local, reg({ socials: { patreonUrl: 'HTTP://PATREON.COM/user?u=5' } }))).toBe(false);
		expect(artistDiffersFromRegistry(local, reg({ socials: { patreonUrl: '//patreon.com/user?u=5' } }))).toBe(false);
	});

	it('still detects a changed or added link that names no handle after canonicalizing', () => {
		const one = { name: 'Marrow', patreonUrl: 'patreon.com/user?u=1', aliases: null };
		expect(artistDiffersFromRegistry(one, reg({ socials: { patreonUrl: 'patreon.com/user?u=2' } }))).toBe(true);
		const added = { name: 'Marrow', patreonUrl: 'https://www.patreon.com/user?u=5', aliases: null };
		expect(artistDiffersFromRegistry(added, reg({ socials: {} }))).toBe(true);
	});

	it('keeps the raw-link fallback to patreon.com links, so other values compare by handle alone', () => {
		// These compare exactly as they did before the fallback existed: each
		// side's normalized handle, and nothing else.
		const bsky = { name: 'Marrow', blueskyUrl: 'https://sparky.bsky.social', aliases: null };
		expect(registryDiffFields(bsky, reg({ socials: { blueskyUrl: 'sparky.bsky.social' } }))).toEqual([]);
		const tw = { name: 'Marrow', twitterUrl: 'www.sparkyfen', aliases: null };
		expect(registryDiffFields(tw, reg({ socials: { twitterUrl: 'sparkyfen' } }))).toEqual([]);
		// A link on the wrong host: both sides normalize to the same non-handle,
		// and the fallback must not start telling the two links apart.
		const wrongHost = { name: 'Marrow', twitterUrl: 'https://instagram.com/a', aliases: null };
		expect(registryDiffFields(wrongHost, reg({ socials: { twitterUrl: 'https://instagram.com/b' } }))).toEqual([]);
		// A non-Patreon site-segment link reads as a plain handle, as on main:
		// two sticker-pack links both compare as 'addstickers', not as two links.
		const pack = { name: 'Marrow', telegramUrl: 'https://t.me/addstickers/PackA', aliases: null };
		expect(registryDiffFields(pack, reg({ socials: { telegramUrl: 'https://t.me/addstickers/PackB' } }))).toEqual([]);
		// A Patreon value on another host normalizes to that host as its handle
		// (here 'example.com' on both sides), so it compares by handle and never
		// reaches the patreon.com check. The blank-value cases in the null/empty
		// test below are what exercise that check.
		const offHost = { name: 'Marrow', patreonUrl: 'https://example.com/user?u=1', aliases: null };
		expect(registryDiffFields(offHost, reg({ socials: { patreonUrl: 'https://example.com/user?u=2' } }))).toEqual([]);
	});

	it('shows a removed or added non-Patreon site-segment link as a change', () => {
		// Only Patreon segments are reserved, matching the registry, so these keep
		// their plain handle ('p', 'joinchat') and never compare equal to absent.
		const cleared = { name: 'Marrow', instagramUrl: null, aliases: null };
		expect(registryDiffFields(cleared, reg({ socials: { instagramUrl: 'https://instagram.com/p/abc' } }))).toEqual([
			'socials.instagramUrl'
		]);
		const added = { name: 'Marrow', telegramUrl: 'https://t.me/joinchat/xyz', aliases: null };
		expect(registryDiffFields(added, reg({ socials: {} }))).toEqual(['socials.telegramUrl']);
	});

	it('treats an alias link that names no handle, spelled two ways, as equal', () => {
		const local = {
			name: 'Marrow',
			aliases: JSON.stringify([{ displayName: 'B', socials: { patreonUrl: 'https://www.patreon.com/user?u=5' } }])
		};
		const r = reg({ aliases: [{ displayName: 'B', socials: { patreonUrl: 'patreon.com/user?u=5/' } }] });
		expect(artistDiffersFromRegistry(local, r)).toBe(false);
		const other = reg({ aliases: [{ displayName: 'B', socials: { patreonUrl: 'patreon.com/user?u=6' } }] });
		expect(artistDiffersFromRegistry(local, other)).toBe(true);
	});

	it('treats null/empty/absent socials as equivalent', () => {
		const local = { name: 'Marrow', twitterUrl: '', blueskyUrl: null, aliases: null };
		expect(artistDiffersFromRegistry(local, reg({ socials: {} }))).toBe(false);
		// A blank Patreon value names no handle and is not a patreon.com link, so
		// it must not fall back to a raw-link comparison and differ from absent.
		expect(registryDiffFields({ name: 'Marrow', patreonUrl: '' }, reg({ socials: {} }))).toEqual([]);
		expect(registryDiffFields({ name: 'Marrow', patreonUrl: '   ' }, reg({ socials: {} }))).toEqual([]);
		expect(registryDiffFields({ name: 'Marrow', patreonUrl: null }, reg({ socials: { patreonUrl: '' } }))).toEqual([]);
	});

	it('ignores alias ordering and handle URL formatting', () => {
		const local = {
			name: 'Marrow',
			aliases: JSON.stringify([
				{ displayName: 'B', socials: { twitterUrl: 'https://x.com/b' } },
				{ displayName: 'A', socials: {} }
			])
		};
		const r = reg({
			aliases: [
				{ displayName: 'A', socials: {} },
				{ displayName: 'B', socials: { twitterUrl: 'https://twitter.com/b/' } }
			]
		});
		expect(artistDiffersFromRegistry(local, r)).toBe(false);
	});

	it('detects an alias-set change', () => {
		const local = { name: 'Marrow', aliases: JSON.stringify([{ displayName: 'Old', socials: {} }]) };
		expect(registryDiffFields(local, reg({ aliases: [] }))).toEqual(['aliases']);
	});
});
