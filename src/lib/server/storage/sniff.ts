// Magic-byte sniffing for stored images (finding M7).
//
// /api/upload trusts the client's file.type and the fursuit import trusts the
// remote Content-Type; a spoofed header could store bytes that don't match the
// declared type. Sniff the leading bytes and map them to a canonical raster
// content-type, then the caller checks that against the SAME allowlist used for
// header validation (isAllowedImageType) — no second allowlist. Returns null
// when the bytes match no known raster signature (e.g. HTML/SVG/text).

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
	if (bytes.length < offset + sig.length) return false;
	for (let i = 0; i < sig.length; i++) {
		if (bytes[offset + i] !== sig[i]) return false;
	}
	return true;
}

/** ASCII bytes for a short marker string (used for RIFF/WEBP/ftyp checks). */
function ascii(s: string): number[] {
	return [...s].map((c) => c.charCodeAt(0));
}

/**
 * Detect a raster image type from its leading bytes, or null if the signature
 * matches no supported raster format. Covers exactly the raster types in
 * ALLOWED_IMAGE_TYPES: JPEG, PNG, GIF, WebP, AVIF.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	// JPEG: FF D8 FF
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	// GIF: "GIF87a" / "GIF89a"
	if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
	// WebP: "RIFF"....(4-byte size)...."WEBP"
	if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
	// AVIF: ISO-BMFF "ftyp" box at offset 4 with an AVIF brand. Accept avif/avis
	// as the major_brand (offset 8), or as one of the compatible_brands. For
	// mif1-major MIAF/HEIF-derived files the avif brand lives in compatible_brands,
	// which start at offset 16 (after major_brand@8 and minor_version@12).
	if (startsWith(bytes, ascii('ftyp'), 4)) {
		if (startsWith(bytes, ascii('avif'), 8) || startsWith(bytes, ascii('avis'), 8)) return 'image/avif';
		// Read the box size unsigned (>>> 0) so a high-bit size can't go negative and
		// skip the scan; clamp to the buffer length to keep the over-read guard.
		const boxSize = Math.min(((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0, bytes.length);
		for (let off = 16; off + 4 <= boxSize; off += 4) {
			if (startsWith(bytes, ascii('avif'), off) || startsWith(bytes, ascii('avis'), off)) return 'image/avif';
		}
	}
	return null;
}

/**
 * WebM detection (SONA-124 showcase clips): WebM is an EBML/Matroska container
 * opening with the fixed EBML magic 1A 45 DF A3. Separate from sniffImageType
 * on purpose — only the /api/upload webm branch consults it, so image call
 * sites can't accidentally start accepting video.
 */
export function isWebmHead(bytes: Uint8Array): boolean {
	if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false;
	// EBML covers Matroska too (.mkv) — require the DocType ELEMENT (id 42 82)
	// to spell exactly 'webm'. A plain byte scan would accept 'webm' appearing
	// anywhere in the header (e.g. inside a Matroska file's metadata), so this
	// walks the EBML header's child elements instead. DocType sits within the
	// first handful of header elements, well inside the head callers hand in
	// (SNIFF_BYTES); a header odd enough to push it out is rejected rather
	// than trusted.
	let i = 4;
	const headSize = vintLength(bytes[i]);
	if (!headSize) return false;
	i += headSize; // skip the header's own size VINT; its children follow
	while (i < bytes.length) {
		const idLen = vintLength(bytes[i]);
		if (!idLen || i + idLen >= bytes.length) return false;
		const isDocType = idLen === 2 && bytes[i] === 0x42 && bytes[i + 1] === 0x82;
		const sizeAt = i + idLen;
		const sizeLen = vintLength(bytes[sizeAt]);
		if (!sizeLen || sizeAt + sizeLen > bytes.length) return false;
		let size = bytes[sizeAt] & (0xff >> sizeLen);
		for (let j = 1; j < sizeLen; j++) size = size * 256 + bytes[sizeAt + j];
		const payload = sizeAt + sizeLen;
		if (isDocType) {
			// DocType is the ASCII string 'webm', nothing longer or shorter.
			if (size !== 4 || payload + 4 > bytes.length) return false;
			return startsWith(bytes, ascii('webm'), payload);
		}
		i = payload + size;
	}
	return false;
}

/** Length in bytes of an EBML VINT whose first byte is `first` (the leading
 * 1-bit's position), or 0 for the invalid all-zero marker. */
function vintLength(first: number | undefined): number {
	if (!first) return 0;
	for (let len = 1, mask = 0x80; len <= 8; len++, mask >>= 1) {
		if (first & mask) return len;
	}
	return 0;
}
