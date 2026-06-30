import { describe, it, expect } from 'vitest';
import { containsEmoji, emojiForKeyword } from './emoji-keywords';

// containsEmoji decides glyph-vs-keyword for sticker search. The regression it
// guards: text-presentation emoji (❤️ via U+2764+VS16, ☺️, ✌️, ⚡) are NOT
// Emoji_Presentation, so the original regex returned false for them and the
// "most-used" chip rail (which surfaces ❤️) silently matched nothing.

describe('containsEmoji', () => {
	it('detects emoji-presentation glyphs', () => {
		expect(containsEmoji('😀')).toBe(true);
		expect(containsEmoji('🔥')).toBe(true);
	});

	it('detects text-presentation glyphs (the bug class)', () => {
		expect(containsEmoji('❤️')).toBe(true);
		expect(containsEmoji('✌️')).toBe(true);
		expect(containsEmoji('⚡')).toBe(true);
	});

	it('is false for plain keyword text', () => {
		expect(containsEmoji('heart')).toBe(false);
		expect(containsEmoji('fire')).toBe(false);
		expect(containsEmoji('')).toBe(false);
	});
});

describe('emojiForKeyword', () => {
	it('maps a keyword to glyphs that include the obvious match', () => {
		const fire = emojiForKeyword('fire');
		expect(fire).toContain('🔥');
	});

	it('matches by prefix (heart → hearts/heartbeat keywords)', () => {
		const heart = emojiForKeyword('heart');
		// At least one heart glyph should surface.
		expect(heart.some((g) => /[❤\u{1F495}-\u{1F49F}]/u.test(g))).toBe(true);
	});

	it('returns [] for an empty query', () => {
		expect(emojiForKeyword('')).toEqual([]);
		expect(emojiForKeyword('   ')).toEqual([]);
	});

	it('returns [] for a nonsense keyword (drives the no-match empty state)', () => {
		expect(emojiForKeyword('zzqqxnotanemoji')).toEqual([]);
	});

	it('intersects multi-word queries (narrows, not widens)', () => {
		const single = emojiForKeyword('face');
		const multi = emojiForKeyword('grinning face');
		// Adding a word can only narrow the set.
		expect(multi.length).toBeLessThanOrEqual(single.length);
	});
});
