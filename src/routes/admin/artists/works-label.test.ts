import { describe, it, expect } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { worksLabel } from './works-label';

// Normalize non-breaking spaces so assertions read as visible words.
const visible = (s: string) => s.replace(/\u00a0/g, ' ');

describe('worksLabel', () => {
	it('shows a VR avatar count for an artist with only avatar credits', () => {
		const out = visible(worksLabel({ artworkCount: 0, stickerCount: 0, avatarCount: 1 }));
		expect(out).toContain('1 VR avatar');
		expect(out).not.toContain('artwork');
		expect(out).not.toBe(m.admin_artists_no_works());
	});

	it('lists artworks, stickers, then avatars', () => {
		const out = visible(worksLabel({ artworkCount: 21, stickerCount: 2, avatarCount: 3 }));
		const artworks = out.indexOf('21 artworks');
		const stickers = out.indexOf('2 stickers');
		const avatars = out.indexOf('3 VR avatars');
		expect(artworks).toBeGreaterThanOrEqual(0);
		expect(stickers).toBeGreaterThan(artworks);
		expect(avatars).toBeGreaterThan(stickers);
	});

	it('falls back to the no-works text when every count is zero', () => {
		expect(worksLabel({ artworkCount: 0, stickerCount: 0, avatarCount: 0 })).toBe(m.admin_artists_no_works());
	});

	it('only allows a line break after a separator, never inside a segment', () => {
		const out = worksLabel({ artworkCount: 21, stickerCount: 2, avatarCount: 3 });
		// The dot never starts a line: nothing breakable sits right before it.
		expect(out).not.toContain(' ·');
		// Every ordinary space is the one that follows a separator.
		const segments = out.split('\u00a0· ');
		expect(segments).toHaveLength(3);
		for (const segment of segments) expect(segment).not.toContain(' ');
	});
});
