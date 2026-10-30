import { describe, it, expect, afterEach } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { setLocale, baseLocale } from '$lib/paraglide/runtime';
import { worksLabel, deleteBlockersLabel } from './works-label';

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

describe('deleteBlockersLabel', () => {
	const none = { artworkCount: 0, stickerCount: 0, avatarCount: 0, managedPackCount: 0, commissionCount: 0 };

	afterEach(() => setLocale(baseLocale, { reload: false }));

	it('returns null when nothing blocks the delete', () => {
		expect(deleteBlockersLabel(none)).toBeNull();
	});

	// Each blocker alone is enough. Managed packs and ledger entries never show in
	// the Works column, so this label is the only place they surface.
	it.each([
		['artworkCount', 'Can\'t delete: 1 artwork. Remove them first.'],
		['stickerCount', 'Can\'t delete: 1 sticker. Remove them first.'],
		['avatarCount', 'Can\'t delete: 1 VR avatar. Remove them first.'],
		['managedPackCount', 'Can\'t delete: 1 sticker pack. Remove them first.'],
		['commissionCount', 'Can\'t delete: 1 ledger entry. Remove them first.']
	] as const)('names %s alone', (key, expected) => {
		expect(deleteBlockersLabel({ ...none, [key]: 1 })).toBe(expected);
	});

	it('pluralizes each count', () => {
		const out = deleteBlockersLabel({ ...none, managedPackCount: 3, commissionCount: 2 });
		expect(out).toBe("Can't delete: 3 sticker packs and 2 ledger entries. Remove them first.");
	});

	it('lists only the non-zero blockers, in the delete action\'s order', () => {
		const out = deleteBlockersLabel({ artworkCount: 4, stickerCount: 0, avatarCount: 2, managedPackCount: 0, commissionCount: 1 });
		expect(out).toBe("Can't delete: 4 artworks, 2 VR avatars, and 1 ledger entry. Remove them first.");
		expect(out).not.toMatch(/\b0 /);
	});

	it('reads in Japanese with the Japanese list separator', () => {
		setLocale('ja', { reload: false });
		const out = deleteBlockersLabel({ ...none, managedPackCount: 1, commissionCount: 2 });
		expect(out).toBe('削除できません。ステッカーパック 1件、制作依頼の記録 2件が残っています。先にこれらを外してください。');
	});
});
