import { describe, expect, it } from 'vitest';
import {
	MOSAIC_GAP,
	MOSAIC_ROW_PATTERNS,
	MOSAIC_TILT_DEG,
	SSR_BANNER_WIDTH,
	mosaicLayout,
	mosaicSlots,
	type MosaicLayout
} from './mosaic-layout';

// The strip is rotated about the centre of its box by the tilt; a banner
// point is covered when, mapped back into the strip's own frame, it lands on
// some cell. This walks a grid over the banner and finds every cell the same
// way the browser lays them out: rows stacked with the gap, each row's cells
// laid left to right from its (possibly negative) margin. A point that lands
// in a gap between cells counts as covered when a neighbour 8px away is on a
// cell, since the gaps are 6px and the visitor sees the background through
// them by design.
function uncoveredPoints(layout: MosaicLayout, bannerWidth: number, bannerHeight: number) {
	const height =
		layout.rows.reduce((sum, r) => sum + r.height, 0) + MOSAIC_GAP * (layout.rows.length - 1);
	const cx = layout.left + layout.stripWidth / 2;
	const cy = layout.top + height / 2;
	const rad = (MOSAIC_TILT_DEG * Math.PI) / 180;

	const cells: { x0: number; x1: number; y0: number; y1: number }[] = [];
	let y = 0;
	for (const row of layout.rows) {
		let x = row.marginLeft;
		for (const w of row.widths) {
			cells.push({ x0: x, x1: x + w, y0: y, y1: y + row.height });
			x += w + MOSAIC_GAP;
		}
		y += row.height + MOSAIC_GAP;
	}

	const onCell = (bx: number, by: number) => {
		const dx = bx - cx;
		const dy = by - cy;
		const sx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx - layout.left;
		const sy = dx * Math.sin(rad) + dy * Math.cos(rad) + cy - layout.top;
		return cells.some((c) => sx >= c.x0 && sx <= c.x1 && sy >= c.y0 && sy <= c.y1);
	};
	// Diagonals too: where a row gap crosses a cell gap, every straight
	// neighbour is still in a gap band.
	const covered = (bx: number, by: number) =>
		[0, 8, -8].some((ox) => [0, 8, -8].some((oy) => onCell(bx + ox, by + oy)));

	const bad: [number, number][] = [];
	for (let py = 1; py < bannerHeight; py += 10) {
		for (let px = 1; px < bannerWidth; px += 10) {
			if (!covered(px, py)) bad.push([px, py]);
		}
	}
	// The banner's own four corners, which the grid steps over.
	for (const [px, py] of [
		[1, bannerHeight - 1],
		[bannerWidth - 1, 1],
		[bannerWidth - 1, bannerHeight - 1]
	]) {
		if (!covered(px, py)) bad.push([px, py]);
	}
	return bad;
}

describe('mosaicLayout covers the banner', () => {
	// The bug: at 2560 the old fixed 1700px strip stopped a third of the way
	// across, and the tilt opened the top-left and bottom-right corners even
	// at 1440. Every width a desktop or ultrawide monitor produces, plus the
	// phone sizes the server-rendered rows must also cover.
	it.each([
		[1280, 600],
		[1440, 600],
		[1920, 600],
		[2560, 600],
		[3440, 600],
		[3840, 600],
		[5120, 600]
	])('leaves no exposed background at %ix%i', (w, h) => {
		expect(uncoveredPoints(mosaicLayout(w, h), w, h)).toEqual([]);
	});

	it('the server layout also covers every narrower desktop banner', () => {
		const ssr = mosaicLayout();
		for (const w of [1024, 1280, 1366, 1440, 1536, 1680, 1920]) {
			expect(uncoveredPoints(ssr, w, 600), `at ${w}`).toEqual([]);
		}
	});

	it('every row reaches the strip’s right edge and starts at or left of its left edge', () => {
		for (const w of [1920, 2560, 3840]) {
			const layout = mosaicLayout(w, 600);
			for (const row of layout.rows) {
				const span =
					row.marginLeft +
					row.widths.reduce((s, x) => s + x, 0) +
					MOSAIC_GAP * (row.widths.length - 1);
				expect(span).toBeGreaterThanOrEqual(layout.stripWidth);
				expect(row.marginLeft).toBeLessThanOrEqual(0);
			}
		}
	});

	it('keeps the mockup’s stagger: a padded row’s first pattern cell starts at padLeft', () => {
		const layout = mosaicLayout();
		layout.rows.forEach((row, idx) => {
			const pattern = MOSAIC_ROW_PATTERNS[idx % MOSAIC_ROW_PATTERNS.length];
			if (pattern.padLeft === 0) {
				expect(row.marginLeft).toBe(0);
				expect(row.widths.slice(0, pattern.widths.length)).toEqual(pattern.widths);
			} else {
				// One lead cell, then the pattern; the lead ends one gap before padLeft.
				expect(row.marginLeft + row.widths[0] + MOSAIC_GAP).toBe(pattern.padLeft);
				expect(row.widths.slice(1, 1 + pattern.widths.length)).toEqual(pattern.widths);
			}
		});
	});

	it('is monotone: a wider banner never gets a smaller strip or fewer rows', () => {
		let prev = mosaicLayout(1280, 600);
		for (let w = 1300; w <= 5200; w += 100) {
			const next = mosaicLayout(w, 600);
			expect(next.stripWidth).toBeGreaterThanOrEqual(prev.stripWidth);
			expect(next.rows.length).toBeGreaterThanOrEqual(prev.rows.length);
			expect(next.top).toBeLessThanOrEqual(prev.top);
			prev = next;
		}
	});

	it('defaults to the server width so SSR and a client at that width agree', () => {
		expect(mosaicLayout()).toEqual(mosaicLayout(SSR_BANNER_WIDTH, 600));
	});
});

describe('mosaicSlots', () => {
	it('fills every cell, cycling through the images', () => {
		const layout = mosaicLayout(2560, 600);
		const images = ['a', 'b', 'c'];
		const slots = mosaicSlots(images, layout.rows);
		expect(slots).toHaveLength(layout.rows.length);
		slots.forEach((row, idx) => {
			expect(row).toHaveLength(layout.rows[idx].widths.length);
			for (const img of row) expect(images).toContain(img);
		});
	});

	it('yields empty rows when there are no images', () => {
		const layout = mosaicLayout();
		expect(mosaicSlots([], layout.rows)).toEqual(layout.rows.map(() => []));
	});
});
