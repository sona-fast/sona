import { describe, it, expect } from 'vitest';
import { classifyKey, collectUsageBreakdown, type ListableBucket } from './usage-breakdown';

describe('classifyKey', () => {
	it('maps each content folder to its kind', () => {
		expect(classifyKey('artwork/abc.png')).toBe('artwork');
		expect(classifyKey('artwork/abc-thumb.webp')).toBe('artwork');
		expect(classifyKey('vr-models/abc.vrm')).toBe('vrModel');
		expect(classifyKey('stickers/pack-slug/abc.webp')).toBe('sticker');
	});

	it('splits vr-media into videos and images by the .webm extension', () => {
		expect(classifyKey('vr-media/clip.webm')).toBe('vrVideo');
		expect(classifyKey('vr-media/CLIP.WEBM')).toBe('vrVideo');
		expect(classifyKey('vr-media/poster.webp')).toBe('vrImage');
	});

	it('sends avatars, fursuit photos, strays, and folderless keys to other', () => {
		expect(classifyKey('avatars/slug/a.webp')).toBe('other');
		expect(classifyKey('fursuit/photographer/a.jpg')).toBe('other');
		expect(classifyKey('legacy-folder/a.png')).toBe('other');
		expect(classifyKey('no-folder.png')).toBe('other');
	});
});

function bucketOf(pages: { key: string; size: number }[][]): ListableBucket {
	let calls = 0;
	return {
		async list({ cursor } = {}) {
			// The cursor must round-trip: each page hands back its index.
			if (cursor !== undefined) expect(cursor).toBe(String(calls));
			const objects = pages[calls];
			calls += 1;
			return {
				objects,
				truncated: calls < pages.length,
				cursor: calls < pages.length ? String(calls) : undefined
			};
		}
	};
}

describe('collectUsageBreakdown', () => {
	it('sums bytes and counts per kind and in total', async () => {
		const breakdown = (await collectUsageBreakdown(
			bucketOf([
				[
					{ key: 'artwork/a.png', size: 100 },
					{ key: 'artwork/b.png', size: 50 },
					{ key: 'vr-media/clip.webm', size: 700 },
					{ key: 'vr-media/poster.webp', size: 30 },
					{ key: 'vr-models/model.vrm', size: 300 },
					{ key: 'stickers/pack/s1.webp', size: 10 },
					{ key: 'avatars/slug/a.webp', size: 5 },
					{ key: 'fursuit/p/a.jpg', size: 6 }
				]
			])
		))!;
		expect(breakdown.kinds.artwork).toEqual({ bytes: 150, count: 2 });
		expect(breakdown.kinds.vrVideo).toEqual({ bytes: 700, count: 1 });
		expect(breakdown.kinds.vrImage).toEqual({ bytes: 30, count: 1 });
		expect(breakdown.kinds.vrModel).toEqual({ bytes: 300, count: 1 });
		expect(breakdown.kinds.sticker).toEqual({ bytes: 10, count: 1 });
		expect(breakdown.kinds.other).toEqual({ bytes: 11, count: 2 });
		expect(breakdown.totalBytes).toBe(1201);
		expect(breakdown.totalCount).toBe(8);
		// The rows always sum to the bar total — the UI relies on this.
		const kindSum = Object.values(breakdown.kinds).reduce((sum, k) => sum + k.bytes, 0);
		expect(kindSum).toBe(breakdown.totalBytes);
	});

	it('follows the cursor across truncated pages', async () => {
		const breakdown = (await collectUsageBreakdown(
			bucketOf([
				[{ key: 'artwork/a.png', size: 1 }],
				[{ key: 'artwork/b.png', size: 2 }],
				[{ key: 'stickers/p/c.webp', size: 4 }]
			])
		))!;
		expect(breakdown.kinds.artwork).toEqual({ bytes: 3, count: 2 });
		expect(breakdown.kinds.sticker).toEqual({ bytes: 4, count: 1 });
		expect(breakdown.totalCount).toBe(3);
	});

	it('returns all-zero kinds for an empty bucket', async () => {
		const breakdown = (await collectUsageBreakdown(bucketOf([[]])))!;
		expect(breakdown.totalBytes).toBe(0);
		expect(breakdown.totalCount).toBe(0);
		expect(breakdown.kinds.vrVideo).toEqual({ bytes: 0, count: 0 });
	});

	it('yields null for a bucket still truncated past the page cap', async () => {
		// An endless bucket: every page truncated. A partial breakdown would
		// misstate every share, so the cap degrades to null (aggregate bar).
		let calls = 0;
		const endless: ListableBucket = {
			async list() {
				calls += 1;
				return {
					objects: [{ key: 'artwork/a.png', size: 1 }],
					truncated: true,
					cursor: String(calls)
				};
			}
		};
		expect(await collectUsageBreakdown(endless, 3)).toBeNull();
		expect(calls).toBe(3); // stops listing at the cap, no runaway loop

		// The default cap is bounded too (50 pages).
		calls = 0;
		expect(await collectUsageBreakdown(endless)).toBeNull();
		expect(calls).toBe(50);
	});
});
