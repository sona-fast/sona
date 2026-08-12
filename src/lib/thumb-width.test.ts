import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { THUMB_WIDTH } from './img';

// Source-pin for the ONE width every gallery-row thumbnail is transformed at
// (the cover-picker-square.test.ts precedent: markup facts no runtime test
// covers, guarded by reading the source).
//
// Two separate regressions are in scope, and they fail differently:
//
//  1. A picker going back to a RAW original src. That is what shipped before:
//     with thumbnail_url null on every row (nothing populates it), the
//     `thumbnailUrl || imageUrl` fallback served full-size originals — 141 of
//     them on a real site, up to 64 MP. Firefox paints a partially-downloaded
//     image as the rows decoded so far, so every picker cell showed the top
//     slice of its image for as long as the download ran.
//
//  2. A call site picking its OWN width. A transform URL is its own cache key,
//     so a second width means a second Image Transformation for every image —
//     against a plan that allows 5000 unique ones. Sharing the width is what
//     makes these pickers free: the variants already exist from the gallery.
//
// Hence the two-sided assertion: the pickers must pass THUMB_WIDTH, and
// THUMB_WIDTH must still equal what the gallery and admin list actually emit.
// Changing the gallery's width alone fails here rather than silently doubling
// the transformation spend.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Widths in `cdnImage(<anything>, <width>)` calls, as written in the source. */
function cdnImageWidths(src: string): number[] {
	return [...src.matchAll(/cdnImage\((?:[^()]|\([^()]*\))*?,\s*(\d+)\s*\)/g)].map((m) =>
		Number(m[1])
	);
}

describe('shared thumbnail width', () => {
	const gallery = read('../routes/(public)/gallery/+page.svelte');
	const adminImages = read('../routes/admin/images/+page.svelte');

	it('matches the width the public gallery grid emits', () => {
		// The gallery grid is the surface that generates these variants first;
		// THUMB_WIDTH exists to ride its cache.
		expect(cdnImageWidths(gallery)).toContain(THUMB_WIDTH);
	});

	it('matches the width the admin image list emits', () => {
		expect(cdnImageWidths(adminImages)).toContain(THUMB_WIDTH);
	});
});

describe('picker thumbnails go through the shared transform', () => {
	const cases = [
		{ name: 'VR poster picker', src: read('./components/VrAvatarForm.svelte'), count: 2 },
		{ name: 'collections cover picker', src: read('../routes/admin/collections/+page.svelte'), count: 2 }
	];

	for (const { name, src, count } of cases) {
		it(`${name}: transforms at the shared width, not a literal`, () => {
			const calls = [...src.matchAll(/cdnImage\((?:[^()]|\([^()]*\))*?,\s*([A-Za-z_$][\w$]*|\d+)\s*\)/g)].map(
				(m) => m[1]
			);
			expect(calls).toHaveLength(count);
			// A hardcoded 200 would work today and silently drift from the gallery
			// tomorrow — the point is the shared symbol.
			expect(calls.every((w) => w === 'THUMB_WIDTH')).toBe(true);
		});

		it(`${name}: never renders a bare original as the img src`, () => {
			// The pre-fix shape, in either picker's vocabulary. `use:rawFallback`
			// legitimately carries the raw URL, so only src= is checked.
			const bareSrc = /src=\{\s*(?:img\.thumbnailUrl \|\| img\.imageUrl|posterImage\.thumbnailUrl \|\| posterImage\.imageUrl|img\.imageUrl|editCoverUrl)\s*\}/;
			expect(src).not.toMatch(bareSrc);
		});

		it(`${name}: keeps a raw fallback for off-zone sources`, () => {
			// UploadThing-backed forks 403 the transform; without this the picker
			// would render nothing at all on those sites.
			expect(src).toMatch(/use:rawFallback=/);
		});
	}
});
