// Strip location and identifying metadata from stored rasters (SONA-170).
//
// Cloudflare Image Transformations drop metadata on the transform path, but
// several routes serve the STORED ORIGINAL bytes untouched: GIFs bypass the
// transform, rawFallback in $lib/img falls back to the source URL, the
// /img/[...key] route streams the object, and an R2 custom domain serves it
// directly. EXIF GPS from an operator's phone photo survives all of those. So
// the strip happens at STORE time, inside the storage layer (see scrub.ts), and
// every put site — /api/upload, the fursuit and sticker imports, avatar
// re-hosting, provider migration — inherits it with no per-site code.
//
// Everything here is size-preserving: both providers stream a body only when
// its exact length is declared up front (R2's FixedLengthStream, UploadThing's
// presigned ingest — see types.ts and the SONA-136 comments in r2.ts), so a
// scrub that changed the length would break streaming puts. Every edit is
// therefore an IN-PLACE overwrite of the same number of bytes: metadata records
// are rewritten to a minimal valid form and the slack is zero- or space-padded.
//
// The parser fails CLOSED. Anything we cannot walk (truncated segment, bad
// chunk length, mismatched RIFF size, an AVIF layout we do not support) throws
// UnscrubbableImageError rather than passing bytes through unexamined — the
// guarantee this module exists to make is "every stored raster went through the
// scrubber", not "most did".

import { sniffImageType } from './sniff';

/** Thrown when a body could not be parsed well enough to guarantee a scrub. */
export class UnscrubbableImageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnscrubbableImageError';
	}
}

/** Leading bytes handed to sniffImageType — enough for an AVIF ftyp box's
 * compatible_brands (which start at offset 16), matching /api/upload. */
const SNIFF_BYTES = 64;

/**
 * Ceiling on any single metadata record we buffer to rewrite (PNG/WebP chunks,
 * the AVIF meta box). JPEG segments are capped at 65535 bytes by the format
 * itself. Over the cap is unscrubbable rather than an unbounded allocation in
 * an isolate with a hard memory ceiling.
 */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** Longest ASCII value we carry across into the rewritten TIFF. */
const MAX_ASCII_BYTES = 4096;

// ---------------------------------------------------------------------------
// The driver: a byte-stream coroutine
// ---------------------------------------------------------------------------
//
// Each format is a generator that yields small commands — copy N bytes through
// untouched, buffer N bytes and hand them to me, write these replacement bytes,
// pass the rest through. The driver feeds it whatever input has arrived. That
// keeps ONE implementation of every format walk shared by the sync and the
// streaming entry points, and it bounds memory: only a record actually under
// inspection is ever held.

type Step =
	/** Pass `n` bytes through unchanged. */
	| { kind: 'copy'; n: number }
	/** Buffer exactly `n` bytes and resume the machine with them. */
	| { kind: 'take'; n: number }
	/** Buffer up to `n` bytes, resuming with fewer only at end of input. */
	| { kind: 'takeUpTo'; n: number }
	/** Emit replacement bytes (consumes no input). */
	| { kind: 'write'; bytes: Uint8Array }
	/** Push bytes back onto the front of the input, unconsumed. */
	| { kind: 'unread'; bytes: Uint8Array }
	/** Terminal: everything left passes through unchanged. */
	| { kind: 'rest' };

type Machine = Generator<Step, void, Uint8Array>;

class ScrubDriver {
	#machine: Machine = scrubMachine();
	#step: Step | null;
	#input: Uint8Array[] = [];
	#inputLen = 0;
	#seen = 0;
	#emitted = 0;

	constructor() {
		this.#step = this.#advance();
	}

	#advance(value?: Uint8Array): Step | null {
		const next = value === undefined ? this.#machine.next() : this.#machine.next(value);
		return next.done ? null : next.value;
	}

	push(chunk: Uint8Array): Uint8Array[] {
		if (chunk.length) {
			this.#input.push(chunk);
			this.#inputLen += chunk.length;
			this.#seen += chunk.length;
		}
		return this.#drain();
	}

	end(): Uint8Array[] {
		const out = this.#drain();
		// Resolve a pending takeUpTo with whatever arrived; at end of input a
		// short read is the answer, not a wait. Bounded: only the leading sniff
		// and the ISOBMFF box headers use takeUpTo, and each resolves once.
		for (let guard = 0; this.#step?.kind === 'takeUpTo' && guard < 64; guard++) {
			this.#step = this.#advance(concat(this.#pull(this.#inputLen)));
			out.push(...this.#drain());
		}
		const step = this.#step;
		if (step !== null && step.kind !== 'rest') {
			throw new UnscrubbableImageError('the image ended inside a metadata record (truncated file)');
		}
		// Belt on the size-preserving contract: a machine that wrote a different
		// number of bytes than it consumed would produce an object whose length
		// no longer matches the declared size, failing the put in a far less
		// legible way than this does.
		if (this.#emitted !== this.#seen) {
			throw new UnscrubbableImageError(
				`scrub changed the byte length (${this.#seen} in, ${this.#emitted} out)`
			);
		}
		return out;
	}

	/** Remove exactly `n` bytes from the front of the input queue. */
	#pull(n: number): Uint8Array[] {
		const out: Uint8Array[] = [];
		let need = n;
		while (need > 0) {
			const head = this.#input[0];
			if (head.length <= need) {
				out.push(head);
				need -= head.length;
				this.#input.shift();
			} else {
				out.push(head.subarray(0, need));
				this.#input[0] = head.subarray(need);
				need = 0;
			}
		}
		this.#inputLen -= n;
		return out;
	}

	#drain(): Uint8Array[] {
		const out: Uint8Array[] = [];
		const emit = (bytes: Uint8Array) => {
			this.#emitted += bytes.length;
			out.push(bytes);
		};
		for (;;) {
			const step = this.#step;
			if (step === null) {
				// The machine ran to completion at a clean record boundary; anything
				// after it is trailing data the format allows (and that no walk can
				// interpret), so it passes through.
				if (this.#inputLen) for (const part of this.#pull(this.#inputLen)) emit(part);
				return out;
			}
			switch (step.kind) {
				case 'rest': {
					if (this.#inputLen) for (const part of this.#pull(this.#inputLen)) emit(part);
					return out;
				}
				case 'copy': {
					const n = Math.min(step.n, this.#inputLen);
					if (n) for (const part of this.#pull(n)) emit(part);
					step.n -= n;
					if (step.n > 0) return out;
					this.#step = this.#advance();
					break;
				}
				case 'take':
				case 'takeUpTo': {
					if (this.#inputLen < step.n) return out;
					this.#step = this.#advance(concat(this.#pull(step.n)));
					break;
				}
				case 'write': {
					emit(step.bytes);
					this.#step = this.#advance();
					break;
				}
				case 'unread': {
					if (step.bytes.length) {
						this.#input.unshift(step.bytes);
						this.#inputLen += step.bytes.length;
					}
					this.#step = this.#advance();
					break;
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a scrubbed COPY of `bytes`, the same length as the input. Throws
 * UnscrubbableImageError when the bytes match no supported raster signature or
 * cannot be walked.
 */
export function scrubImageMetadata(bytes: Uint8Array): Uint8Array {
	const driver = new ScrubDriver();
	const parts = driver.push(bytes);
	for (const tail of driver.end()) parts.push(tail);
	return concat(parts);
}

/**
 * A size-preserving TransformStream doing the same work as
 * scrubImageMetadata. Output is byte-identical to the sync function over the
 * concatenated input however the input is chunked, so a streaming put and a
 * buffered put of the same file store the same object.
 */
export function scrubImageMetadataStream(): TransformStream<Uint8Array, Uint8Array> {
	const driver = new ScrubDriver();
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			for (const part of driver.push(chunk)) {
				if (part.length) controller.enqueue(part);
			}
		},
		flush(controller) {
			for (const part of driver.end()) {
				if (part.length) controller.enqueue(part);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Format dispatch
// ---------------------------------------------------------------------------

function* scrubMachine(): Machine {
	const head = yield { kind: 'takeUpTo', n: SNIFF_BYTES };
	const type = sniffImageType(head);
	if (!type) {
		throw new UnscrubbableImageError('the leading bytes match no supported raster signature');
	}
	// Hand the sniffed bytes back so each walk can start from offset 0.
	yield { kind: 'unread', bytes: head };
	switch (type) {
		case 'image/jpeg':
			yield* scrubJpeg();
			return;
		case 'image/png':
			yield* scrubPng();
			return;
		case 'image/webp':
			yield* scrubWebp();
			return;
		case 'image/avif':
			yield* scrubAvif();
			return;
		default:
			// GIF. The format has no location field: the only free-text place is
			// the comment extension (0xFE), which cameras and phones do not write
			// and which some GIF tooling uses for its own bookkeeping. Left alone
			// deliberately rather than rewritten for the sake of symmetry.
			yield { kind: 'rest' };
	}
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const EXIF_PREFIX = ascii('Exif\0\0');
const XMP_NS = ascii('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT_NS = ascii('http://ns.adobe.com/xmp/extension/\0');
const ICC_PREFIX = ascii('ICC_PROFILE\0');

/**
 * Walk the marker segments up to SOS. Everything from SOS onward (the entropy
 * coded scan, any following markers, EOI and any trailer after it) passes
 * through untouched — metadata never lives there, and a walk of compressed
 * scan data would be all risk and no benefit.
 */
function* scrubJpeg(): Machine {
	const soi = yield { kind: 'take', n: 2 };
	yield { kind: 'write', bytes: soi };
	if (soi[0] !== 0xff || soi[1] !== 0xd8) {
		throw new UnscrubbableImageError('jpeg: missing SOI marker');
	}
	for (;;) {
		const lead = yield { kind: 'take', n: 1 };
		yield { kind: 'write', bytes: lead };
		if (lead[0] !== 0xff) {
			throw new UnscrubbableImageError('jpeg: expected a marker prefix (0xFF)');
		}
		// 0xFF may repeat as fill before the marker code; consume the run.
		let marker = 0xff;
		while (marker === 0xff) {
			const next = yield { kind: 'take', n: 1 };
			yield { kind: 'write', bytes: next };
			marker = next[0];
		}
		// Standalone markers carry no length: TEM and the restart markers.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd8) continue;
		if (marker === 0xda || marker === 0xd9) {
			yield { kind: 'rest' };
			return;
		}
		const lengthBytes = yield { kind: 'take', n: 2 };
		yield { kind: 'write', bytes: lengthBytes };
		const length = u16(lengthBytes, 0, true);
		if (length < 2) {
			throw new UnscrubbableImageError(`jpeg: segment 0x${marker.toString(16)} declares length ${length}`);
		}
		const payloadLen = length - 2;
		const scrubs = marker === 0xe1 || marker === 0xe2 || marker === 0xed;
		if (!scrubs || payloadLen === 0) {
			if (payloadLen) yield { kind: 'copy', n: payloadLen };
			continue;
		}
		const payload = yield { kind: 'take', n: payloadLen };
		yield { kind: 'write', bytes: scrubJpegSegment(marker, payload) };
	}
}

/**
 * Rewrite one APP segment payload in place. Kept as-is: APP0 (JFIF/JFXX), the
 * APP2 ICC profile (colour, not identity), APP14 Adobe, COM, and every
 * non-APP segment. Scrubbed: APP1 (Exif and XMP), APP2 other than ICC (the MPF
 * index, whose embedded previews carry their own metadata), and APP13 (the
 * Photoshop resource block, where IPTC location fields live). An APPn payload
 * a decoder does not recognise is skipped by that decoder, so zeroing one is
 * safe.
 */
function scrubJpegSegment(marker: number, payload: Uint8Array): Uint8Array {
	if (marker === 0xe1) {
		if (startsWith(payload, EXIF_PREFIX)) {
			const out = new Uint8Array(payload.length);
			out.set(EXIF_PREFIX, 0);
			const tiff = minimalTiff(payload.subarray(EXIF_PREFIX.length), payload.length - EXIF_PREFIX.length, true);
			// A payload with no room for even an empty TIFF directory cannot stay a
			// valid Exif segment, so it becomes an unrecognised (skipped) one.
			if (!tiff) return new Uint8Array(payload.length);
			out.set(tiff, EXIF_PREFIX.length);
			return out;
		}
		if (startsWith(payload, XMP_NS)) {
			const out = new Uint8Array(payload.length);
			out.set(XMP_NS, 0);
			out.set(emptyXmpPacket(payload.length - XMP_NS.length), XMP_NS.length);
			return out;
		}
		// Extended XMP (a continuation of a packet too big for one segment) and
		// anything else claiming APP1: no structure worth keeping.
		if (startsWith(payload, XMP_EXT_NS)) return new Uint8Array(payload.length);
		return new Uint8Array(payload.length);
	}
	if (marker === 0xe2) {
		return startsWith(payload, ICC_PREFIX) ? payload : new Uint8Array(payload.length);
	}
	// APP13.
	return new Uint8Array(payload.length);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** Private ancillary, safe-to-copy chunk type the scrubbed text chunks become. */
const SCRUBBED_CHUNK = ascii('scRb');

/**
 * Walk the chunk stream. eXIf is rewritten to a minimal TIFF; the text chunks
 * (tEXt, zTXt and iTXt, which is where XMP lives as XML:com.adobe.xmp) are
 * renamed to a private ancillary type and zeroed. Renaming matters: a zeroed
 * tEXt keeps its type but loses its keyword, and libpng rejects a keyword-less
 * tEXt as malformed, whereas an unknown ancillary chunk is simply skipped.
 * Everything else — IHDR, PLTE, IDAT, iCCP, cHRM, gAMA, sRGB, pHYs, tIME, and
 * the APNG chunks — is copied through.
 */
function* scrubPng(): Machine {
	const signature = yield { kind: 'take', n: 8 };
	yield { kind: 'write', bytes: signature };
	for (;;) {
		const header = yield { kind: 'take', n: 8 };
		const length = u32(header, 0, true);
		if (length > 0x7fffffff) {
			throw new UnscrubbableImageError(`png: chunk length ${length} is out of range`);
		}
		const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
		const rewrites = type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt';
		if (!rewrites) {
			yield { kind: 'write', bytes: header };
			yield { kind: 'copy', n: length + 4 };
			if (type === 'IEND') {
				yield { kind: 'rest' };
				return;
			}
			continue;
		}
		if (length > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`png: ${type} chunk is ${length} bytes, over the ${MAX_RECORD_BYTES}-byte cap`);
		}
		// The CRC covers type + data, so both the rename and the new data need a
		// recomputed one; its 4 bytes are read and replaced, not copied.
		const body = yield { kind: 'take', n: length + 4 };
		const newType = type === 'eXIf' ? header.subarray(4, 8) : SCRUBBED_CHUNK;
		const data =
			type === 'eXIf'
				? (minimalTiff(body.subarray(0, length), length, true) ?? new Uint8Array(length))
				: new Uint8Array(length);
		yield { kind: 'write', bytes: header.subarray(0, 4) };
		yield { kind: 'write', bytes: newType };
		yield { kind: 'write', bytes: data };
		yield { kind: 'write', bytes: u32be(crc32([newType, data])) };
	}
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

/**
 * Walk the RIFF chunk list. The EXIF chunk becomes a minimal TIFF, the XMP
 * chunk an empty packet, and the VP8X header's XMP feature bit is cleared so a
 * decoder does not advertise metadata that is no longer there. The EXIF bit
 * stays set because the rewritten chunk is still a valid EXIF chunk. ICCP,
 * ANIM, ANMF, ALPH, VP8 and VP8L are copied through, and a simple-format file
 * (no VP8X) has no metadata chunks at all.
 */
function* scrubWebp(): Machine {
	const header = yield { kind: 'take', n: 12 };
	yield { kind: 'write', bytes: header };
	const riffSize = u32(header, 4, false);
	if (riffSize < 4) {
		throw new UnscrubbableImageError(`webp: RIFF size ${riffSize} is too small`);
	}
	let remaining = riffSize - 4;
	while (remaining > 0) {
		if (remaining < 8) {
			throw new UnscrubbableImageError('webp: a chunk header runs past the declared RIFF size');
		}
		const chunkHeader = yield { kind: 'take', n: 8 };
		const fourcc = String.fromCharCode(chunkHeader[0], chunkHeader[1], chunkHeader[2], chunkHeader[3]);
		const size = u32(chunkHeader, 4, false);
		// Chunks are padded to an even length; the pad byte is part of the stream
		// but not of the payload.
		const padded = size + (size & 1);
		if (padded > remaining - 8) {
			throw new UnscrubbableImageError(`webp: ${fourcc} chunk runs past the declared RIFF size`);
		}
		remaining -= 8 + padded;
		const rewrites = fourcc === 'VP8X' || fourcc === 'EXIF' || fourcc === 'XMP ';
		if (!rewrites) {
			yield { kind: 'write', bytes: chunkHeader };
			if (padded) yield { kind: 'copy', n: padded };
			continue;
		}
		if (padded > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`webp: ${fourcc} chunk is ${size} bytes, over the ${MAX_RECORD_BYTES}-byte cap`);
		}
		const body = yield { kind: 'take', n: padded };
		yield { kind: 'write', bytes: chunkHeader };
		yield { kind: 'write', bytes: scrubWebpChunk(fourcc, body, size) };
	}
	yield { kind: 'rest' };
}

function scrubWebpChunk(fourcc: string, body: Uint8Array, size: number): Uint8Array {
	if (fourcc === 'VP8X') {
		if (body.length < 1) return body;
		const out = new Uint8Array(body);
		out[0] &= ~0x04; // XMP metadata flag
		return out;
	}
	const out = new Uint8Array(body.length);
	if (fourcc === 'XMP ') {
		out.set(emptyXmpPacket(size), 0);
		return out;
	}
	// EXIF. Most encoders store the bare TIFF, but some prefix the JPEG-style
	// 'Exif\0\0' header; keep whichever shape the file already uses so a decoder
	// that keys off it still finds what it expects.
	const payload = body.subarray(0, size);
	if (startsWith(payload, EXIF_PREFIX)) {
		out.set(EXIF_PREFIX, 0);
		const tiff = minimalTiff(payload.subarray(EXIF_PREFIX.length), size - EXIF_PREFIX.length, true);
		if (tiff) out.set(tiff, EXIF_PREFIX.length);
		else out.fill(0);
		return out;
	}
	const tiff = minimalTiff(payload, size, true);
	if (tiff) out.set(tiff, 0);
	return out;
}

// ---------------------------------------------------------------------------
// AVIF
// ---------------------------------------------------------------------------

interface AvifExtent {
	offset: number;
	length: number;
	kind: 'exif' | 'xmp';
}

/**
 * Walk the top-level ISOBMFF boxes. The metadata items live in `meta` (which
 * names them) but their bytes live in `mdat`, addressed by absolute file
 * offsets in the `iloc` box — so the meta box is buffered and parsed, then each
 * referenced extent is rewritten as the stream reaches it.
 *
 * Nothing is preserved from an AVIF's Exif payload beyond Artist and Copyright:
 * AVIF carries orientation in the irot/imir item properties, not in EXIF, so
 * keeping the Exif Orientation tag could only ever fight the real one.
 */
function* scrubAvif(): Machine {
	let pos = 0;
	for (;;) {
		const header = yield { kind: 'takeUpTo', n: 8 };
		if (header.length === 0) return; // clean end at a box boundary
		if (header.length < 8) {
			throw new UnscrubbableImageError('avif: truncated box header');
		}
		yield { kind: 'write', bytes: header };
		pos += 8;
		const declared = u32(header, 0, true);
		const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
		let contentLen: number | null;
		if (declared === 1) {
			const large = yield { kind: 'take', n: 8 };
			yield { kind: 'write', bytes: large };
			pos += 8;
			contentLen = u64(large, 0) - 16;
		} else if (declared === 0) {
			contentLen = null; // extends to end of file
		} else {
			contentLen = declared - 8;
		}
		if (contentLen !== null && contentLen < 0) {
			throw new UnscrubbableImageError(`avif: ${type} box declares an impossible size`);
		}
		if (type !== 'meta') {
			if (contentLen === null) {
				yield { kind: 'rest' };
				return;
			}
			if (contentLen) yield { kind: 'copy', n: contentLen };
			pos += contentLen;
			continue;
		}
		if (contentLen === null || contentLen > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`avif: meta box is too large to inspect (cap ${MAX_RECORD_BYTES} bytes)`);
		}
		const meta = yield { kind: 'take', n: contentLen };
		// The meta box itself is written back unchanged — the item list still
		// describes the same items at the same offsets, only their payloads change.
		yield { kind: 'write', bytes: meta };
		pos += contentLen;
		const extents = parseAvifMeta(meta);
		if (!extents.length) continue;
		extents.sort((a, b) => a.offset - b.offset);
		for (const extent of extents) {
			if (extent.offset < pos) {
				throw new UnscrubbableImageError(
					'avif: a metadata extent overlaps another or sits before the meta box, so it cannot be rewritten in place'
				);
			}
			if (extent.offset > pos) yield { kind: 'copy', n: extent.offset - pos };
			const payload = yield { kind: 'take', n: extent.length };
			yield { kind: 'write', bytes: scrubAvifExtent(extent.kind, payload) };
			pos = extent.offset + extent.length;
		}
		yield { kind: 'rest' };
		return;
	}
}

function scrubAvifExtent(kind: 'exif' | 'xmp', payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(payload.length);
	if (kind === 'xmp') {
		out.set(emptyXmpPacket(payload.length), 0);
		return out;
	}
	// An Exif item payload is a 4-byte big-endian offset to the TIFF header
	// followed by the TIFF. The rewrite always puts the header first, so the
	// offset becomes zero.
	if (payload.length < 4) return out;
	const skip = u32(payload, 0, true);
	const tiffStart = 4 + skip;
	const original = tiffStart <= payload.length ? payload.subarray(tiffStart) : new Uint8Array(0);
	const tiff = minimalTiff(original, payload.length - 4, false);
	if (tiff) out.set(tiff, 4);
	return out;
}

/** iinf/iloc parse of a meta box, yielding the file extents of Exif and XMP items. */
function parseAvifMeta(meta: Uint8Array): AvifExtent[] {
	if (meta.length < 4) throw new UnscrubbableImageError('avif: meta box is truncated');
	// meta is a FullBox: version + flags precede its child boxes.
	const items = new Map<number, 'exif' | 'xmp'>();
	let locations: Map<number, { method: number; extents: { offset: number; length: number }[] }> | null = null;
	for (const box of isoBoxes(meta, 4)) {
		if (box.type === 'iinf') parseIinf(box.body, items);
		else if (box.type === 'iloc') locations = parseIloc(box.body);
	}
	if (!items.size) return [];
	const out: AvifExtent[] = [];
	for (const [id, kind] of items) {
		const location = locations?.get(id);
		if (!location) continue; // an item the iloc does not place has no bytes to scrub
		if (location.method !== 0) {
			throw new UnscrubbableImageError(
				`avif: the ${kind} item uses construction_method ${location.method}; only file offsets are supported`
			);
		}
		if (location.extents.length !== 1) {
			throw new UnscrubbableImageError(
				`avif: the ${kind} item is split across ${location.extents.length} extents, which cannot be rewritten in place`
			);
		}
		const [extent] = location.extents;
		if (extent.length <= 0) {
			throw new UnscrubbableImageError(`avif: the ${kind} item declares no extent length`);
		}
		out.push({ offset: extent.offset, length: extent.length, kind });
	}
	return out;
}

function parseIinf(body: Uint8Array, items: Map<number, 'exif' | 'xmp'>): void {
	if (body.length < 4) throw new UnscrubbableImageError('avif: iinf box is truncated');
	const version = body[0];
	const countLen = version === 0 ? 2 : 4;
	if (body.length < 4 + countLen) throw new UnscrubbableImageError('avif: iinf box is truncated');
	for (const box of isoBoxes(body, 4 + countLen)) {
		if (box.type !== 'infe') continue;
		parseInfe(box.body, items);
	}
}

function parseInfe(body: Uint8Array, items: Map<number, 'exif' | 'xmp'>): void {
	if (body.length < 4) throw new UnscrubbableImageError('avif: infe box is truncated');
	const version = body[0];
	// Versions 0 and 1 predate item_type and are not used by AVIF; they carry no
	// item we would scrub, so they are skipped rather than guessed at.
	if (version !== 2 && version !== 3) return;
	let p = 4;
	const idLen = version === 2 ? 2 : 4;
	if (body.length < p + idLen + 2 + 4) throw new UnscrubbableImageError('avif: infe box is truncated');
	const id = idLen === 2 ? u16(body, p, true) : u32(body, p, true);
	p += idLen + 2; // item_ID, then item_protection_index
	const itemType = String.fromCharCode(body[p], body[p + 1], body[p + 2], body[p + 3]);
	p += 4;
	const name = readCString(body, p);
	p = name.next;
	if (itemType === 'Exif') {
		items.set(id, 'exif');
		return;
	}
	if (itemType !== 'mime') return;
	const contentType = readCString(body, p);
	if (contentType.text === 'application/rdf+xml') items.set(id, 'xmp');
}

function parseIloc(
	body: Uint8Array
): Map<number, { method: number; extents: { offset: number; length: number }[] }> {
	const out = new Map<number, { method: number; extents: { offset: number; length: number }[] }>();
	if (body.length < 6) throw new UnscrubbableImageError('avif: iloc box is truncated');
	const version = body[0];
	if (version > 2) throw new UnscrubbableImageError(`avif: iloc version ${version} is not supported`);
	const offsetSize = body[4] >> 4;
	const lengthSize = body[4] & 0x0f;
	const baseOffsetSize = body[5] >> 4;
	const indexSize = version === 0 ? 0 : body[5] & 0x0f;
	let p = 6;
	const idLen = version === 2 ? 4 : 2;
	const countLen = version === 2 ? 4 : 2;
	const itemCount = countLen === 2 ? u16(body, p, true) : u32(body, p, true);
	p += countLen;
	const need = (n: number) => {
		if (p + n > body.length) throw new UnscrubbableImageError('avif: iloc box is truncated');
	};
	for (let i = 0; i < itemCount; i++) {
		need(idLen);
		const id = idLen === 2 ? u16(body, p, true) : u32(body, p, true);
		p += idLen;
		let method = 0;
		if (version === 1 || version === 2) {
			need(2);
			method = body[p + 1] & 0x0f;
			p += 2;
		}
		need(2);
		p += 2; // data_reference_index
		need(baseOffsetSize);
		const baseOffset = readUint(body, p, baseOffsetSize);
		p += baseOffsetSize;
		need(2);
		const extentCount = u16(body, p, true);
		p += 2;
		const extents: { offset: number; length: number }[] = [];
		for (let e = 0; e < extentCount; e++) {
			need(indexSize + offsetSize + lengthSize);
			p += indexSize;
			const offset = readUint(body, p, offsetSize);
			p += offsetSize;
			const length = readUint(body, p, lengthSize);
			p += lengthSize;
			extents.push({ offset: baseOffset + offset, length });
		}
		out.set(id, { method, extents });
	}
	return out;
}

/** Iterate the ISOBMFF boxes inside `body` starting at `start`. */
function* isoBoxes(body: Uint8Array, start: number): Generator<{ type: string; body: Uint8Array }> {
	let p = start;
	while (p + 8 <= body.length) {
		const declared = u32(body, p, true);
		const type = String.fromCharCode(body[p + 4], body[p + 5], body[p + 6], body[p + 7]);
		let headerLen = 8;
		let size = declared;
		if (declared === 1) {
			if (p + 16 > body.length) throw new UnscrubbableImageError('avif: truncated large box header');
			size = u64(body, p + 8);
			headerLen = 16;
		} else if (declared === 0) {
			size = body.length - p;
		}
		if (size < headerLen || p + size > body.length) {
			throw new UnscrubbableImageError(`avif: ${type} box declares a size past its parent`);
		}
		yield { type, body: body.subarray(p + headerLen, p + size) };
		p += size;
	}
}

function readCString(body: Uint8Array, start: number): { text: string; next: number } {
	let end = start;
	while (end < body.length && body[end] !== 0) end++;
	if (end >= body.length) throw new UnscrubbableImageError('avif: unterminated string in an infe box');
	return { text: new TextDecoder().decode(body.subarray(start, end)), next: end + 1 };
}

function readUint(body: Uint8Array, at: number, size: number): number {
	if (size === 0) return 0;
	if (size !== 4 && size !== 8) {
		throw new UnscrubbableImageError(`avif: unsupported iloc field width ${size}`);
	}
	return size === 4 ? u32(body, at, true) : u64(body, at);
}

// ---------------------------------------------------------------------------
// The minimal TIFF rewrite
// ---------------------------------------------------------------------------

const TAG_ORIENTATION = 0x0112;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;

interface KeptTags {
	orientation?: number;
	artist?: Uint8Array;
	copyright?: Uint8Array;
}

/**
 * Rewrite an Exif TIFF as a directory holding, at most, Orientation, Artist and
 * Copyright — and only when the original already had them. Everything else goes:
 * the Exif sub-IFD (capture time, camera serial, lens), the GPS IFD, the interop
 * IFD, the MakerNote, and IFD1 with its thumbnail (which is a second copy of the
 * picture and can carry its own metadata).
 *
 * Returns a buffer of exactly `capacity` bytes, or null when `capacity` cannot
 * hold even an empty directory. A malformed original does NOT throw: an
 * unreadable IFD yields an empty directory, because losing an orientation hint
 * beats refusing the upload.
 */
function minimalTiff(tiff: Uint8Array, capacity: number, keepOrientation: boolean): Uint8Array | null {
	if (capacity < 14) return null;
	const bigEndian = tiff.length >= 2 && tiff[0] === 0x4d && tiff[1] === 0x4d;
	const tags = readIfd0(tiff, bigEndian);
	if (!keepOrientation) tags.orientation = undefined;
	const out = new Uint8Array(capacity);
	// Drop the optional values one at a time rather than overflow: a payload too
	// small for the attribution strings still gets a valid directory.
	for (const attempt of [tags, { ...tags, copyright: undefined }, { orientation: tags.orientation }, {}]) {
		const built = buildTiff(attempt, bigEndian);
		if (built.length <= capacity) {
			out.set(built, 0);
			return out;
		}
	}
	return out;
}

function readIfd0(tiff: Uint8Array, bigEndian: boolean): KeptTags {
	const tags: KeptTags = {};
	if (tiff.length < 8) return tags;
	const littleEndian = tiff[0] === 0x49 && tiff[1] === 0x49;
	if (!bigEndian && !littleEndian) return tags;
	if (u16(tiff, 2, bigEndian) !== 42) return tags;
	const ifd = u32(tiff, 4, bigEndian);
	if (ifd + 2 > tiff.length) return tags;
	const count = u16(tiff, ifd, bigEndian);
	if (ifd + 2 + count * 12 > tiff.length) return tags;
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		const tag = u16(tiff, entry, bigEndian);
		const type = u16(tiff, entry + 2, bigEndian);
		const length = u32(tiff, entry + 4, bigEndian);
		if (tag === TAG_ORIENTATION && type === 3 && length === 1) {
			const value = u16(tiff, entry + 8, bigEndian);
			if (value >= 1 && value <= 8) tags.orientation = value;
			continue;
		}
		if (tag !== TAG_ARTIST && tag !== TAG_COPYRIGHT) continue;
		if (type !== 2 || length === 0 || length > MAX_ASCII_BYTES) continue;
		let value: Uint8Array;
		if (length <= 4) {
			value = tiff.slice(entry + 8, entry + 8 + length);
		} else {
			const at = u32(tiff, entry + 8, bigEndian);
			if (at + length > tiff.length) continue;
			value = tiff.slice(at, at + length);
		}
		const terminated = terminate(value);
		if (terminated.length <= 1) continue; // empty string, nothing to carry over
		if (tag === TAG_ARTIST) tags.artist = terminated;
		else tags.copyright = terminated;
	}
	return tags;
}

/** Trim an ASCII value at its first NUL and guarantee a trailing one. */
function terminate(value: Uint8Array): Uint8Array {
	const nul = value.indexOf(0);
	const text = nul >= 0 ? value.subarray(0, nul) : value;
	const out = new Uint8Array(text.length + 1);
	out.set(text, 0);
	return out;
}

function buildTiff(tags: KeptTags, bigEndian: boolean): Uint8Array {
	const entries: { tag: number; type: number; count: number; value: Uint8Array }[] = [];
	if (tags.orientation !== undefined) {
		const value = new Uint8Array(2);
		writeU16(value, 0, tags.orientation, bigEndian);
		entries.push({ tag: TAG_ORIENTATION, type: 3, count: 1, value });
	}
	if (tags.artist) entries.push({ tag: TAG_ARTIST, type: 2, count: tags.artist.length, value: tags.artist });
	if (tags.copyright) {
		entries.push({ tag: TAG_COPYRIGHT, type: 2, count: tags.copyright.length, value: tags.copyright });
	}
	entries.sort((a, b) => a.tag - b.tag); // IFD entries are ordered by tag
	const dataStart = 8 + 2 + entries.length * 12 + 4;
	let dataLen = 0;
	for (const entry of entries) {
		if (entry.value.length > 4) dataLen += entry.value.length + (entry.value.length & 1);
	}
	const out = new Uint8Array(dataStart + dataLen);
	out[0] = bigEndian ? 0x4d : 0x49;
	out[1] = out[0];
	writeU16(out, 2, 42, bigEndian);
	writeU32(out, 4, 8, bigEndian);
	writeU16(out, 8, entries.length, bigEndian);
	let at = 10;
	let dataAt = dataStart;
	for (const entry of entries) {
		writeU16(out, at, entry.tag, bigEndian);
		writeU16(out, at + 2, entry.type, bigEndian);
		writeU32(out, at + 4, entry.count, bigEndian);
		if (entry.value.length <= 4) {
			// Inline values sit at the START of the 4-byte field in both byte orders.
			out.set(entry.value, at + 8);
		} else {
			writeU32(out, at + 8, dataAt, bigEndian);
			out.set(entry.value, dataAt);
			dataAt += entry.value.length + (entry.value.length & 1);
		}
		at += 12;
	}
	writeU32(out, at, 0, bigEndian); // no IFD1: the thumbnail goes with everything else
	return out;
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

const EMPTY_XMP = ascii(
	'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
		'<x:xmpmeta xmlns:x="adobe:ns:meta/"/>' +
		'<?xpacket end="w"?>'
);

/**
 * An empty XMP packet padded to `capacity` with ASCII spaces — the padding the
 * XMP spec already reserves for in-place edits, which is what makes a
 * size-preserving rewrite legal here. A capacity too small for the packet is
 * filled with spaces alone: whitespace is not a packet, and a reader finding no
 * packet is the outcome we want anyway.
 */
function emptyXmpPacket(capacity: number): Uint8Array {
	const out = new Uint8Array(Math.max(capacity, 0)).fill(0x20);
	if (capacity >= EMPTY_XMP.length) out.set(EMPTY_XMP, 0);
	return out;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	if (bytes.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (bytes[i] !== prefix[i]) return false;
	}
	return true;
}

function u16(bytes: Uint8Array, at: number, bigEndian: boolean): number {
	return bigEndian ? (bytes[at] << 8) | bytes[at + 1] : (bytes[at + 1] << 8) | bytes[at];
}

function u32(bytes: Uint8Array, at: number, bigEndian: boolean): number {
	const [a, b, c, d] = bigEndian
		? [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]
		: [bytes[at + 3], bytes[at + 2], bytes[at + 1], bytes[at]];
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** A 64-bit big-endian size, rejected past 2^53 rather than silently rounded. */
function u64(bytes: Uint8Array, at: number): number {
	const high = u32(bytes, at, true);
	const low = u32(bytes, at + 4, true);
	if (high > 0x1fffff) throw new UnscrubbableImageError('avif: a 64-bit box size is out of range');
	return high * 0x100000000 + low;
}

function writeU16(out: Uint8Array, at: number, value: number, bigEndian: boolean): void {
	if (bigEndian) {
		out[at] = (value >> 8) & 0xff;
		out[at + 1] = value & 0xff;
	} else {
		out[at] = value & 0xff;
		out[at + 1] = (value >> 8) & 0xff;
	}
}

function writeU32(out: Uint8Array, at: number, value: number, bigEndian: boolean): void {
	if (bigEndian) {
		out[at] = (value >>> 24) & 0xff;
		out[at + 1] = (value >>> 16) & 0xff;
		out[at + 2] = (value >>> 8) & 0xff;
		out[at + 3] = value & 0xff;
	} else {
		out[at] = value & 0xff;
		out[at + 1] = (value >>> 8) & 0xff;
		out[at + 2] = (value >>> 16) & 0xff;
		out[at + 3] = (value >>> 24) & 0xff;
	}
}

function u32be(value: number): Uint8Array {
	const out = new Uint8Array(4);
	writeU32(out, 0, value, true);
	return out;
}

let crcTable: Uint32Array | null = null;

/** PNG's CRC-32 over the concatenation of `parts` (chunk type plus data). */
function crc32(parts: Uint8Array[]): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const part of parts) {
		for (let i = 0; i < part.length; i++) {
			crc = crcTable[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0];
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
