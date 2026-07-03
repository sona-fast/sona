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

	it('treats null/empty/absent socials as equivalent', () => {
		const local = { name: 'Marrow', twitterUrl: '', blueskyUrl: null, aliases: null };
		expect(artistDiffersFromRegistry(local, reg({ socials: {} }))).toBe(false);
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
