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
	/** Minimum RGB distance between returned colors (protects small accents). */
	minDistance?: number;
	/** Border-ring thickness as a fraction of the shorter side (≥ 1px). */
	ringFraction?: number;
	/** Share (0–1) of the opaque ring a color needs to count as background. */
	backgroundMinShare?: number;
	/** Candidates within this RGB distance of a background color are dropped. */
	backgroundDistance?: number;
	/** Double-weight pixels in the central half of the sheet (off by default). */
	centerWeight?: boolean;
}

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
	const {
		count = 5,
		minDistance = 40,
		ringFraction = 0.04,
		backgroundMinShare = 0.08,
		backgroundDistance = 60,
		centerWeight = false
	} = options;
	const { data, width, height } = image;

	// Pass 1: quantized histogram. Per bucket we also count each exact pixel so
	// the winner can report its true mode pixel later.
	const buckets = new Map<number, { total: number; pixels: Map<number, number> }>();
	const ringCounts = new Map<number, number>(); // bucket key → opaque ring pixels
	let ringTotal = 0;
	const ringPx = Math.max(1, Math.floor(Math.min(width, height) * ringFraction));
	const cx0 = width / 4;
	const cx1 = (3 * width) / 4;
	const cy0 = height / 4;
	const cy1 = (3 * height) / 4;

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
			const w = centerWeight && x >= cx0 && x < cx1 && y >= cy0 && y < cy1 ? 2 : 1;
			let bucket = buckets.get(key);
			if (!bucket) buckets.set(key, (bucket = { total: 0, pixels: new Map() }));
			bucket.total += w;
			bucket.pixels.set(rgb, (bucket.pixels.get(rgb) ?? 0) + w);
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
		if (c / ringTotal >= backgroundMinShare) {
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
		if (background.some((bg) => rgbDistance(bg, c.rgb) <= backgroundDistance)) continue;
		if (picked.some((p) => rgbDistance(p, c.rgb) < minDistance)) continue;
		picked.push(c.rgb);
	}
	return picked.map(toHex);
}
