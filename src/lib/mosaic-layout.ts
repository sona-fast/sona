// Geometry for the mosaic hero: a tilted strip of image rows that has to
// cover the whole banner however wide the viewport is.
//
// The strip is a stack of rows with fixed cell widths, rotated by
// MOSAIC_TILT_DEG about its own centre, and the banner clips it. A strip of
// fixed size covers a banner of one size: on a wider banner the rows run out
// on the right, and because the rotation lifts the right end and drops the
// left end, the top-left and bottom-right corners open up too. This module
// sizes the strip for the banner it is given: it repeats each row's cell
// pattern until the row spans the strip, then keeps adding rows (and pushing
// the strip's top edge up) until every corner of the banner sits inside the
// rotated strip. Both rectangles are convex, so checking the banner's four
// corners is enough.
//
// The server does not know the viewport, so it lays out for SSR_BANNER_WIDTH,
// which also covers every narrower banner, and the stylesheet carries the
// same numbers. The component overrides them only on a client whose banner
// turns out wider than that.

export interface MosaicRowPattern {
	height: number;
	/** How far the row's first cell starts in from the strip's left edge. */
	padLeft: number;
	widths: number[];
}

export interface MosaicRow {
	height: number;
	/** Negative: the row starts left of the strip so the stagger leaves no hole. */
	marginLeft: number;
	widths: number[];
}

export interface MosaicLayout {
	stripWidth: number;
	top: number;
	left: number;
	rows: MosaicRow[];
}

export const MOSAIC_GAP = 6;
export const MOSAIC_TILT_DEG = 3;

// Row patterns matching the mockup: varied widths per slot, different row
// heights. Rows repeat these patterns cyclically when the banner needs more.
export const MOSAIC_ROW_PATTERNS: readonly MosaicRowPattern[] = [
	{ height: 185, padLeft: 0, widths: [340, 180, 280, 220, 310, 190, 300, 250] },
	{ height: 130, padLeft: 80, widths: [260, 350, 200, 290, 170, 320, 240, 280] },
	{ height: 170, padLeft: 0, widths: [200, 330, 240, 370, 190, 310, 260] },
	{ height: 145, padLeft: 120, widths: [300, 210, 350, 180, 290, 230, 320] }
];

/** The banner width the server lays out for; the stylesheet matches it. */
export const SSR_BANNER_WIDTH = 1920;
export const DESKTOP_BANNER_HEIGHT = 600;
/** Viewports at or under this width take the stylesheet's phone geometry. */
export const PHONE_MAX_WIDTH = 768;

const DESKTOP_LEFT = -60;
const DESKTOP_TOP = -40;
const MIN_STRIP_WIDTH = 1700;
/** How far past the banner's right edge the strip reaches before rotation. */
const RIGHT_OVERSHOOT = 140;
/** Slack on every edge so rounding never exposes a hairline. */
const EDGE_MARGIN = 8;
const MAX_ROWS = 40;

/** How far a row with these cells reaches from the strip's left edge. */
function rowSpan(pattern: MosaicRowPattern, widths: number[]): number {
	return pattern.padLeft + widths.reduce((sum, w) => sum + w, 0) + MOSAIC_GAP * (widths.length - 1);
}

/**
 * Repeats the pattern's cells until the row reaches the strip's right edge,
 * and when the pattern is padded, prepends one cell so the row still starts
 * left of the strip. The stagger the padding gives the mockup is kept: the
 * first patterned cell lands exactly where padLeft put it.
 */
function buildRow(pattern: MosaicRowPattern, stripWidth: number): MosaicRow {
	const widths = [...pattern.widths];
	while (rowSpan(pattern, widths) < stripWidth + EDGE_MARGIN) {
		widths.push(...pattern.widths);
	}
	if (pattern.padLeft === 0) {
		return { height: pattern.height, marginLeft: 0, widths };
	}
	const lead = pattern.widths[pattern.widths.length - 1];
	return {
		height: pattern.height,
		marginLeft: pattern.padLeft - lead - MOSAIC_GAP,
		widths: [lead, ...widths]
	};
}

/** The strip box's height: the rows stacked with the gap between them. */
function stripHeight(rows: MosaicRow[]): number {
	return rows.reduce((sum, r) => sum + r.height, 0) + MOSAIC_GAP * (rows.length - 1);
}

/**
 * Maps a banner point into the strip's own (unrotated) frame. The strip is
 * rotated about the centre of its box, so undo that rotation about the same
 * point and then subtract the box's offset.
 */
function toStripFrame(
	x: number,
	y: number,
	geom: { stripWidth: number; height: number; top: number; left: number }
): { x: number; y: number } {
	const cx = geom.left + geom.stripWidth / 2;
	const cy = geom.top + geom.height / 2;
	const dx = x - cx;
	const dy = y - cy;
	// CSS rotate(-tilt) with y pointing down; the inverse is rotate(+tilt).
	const rad = (MOSAIC_TILT_DEG * Math.PI) / 180;
	const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
	const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
	return { x: rx + cx - geom.left, y: ry + cy - geom.top };
}

/** Where a banner corner falls relative to the strip box, or null if inside. */
function uncovered(
	bannerWidth: number,
	bannerHeight: number,
	geom: { stripWidth: number; height: number; top: number; left: number }
): 'above' | 'below' | 'left' | 'right' | null {
	const corners = [
		[0, 0],
		[bannerWidth, 0],
		[0, bannerHeight],
		[bannerWidth, bannerHeight]
	];
	for (const [x, y] of corners) {
		const p = toStripFrame(x, y, geom);
		if (p.y < EDGE_MARGIN) return 'above';
		if (p.y > geom.height - EDGE_MARGIN) return 'below';
		if (p.x < EDGE_MARGIN) return 'left';
		if (p.x > geom.stripWidth - EDGE_MARGIN) return 'right';
	}
	return null;
}

/**
 * Lays the strip out so it covers a banner of the given size. Deterministic
 * and monotone: a wider banner never gets a smaller strip.
 */
export function mosaicLayout(
	bannerWidth: number = SSR_BANNER_WIDTH,
	bannerHeight: number = DESKTOP_BANNER_HEIGHT
): MosaicLayout {
	let stripWidth = Math.max(MIN_STRIP_WIDTH, bannerWidth - DESKTOP_LEFT + RIGHT_OVERSHOOT);
	let top = DESKTOP_TOP;
	let left = DESKTOP_LEFT;
	let rows = MOSAIC_ROW_PATTERNS.map((p) => buildRow(p, stripWidth));

	for (let i = 0; i < 400; i++) {
		const gap = uncovered(bannerWidth, bannerHeight, {
			stripWidth,
			height: stripHeight(rows),
			top,
			left
		});
		if (gap === null) break;
		if (gap === 'above') top -= 10;
		else if (gap === 'left') left -= 10;
		else if (gap === 'right') stripWidth += 20;
		else if (rows.length < MAX_ROWS) {
			rows.push(buildRow(MOSAIC_ROW_PATTERNS[rows.length % MOSAIC_ROW_PATTERNS.length], stripWidth));
		} else break;
		// A wider strip or a lower left edge changes what each row must span.
		rows = rows.map((_, idx) =>
			buildRow(MOSAIC_ROW_PATTERNS[idx % MOSAIC_ROW_PATTERNS.length], stripWidth)
		);
	}

	return { stripWidth, top, left, rows };
}

/**
 * Distributes images across the layout's cells, cycling through the list.
 * Each row starts three images further along so neighbouring rows do not
 * repeat the same sequence, and odd rows run right to left.
 */
export function mosaicSlots(images: string[], rows: MosaicRow[]): string[][] {
	if (images.length === 0) return rows.map(() => []);
	const result: string[][] = [];
	let imgIdx = 0;
	for (let r = 0; r < rows.length; r++) {
		const row: string[] = [];
		const rowOffset = r * 3;
		for (let s = 0; s < rows[r].widths.length; s++) {
			row.push(images[(imgIdx + rowOffset) % images.length]);
			imgIdx++;
		}
		if (r % 2 === 1) row.reverse();
		result.push(row);
	}
	return result;
}
