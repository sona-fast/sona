// Detect whether a static-raster sticker file (WebP/GIF/PNG) actually animates.
// A "static" sticker row (format 'png' | 'webp') can hold an animated WebP or an
// animated GIF — nothing in the URL or content-type says so. The download
// endpoint must know, because converting an animated file to PNG through the
// Cloudflare image transform flattens it to its first frame. Sniffing the bytes
// at import time (and in the backfill endpoint) is the only reliable signal.
//
// Deliberately format-narrow: WebP and GIF are the only raster formats the
// sticker importer stores (PNG/JPEG can't animate; APNG is not an accepted
// sticker type — see isAllowedStickerType). Unknown containers return false.

/** True when `bytes` are an animated WebP or an animated (multi-frame) GIF. */
export function isAnimatedRaster(bytes: Uint8Array): boolean {
	return isAnimatedWebp(bytes) || isAnimatedGif(bytes);
}

/**
 * Best-effort sniff of an already-stored raster by URL, for save paths that
 * only hold the URL (manual pack create/edit) and for the backfill endpoint.
 * Returns null when the sniff was UNDETERMINED — relative URL with no origin to
 * resolve against, network error/timeout, non-2xx — so callers choose their own
 * default: the save paths treat null as "static" (`?? false`, correctable later
 * by POST /api/stickers/backfill-animated), while the backfill reports the row
 * as failed rather than stamping a possibly-animated file static.
 */
export async function sniffAnimatedFromUrl(
	url: string,
	fetchFn: typeof fetch = fetch,
	origin?: string
): Promise<boolean | null> {
	try {
		const absolute = new URL(url, origin).href;
		// Bounded: a hung storage fetch must not stall a pack save indefinitely.
		const res = await fetchFn(absolute, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		return isAnimatedRaster(new Uint8Array(await res.arrayBuffer()));
	} catch {
		return null;
	}
}

/**
 * Animated WebP: RIFF/WEBP container whose first chunk is VP8X with the
 * animation flag set. Per the WebP spec an animated file MUST use the extended
 * (VP8X) layout with bit 1 of the flags byte set; simple lossy (VP8) and
 * lossless (VP8L) layouts cannot animate, so a missing/other first chunk is a
 * definite "static".
 */
function isAnimatedWebp(bytes: Uint8Array): boolean {
	if (bytes.length < 21) return false;
	if (!hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WEBP')) return false;
	if (!hasAscii(bytes, 12, 'VP8X')) return false;
	// VP8X payload starts at 20; its first byte holds the feature flags
	// (Rsv|I|L|E|X|A|R) — bit 1 (0x02) is ANIMATION.
	return (bytes[20] & 0x02) !== 0;
}

/**
 * Animated GIF: more than one image descriptor in the block stream. Walks the
 * GIF89a/87a block structure (header → logical screen descriptor → optional
 * global color table → blocks) counting image separators (0x2C), short-circuiting
 * as soon as a second frame is seen. A walk that runs OFF the buffer (truncated
 * file) errs toward "animated" — the safe direction: a wrong true only hides the
 * PNG option, while a wrong false would offer a flattening conversion. An
 * unknown block marker (malformed or padded stream) errs the same way: frames
 * past it are unknowable.
 */
function isAnimatedGif(bytes: Uint8Array): boolean {
	if (bytes.length < 13) return false;
	if (!hasAscii(bytes, 0, 'GIF8')) return false;

	// Logical screen descriptor: 7 bytes at offset 6; its packed byte says
	// whether a global color table follows and how big it is.
	const packed = bytes[10];
	let pos = 13;
	if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1));

	let frames = 0;
	while (pos < bytes.length) {
		const marker = bytes[pos++];
		if (marker === 0x3b) break; // trailer
		if (marker === 0x21) {
			// Extension: label byte, then data sub-blocks until a 0 terminator.
			pos++;
			pos = skipSubBlocks(bytes, pos);
			if (pos < 0) return true; // truncated — err toward animated (see above)
		} else if (marker === 0x2c) {
			// Image descriptor: 9 bytes (position/size + packed), optional local
			// color table, LZW minimum-code byte, then data sub-blocks.
			if (++frames > 1) return true;
			if (pos + 9 > bytes.length) return true; // truncated — err toward animated
			const localPacked = bytes[pos + 8];
			pos += 9;
			if (localPacked & 0x80) pos += 3 * (1 << ((localPacked & 0x07) + 1));
			pos++; // LZW minimum code size
			pos = skipSubBlocks(bytes, pos);
			if (pos < 0) return true; // truncated — err toward animated (see above)
		} else {
			// Unknown block marker — a malformed or padded stream (some encoders
			// leave stray 0x00 bytes between blocks). Frames past it are unknowable,
			// so err toward animated, matching the truncation policy above.
			return true;
		}
	}
	return frames > 1;
}

/** Advance past a GIF data sub-block chain; -1 when it runs off the buffer. */
function skipSubBlocks(bytes: Uint8Array, pos: number): number {
	while (pos < bytes.length) {
		const size = bytes[pos++];
		if (size === 0) return pos;
		pos += size;
	}
	return -1;
}

function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}
