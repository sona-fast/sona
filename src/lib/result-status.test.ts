import { describe, expect, it } from 'vitest';
import { galleryStatus, packStatus, statusList, stickersStatus } from './result-status';

const en = { locale: 'en' } as const;
const ja = { locale: 'ja' } as const;

const artwork = { view: 'artwork', count: 3, search: '', tag: '', artist: '', character: '', sort: 'newest' } as const;
const fursuit = { view: 'fursuit', count: 5, photographer: '', event: '' } as const;

describe('statusList', () => {
	it('joins with a comma in English and 、 in Japanese', () => {
		expect(statusList(['a', 'b', 'c'], en)).toBe('a, b, c');
		expect(statusList(['a', 'b', 'c'], ja)).toBe('a、b、c');
	});
});

describe('galleryStatus', () => {
	it('reads the count and the sort with no filters', () => {
		expect(galleryStatus(artwork, en)).toBe('3 artworks, Sort by: Newest upload');
		expect(galleryStatus({ ...artwork, count: 1, sort: 'commissioned-oldest' }, en)).toBe(
			'1 artwork, Sort by: Oldest commissioned'
		);
	});

	it('names every active artwork filter, in order, before the sort', () => {
		expect(
			galleryStatus(
				{ ...artwork, search: 'fox', tag: 'reference', artist: 'Alice', character: 'Sparky', sort: 'oldest' },
				en
			)
		).toBe('3 artworks, Search: fox, Tag: reference, Artist: Alice, Character: Sparky, Sort by: Oldest upload');
	});

	it('reads the fursuit count alone, with no sort', () => {
		expect(galleryStatus(fursuit, en)).toBe('5 fursuit photos');
		expect(galleryStatus({ ...fursuit, count: 1 }, en)).toBe('1 fursuit photo');
	});

	it('names the fursuit photographer and event', () => {
		expect(galleryStatus({ ...fursuit, photographer: 'Bob' }, en)).toBe('5 fursuit photos, Photographer: Bob');
		expect(galleryStatus({ ...fursuit, event: 'FWA' }, en)).toBe('5 fursuit photos, Event: FWA');
		expect(galleryStatus({ ...fursuit, photographer: 'Bob', event: 'FWA' }, en)).toBe(
			'5 fursuit photos, Photographer: Bob, Event: FWA'
		);
	});

	it('reads in Japanese', () => {
		expect(galleryStatus({ ...artwork, tag: 'reference', sort: 'oldest' }, ja)).toBe(
			'作品 3件、タグ：reference、並び順：古い順'
		);
		expect(galleryStatus({ ...artwork, search: 'fox' }, ja)).toBe('作品 3件、検索：fox、並び順：新しい順');
		expect(galleryStatus({ ...fursuit, photographer: 'Bob', event: 'FWA' }, ja)).toBe(
			'着ぐるみ写真 5件、撮影者：Bob、イベント：FWA'
		);
	});

	it('announces a failed load instead of an empty result when degraded', () => {
		const failed = "The gallery couldn't load. Try again in a moment.";
		expect(galleryStatus({ ...artwork, count: 0, tag: 'reference', degraded: true }, en)).toBe(failed);
		expect(galleryStatus({ ...fursuit, count: 0, degraded: true }, en)).toBe(failed);
		expect(galleryStatus({ ...artwork, count: 0, degraded: true }, ja)).toBe(
			'ギャラリーを読み込めませんでした。しばらくしてからもう一度お試しください。'
		);
		expect(galleryStatus({ ...artwork, count: 0, degraded: false }, en)).toBe('0 artworks, Sort by: Newest upload');
	});
});

describe('stickersStatus', () => {
	it('reads the pack count unfiltered', () => {
		expect(stickersStatus({ filtered: false, packs: 1 }, en)).toBe('1 sticker pack');
		expect(stickersStatus({ filtered: false, packs: 4 }, en)).toBe('4 sticker packs');
	});

	it('labels the emoji and reads a single pack in the singular', () => {
		expect(stickersStatus({ filtered: true, stickers: 1, emoji: '🦊', artist: '', packs: 1 }, en)).toBe(
			'1 sticker, Emoji: 🦊, in 1 pack'
		);
		expect(stickersStatus({ filtered: true, stickers: 4, emoji: '🦊', artist: '', packs: 2 }, en)).toBe(
			'4 stickers, Emoji: 🦊, across 2 packs'
		);
	});

	it('labels a keyword query the same way', () => {
		expect(stickersStatus({ filtered: true, stickers: 3, emoji: 'fox', artist: '', packs: 2 }, en)).toBe(
			'3 stickers, Emoji: fox, across 2 packs'
		);
	});

	it('names the artist', () => {
		expect(stickersStatus({ filtered: true, stickers: 2, emoji: '', artist: 'Alice', packs: 1 }, en)).toBe(
			'2 stickers, Artist: Alice, in 1 pack'
		);
	});

	it('reads in Japanese', () => {
		expect(stickersStatus({ filtered: false, packs: 2 }, ja)).toBe('ステッカーセット 2件');
		expect(stickersStatus({ filtered: true, stickers: 3, emoji: '🦊', artist: 'Alice', packs: 2 }, ja)).toBe(
			'ステッカー 3件、絵文字：🦊、アーティスト：Alice、2セットにわたって'
		);
	});

	it('reads a single pack correctly in Japanese', () => {
		expect(stickersStatus({ filtered: true, stickers: 1, emoji: '🦊', artist: '', packs: 1 }, ja)).toBe(
			'ステッカー 1件、絵文字：🦊、1セット内'
		);
		expect(stickersStatus({ filtered: true, stickers: 4, emoji: '🦊', artist: '', packs: 2 }, ja)).toBe(
			'ステッカー 4件、絵文字：🦊、2セットにわたって'
		);
	});
});

describe('packStatus', () => {
	it('reads the count alone unfiltered', () => {
		expect(packStatus({ stickers: 2, emoji: '', artists: [] }, en)).toBe('2 stickers');
	});

	it('labels the emoji', () => {
		expect(packStatus({ stickers: 1, emoji: '🎉', artists: [] }, en)).toBe('1 sticker, Emoji: 🎉');
	});

	it('names one artist, two artists, and the Unassigned group', () => {
		expect(packStatus({ stickers: 2, emoji: '', artists: ['Alice'] }, en)).toBe('2 stickers, Artist: Alice');
		expect(packStatus({ stickers: 4, emoji: '', artists: ['Alice', 'Bob'] }, en)).toBe(
			'4 stickers, Artist: Alice / Bob'
		);
		expect(packStatus({ stickers: 1, emoji: '', artists: [null] }, en)).toBe('1 sticker, Artist: Unassigned');
	});

	it('localizes Unassigned in Japanese', () => {
		expect(packStatus({ stickers: 3, emoji: '🦊', artists: ['Alice', null] }, ja)).toBe(
			'ステッカー 3件、絵文字：🦊、アーティスト：Alice / 未割り当て'
		);
	});

	it('keeps three artists in one value, after the emoji', () => {
		const artists = ['Alice', 'Bob', 'Carol'];
		expect(packStatus({ stickers: 5, emoji: '🦊', artists }, en)).toBe(
			'5 stickers, Emoji: 🦊, Artist: Alice / Bob / Carol'
		);
		expect(packStatus({ stickers: 5, emoji: '🦊', artists }, ja)).toBe(
			'ステッカー 5件、絵文字：🦊、アーティスト：Alice / Bob / Carol'
		);
	});
});
