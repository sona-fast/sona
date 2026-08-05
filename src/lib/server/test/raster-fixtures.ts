// Byte builders for tiny synthetic raster files, shared by the animation-sniff
// test suites (animated-raster, sticker-import, backfill endpoint). Test-only.

export function ascii(text: string): number[] {
	return [...text].map((c) => c.charCodeAt(0));
}

/** Minimal RIFF/WEBP file whose first chunk is `fourcc` with `payload`. */
export function webp(fourcc: string, payload: number[]): Uint8Array {
	const chunk = [...ascii(fourcc), payload.length, 0, 0, 0, ...payload];
	const size = 4 + chunk.length;
	return new Uint8Array([...ascii('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...ascii('WEBP'), ...chunk]);
}

/** VP8X payload: flags byte + 3 reserved + 3 width + 3 height = 10 bytes. */
export function vp8x(flags: number): number[] {
	return [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/** An animated WebP (VP8X with the ANIMATION flag bit set). */
export function animatedWebp(): Uint8Array {
	return webp('VP8X', vp8x(0x02));
}

/** A static simple-lossy WebP (VP8 chunk — cannot animate). */
export function staticWebp(): Uint8Array {
	return webp('VP8 ', [0, 0, 0, 0]);
}

/**
 * A two-frame GIF with a stray 0x00 pad byte between the frames. Some encoders
 * emit padding between blocks; the walker hits the unknown marker before the
 * second frame and must err toward "animated" (frames past it are unknowable).
 */
export function paddedMultiFrameGif(): Uint8Array {
	const header = [...ascii('GIF89a'), 2, 0, 2, 0, 0x00, 0, 0]; // no global color table
	// Image descriptor (2×2, no local color table) + LZW min-code byte + one
	// empty-terminated data sub-block chain.
	const frame = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 0x02, 1, 0x4c, 0x00];
	return new Uint8Array([...header, ...frame, 0x00, ...frame, 0x3b]);
}
