// Auto-palette suggestions for the ref-sheet color picker. Pure TS — no deps,
// no DOM; works on any ImageData-shaped object so it's unit-testable in node.
//
// Approach: quantized histogram (4 bits/channel), skip transparent pixels,
// exclude the background by clustering the border ring's dominant colors (real
// fleet sheets ship flat gray-blue / lavender / teal backdrops, not just
// white), then greedily pick the top-N buckets with a minimum color-distance
// constraint so small accents (eye colors, paw pads) survive next to large fur
// regions. Each pick reports the ACTUAL most-common pixel of its bucket — a
// bucket average would invent colors that aren't on the sheet.

export interface ExtractOptions {
	/** How many suggestions to return. */
	count?: number;
}

// Extraction tuning, fixed by design (see the tests for the behaviors these
// values guarantee — accent survival, colored-backdrop exclusion, dedupe).
/** Minimum RGB distance between returned colors (protects small accents). */
const MIN_DISTANCE = 40;
/** Border-ring thickness as a fraction of the shorter side (≥ 1px). */
const RING_FRACTION = 0.04;
/** Share (0–1) of the opaque ring a color needs to count as background. */
const BACKGROUND_MIN_SHARE = 0.08;
/** Candidates within this RGB distance of a background color are dropped. */
const BACKGROUND_DISTANCE = 60;

/** The ImageData surface we need — lets tests pass plain objects in node. */
export type PixelSource = Pick<ImageData, 'data' | 'width' | 'height'>;

function rgbDistance(a: number, b: number): number {
	const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
	const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
	const db = (a & 0xff) - (b & 0xff);
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

function toHex(rgb: number): string {
	return `#${rgb.toString(16).padStart(6, '0')}`.toUpperCase();
}

/** Suggest up to `count` palette colors from raw pixels, largest areas first. */
export function extractPalette(image: PixelSource, options: ExtractOptions = {}): string[] {
	const { count = 5 } = options;
	const { data, width, height } = image;

	// Pass 1: quantized histogram. Per bucket we also count each exact pixel so
	// the winner can report its true mode pixel later.
	const buckets = new Map<number, { total: number; pixels: Map<number, number> }>();
	const ringCounts = new Map<number, number>(); // bucket key → opaque ring pixels
	let ringTotal = 0;
	const ringPx = Math.max(1, Math.floor(Math.min(width, height) * RING_FRACTION));

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			if (data[i + 3] < 128) continue; // transparent
			const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
			const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
			if (x < ringPx || y < ringPx || x >= width - ringPx || y >= height - ringPx) {
				ringCounts.set(key, (ringCounts.get(key) ?? 0) + 1);
				ringTotal++;
			}
			let bucket = buckets.get(key);
			if (!bucket) buckets.set(key, (bucket = { total: 0, pixels: new Map() }));
			bucket.total += 1;
			bucket.pixels.set(rgb, (bucket.pixels.get(rgb) ?? 0) + 1);
		}
	}

	// Mode pixel per bucket (never an average).
	const candidates = [...buckets.entries()].map(([key, bucket]) => {
		let mode = 0;
		let modeCount = -1;
		for (const [rgb, c] of bucket.pixels) {
			if (c > modeCount) {
				mode = rgb;
				modeCount = c;
			}
		}
		return { key, total: bucket.total, rgb: mode };
	});

	// Background colors: buckets covering a meaningful share of the opaque ring.
	const background: number[] = [];
	for (const [key, c] of ringCounts) {
		if (c / ringTotal >= BACKGROUND_MIN_SHARE) {
			const bucket = candidates.find((b) => b.key === key);
			if (bucket) background.push(bucket.rgb);
		}
	}

	// Greedy top-N: largest buckets first, skipping background-adjacent colors
	// and anything too close to an already-picked color.
	candidates.sort((a, b) => b.total - a.total);
	const picked: number[] = [];
	for (const c of candidates) {
		if (picked.length >= count) break;
		if (background.some((bg) => rgbDistance(bg, c.rgb) <= BACKGROUND_DISTANCE)) continue;
		if (picked.some((p) => rgbDistance(p, c.rgb) < MIN_DISTANCE)) continue;
		picked.push(c.rgb);
	}
	return picked.map(toHex);
}
