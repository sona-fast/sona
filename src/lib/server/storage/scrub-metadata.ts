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

/**
 * Whether `error` is an UnscrubbableImageError, or wraps one. The STREAMING
 * path never throws it directly: the transform errors the piped body and the
 * provider's own fetch rejects with its error ("TypeError: fetch failed")
 * carrying ours underneath, so a caller mapping the refusal to a 422 has to
 * look down the chain. The walk follows both wrapping shapes a runtime uses —
 * `cause` and an AggregateError's `errors` — and does not require a link to be
 * an Error, because a rejection can be a plain object carrying a cause.
 * Depth-capped and cycle-guarded because a cause chain can be either.
 */
export function isUnscrubbable(error: unknown): boolean {
	const seen = new Set<unknown>();
	let frontier: unknown[] = [error];
	for (let depth = 0; depth < 8 && frontier.length; depth++) {
		const next: unknown[] = [];
		for (const at of frontier) {
			if (at === null || (typeof at !== 'object' && typeof at !== 'function')) continue;
			if (seen.has(at)) continue;
			seen.add(at);
			if (at instanceof UnscrubbableImageError) return true;
			const link = at as { cause?: unknown; errors?: unknown };
			if ('cause' in link) next.push(link.cause);
			if (Array.isArray(link.errors)) next.push(...link.errors);
		}
		frontier = next;
	}
	return false;
}

/**
 * What a server-side caller records when a put is refused. One sentence in one
 * place: /api/upload returns it as the 422 body, so the client and the server
 * cannot drift. It mirrors the client's
 * admin_upload_error_unscrubbable message; the parser's own wording
 * ("jpeg: segment 0x…") is for the log, not for whoever has to fix the file.
 */
export const UNSCRUBBABLE_MESSAGE =
	"Couldn't strip this file's hidden metadata. Export a fresh copy from an image editor and upload that.";

/** The same refusal on the sticker import, whose page names the item. */
export const UNSCRUBBABLE_STICKER_MESSAGE =
	"Couldn't strip this sticker's hidden metadata, so it wasn't saved.";

/** The same refusal on the fursuit import, where the photo came from FurTrack
 * rather than from the operator, so re-exporting and uploading it is not the
 * fix that sentence would be asking for. */
export const UNSCRUBBABLE_IMPORT_MESSAGE =
	"Couldn't strip this photo's hidden metadata, so it wasn't saved.";

/** The same refusal during a provider migration, where the object predates the
 * scrubber and the operator has to replace it rather than retry the copy. */
export const UNSCRUBBABLE_MIGRATE_MESSAGE =
	"Couldn't strip this file's hidden metadata, so it wasn't migrated. Re-upload a fresh export to replace it.";

/**
 * Leading bytes handed to sniffImageType, here and in the storage decorator
 * that shares this constant. An AVIF's compatible_brands start at offset 16 but
 * run for as long as the ftyp box declares, so the `avif` brand of an
 * mif1-major file can sit well past byte 64; 256 is far beyond any real ftyp,
 * and the driver's takeUpTo resolves a shorter input as a short read rather
 * than waiting for bytes that never come.
 */
export const SNIFF_BYTES = 256;

/**
 * Ceiling on any single metadata record we buffer to rewrite (PNG/WebP chunks,
 * the AVIF meta box). JPEG segments are capped at 65535 bytes by the format
 * itself. Over the cap is unscrubbable rather than an unbounded allocation in
 * an isolate with a hard memory ceiling.
 */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** Longest ASCII value we carry across into the rewritten TIFF. */
const MAX_ASCII_BYTES = 4096;

/** Smallest TIFF that is still one: header, an empty IFD, and the next-IFD word. */
const MIN_TIFF_BYTES = 14;

/**
 * Ceilings on an AVIF item list. A real AVIF names a handful of items with one
 * extent each, so 256 items and 1024 extents in total are far above anything an
 * encoder writes; both exist because an item record — and an extent inside it —
 * can cost as little as zero input bytes, so the declared counts, not the file
 * size, decide how much this parse allocates. The item cap covers iinf as well
 * as iloc: an infe record is about 20 bytes, so a meta box at the record cap
 * holds 200,000 of them, and each one is a map entry.
 */
const MAX_AVIF_ITEMS = 256;
const MAX_ILOC_EXTENTS = 1024;

/**
 * The item types a real AVIF carries that hold no metadata: coded image data,
 * and the derived images that arrange other items. `exif` and `mime` are handled
 * separately because they are the ones being scrubbed. Anything outside this set
 * is a payload the scrubber cannot reason about, so it is refused (see
 * parseInfe) rather than skipped — skipping is what a relabelled Exif item wants.
 */
const INERT_AVIF_ITEM_TYPES = new Set(['av01', 'grid', 'iovl', 'iden', 'tmap']);

/**
 * The top-level boxes a still AVIF carries. `ftyp`, `meta` and `mdat` are the
 * file. `free`, `skip` and `uuid` are the padding boxes, and their CONTENT is
 * zeroed rather than copied: nothing reads them, and `uuid` is exactly where
 * Adobe parks an XMP packet. Any other top-level type is refused — a box the
 * walk copies unexamined is a box an Exif payload can ride through in. That
 * refuses an `avis` image sequence, whose `moov` box carries the QuickTime
 * location atoms in a `udta` this walk does not descend into.
 */
const TOP_LEVEL_AVIF_BOXES = new Set(['ftyp', 'meta', 'mdat', 'free', 'skip', 'uuid']);

/** The subset of those whose content is zeroed instead of copied. */
const ZEROED_AVIF_BOXES = new Set(['free', 'skip', 'uuid']);

/**
 * The boxes a still image's `meta` box holds: the handler, the primary item,
 * the item list, the item locations, the item properties and references, the
 * data-reference and grouping boxes, and the embedded item data. Anything else
 * inside `meta` is refused for the same reason the top-level list is spelled
 * out — a `uuid` child is where an editor parks an XMP packet, and a `free`,
 * `skip` or `udta` child is a payload the walk would otherwise step over.
 */
const AVIF_META_BOXES = new Set(['hdlr', 'pitm', 'iinf', 'iloc', 'iprp', 'iref', 'dinf', 'grpl', 'idat']);

/**
 * The container boxes inside `meta` the walk descends into, and the offset its
 * children start at: a plain container's children start at 0, a FullBox's after
 * its version and flags, and `dref`'s after its entry count as well. The meta
 * box is written back verbatim, so a payload nested in one of these rides
 * through unless the walk goes all the way down.
 */
const AVIF_META_CONTAINERS = new Map([
	['iprp', 0],
	['ipco', 0],
	['iref', 4],
	['dinf', 0],
	['dref', 8],
	['grpl', 0]
]);

/**
 * The boxes refused ANYWHERE inside `meta`, at any depth: each one carries an
 * opaque or XMP payload a reader may surface, and `meta/iprp/ipco` is as good a
 * place to park an Adobe `uuid` XMP box as the top of the meta box is. Unknown
 * LEAF boxes deeper down are not refused — property and reference types vary by
 * encoder (`ispe`, `pixi`, `av1C`, `colr`, `irot`, `auxC`, `dimg`, `thmb`, ...)
 * and refusing them would reject real files.
 */
const REFUSED_INSIDE_META = new Set(['uuid', 'free', 'skip', 'udta', 'meta', 'xml ', 'bxml']);

/**
 * How deep the walk follows containers inside `meta`. A real file nests two or
 * three levels (meta > iprp > ipco > property); the cap is what stops a file
 * whose meta box is nothing but nested containers from recursing to a stack
 * overflow instead of a refusal.
 */
const MAX_META_DEPTH = 8;

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

/** A machine that reports whether the walk is finished (see passScanToEoi). */
type ScanMachine = Generator<Step, boolean, Uint8Array>;

/** Handed to the machine's first `next()`, where the value is discarded. */
const NO_BYTES = new Uint8Array(0);

/**
 * How much output the driver gathers before handing a piece on. A machine emits
 * a piece per step — a marker byte, a rewritten record, a chunk passed through —
 * and the steps that walk a byte at a time (a GIF pad run, a JPEG fill run) would
 * otherwise cost one Uint8Array per input byte, every one of them retained until
 * the caller concatenates. Pieces at least this big are handed on as they are, so
 * a large pass-through chunk is never copied twice.
 */
const OUTPUT_BLOCK_BYTES = 64 * 1024;

class ScrubDriver {
	#machine: Machine = scrubMachine();
	#step: Step | null;
	#input: Uint8Array[] = [];
	#inputLen = 0;
	#seen = 0;
	#emitted = 0;
	/** Allocated on first use and released at every flush, so a small file
	 * never holds a block-sized buffer it did not need. */
	#scratch: Uint8Array | null = null;
	#scratchLen = 0;
	#scratchSize: number;

	/**
	 * `scratchBytes` is the size of that gathering buffer. The sync entry point
	 * passes the input's length, which the size-preserving contract makes the
	 * exact output length, so the whole scrub lands in one buffer and no array of
	 * pieces is ever retained.
	 */
	constructor(scratchBytes: number = OUTPUT_BLOCK_BYTES) {
		this.#scratchSize = scratchBytes;
		this.#step = this.#advance();
	}

	#advance(value: Uint8Array = NO_BYTES): Step | null {
		const next = this.#machine.next(value);
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
		// Resolve pending takeUpTo steps with whatever arrived; at end of input a
		// short read is the answer, not a wait. Each pass hands over every byte
		// still queued, so the loop ends at the first EMPTY hand-over: every
		// takeUpTo site (the leading sniff, the ISOBMFF box header, the JPEG scan
		// walk and every trailer walk) reads an empty array as end of input and
		// stops asking. That also bounds the loop — a pass either consumes input
		// or is the last one.
		while (this.#step?.kind === 'takeUpTo') {
			const remaining = concat(this.#pull(this.#inputLen));
			this.#step = this.#advance(remaining);
			out.push(...this.#drain());
			if (!remaining.length) break;
		}
		this.#flush(out);
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

	/** Hand the gathered bytes on and let the buffer go. */
	#flush(out: Uint8Array[]): void {
		if (!this.#scratchLen) return;
		out.push(this.#scratch!.subarray(0, this.#scratchLen));
		this.#scratch = null;
		this.#scratchLen = 0;
	}

	#drain(): Uint8Array[] {
		const out: Uint8Array[] = [];
		const emit = (bytes: Uint8Array) => {
			this.#emitted += bytes.length;
			if (!bytes.length) return;
			if (bytes.length > this.#scratchSize - this.#scratchLen) {
				this.#flush(out);
				// Too big to gather at all: hand it on as it is rather than copy it.
				if (bytes.length >= this.#scratchSize) {
					out.push(bytes);
					return;
				}
			}
			if (!this.#scratch) this.#scratch = new Uint8Array(this.#scratchSize);
			this.#scratch.set(bytes, this.#scratchLen);
			this.#scratchLen += bytes.length;
		};
		for (;;) {
			const step = this.#step;
			// null: the machine ran to completion at a clean record boundary.
			// 'rest': it asked for the remainder explicitly. Either way what is
			// left is trailing data the format allows (and that no walk can
			// interpret), so it passes through.
			if (step === null || step.kind === 'rest') {
				if (this.#inputLen) for (const part of this.#pull(this.#inputLen)) emit(part);
				return out;
			}
			switch (step.kind) {
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
	// Sized to the input, which the size-preserving contract makes the output's
	// length too: every piece is written into that one buffer at its offset, so
	// this path never holds a list of pieces to concatenate at the end.
	const driver = new ScrubDriver(bytes.length);
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
		case 'image/gif':
			yield* scrubGif();
			return;
		default:
			// A type the sniffer learns to recognise but nothing here walks would
			// otherwise fall into whichever branch sat last.
			throw new UnscrubbableImageError(`no scrubber for ${type}`);
	}
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const EXIF_PREFIX = ascii('Exif\0\0');
const XMP_NS = ascii('http://ns.adobe.com/xap/1.0/\0');
const ICC_PREFIX = ascii('ICC_PROFILE\0');

/** How much of the entropy-coded scan is inspected at a time while looking for EOI. */
const SCAN_BLOCK_BYTES = 8192;

/**
 * Walk the marker segments, scan by scan. Entropy-coded data passes through
 * untouched — metadata never lives inside it — and the walk resumes here at
 * every marker that ends a scan, so a progressive JPEG's later scans get the
 * same segment treatment as its first. Everything after the EOI is zeroed:
 * that trailer is where a phone hides its second picture, an MPF preview or a
 * motion photo's MP4, each with its own Exif and GPS, and no decoder reads past
 * EOI, so zeroing costs nothing a viewer would notice.
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
		// 0xFF may repeat as fill before the marker code; consume the run a block
		// at a time rather than a byte at a time, because a file can be nothing
		// but fill and a byte-sized step costs a byte-sized piece of output.
		let marker = 0xff;
		while (marker === 0xff) {
			const block = yield { kind: 'takeUpTo', n: SCAN_BLOCK_BYTES };
			if (!block.length) {
				throw new UnscrubbableImageError('jpeg: the file ends inside a run of 0xFF fill');
			}
			let at = 0;
			while (at < block.length && block[at] === 0xff) at++;
			if (at < block.length) marker = block[at++];
			yield { kind: 'write', bytes: block.subarray(0, at) };
			yield { kind: 'unread', bytes: block.subarray(at) };
		}
		// Standalone markers carry no length: TEM and the restart markers.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd8) continue;
		if (marker === 0xd9) {
			// EOI with no scan in front of it; the trailer rule still applies.
			yield* zeroToEnd();
			return;
		}
		const lengthBytes = yield { kind: 'take', n: 2 };
		yield { kind: 'write', bytes: lengthBytes };
		const length = u16(lengthBytes, 0, true);
		if (length < 2) {
			throw new UnscrubbableImageError(`jpeg: segment 0x${marker.toString(16)} declares length ${length}`);
		}
		const payloadLen = length - 2;
		if (marker === 0xda) {
			// The SOS header names the scan's components; the entropy-coded data
			// follows it with no length of its own. The scan walk hands control
			// back here when the entropy data ends at a marker that is not EOI —
			// a progressive JPEG has several scans with DQT, DHT, DRI and even
			// APPn segments between them, and each of those is this loop's job.
			if (payloadLen) yield { kind: 'copy', n: payloadLen };
			if (yield* passScanToEoi()) return;
			continue;
		}
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
 * Pass the entropy-coded scan through, stopping at the marker that ends it.
 * Inside entropy data an `FF` is always followed by `00` (byte stuffing) or by
 * a restart marker `D0`–`D7`, and both halves stay in the scan; `FF FF` is
 * legal fill ahead of a marker. Any OTHER byte after an `FF` is a real marker
 * and the entropy data has ended there.
 *
 * Returns true when the image is over: EOI (whose trailer is then zeroed —
 * that is where a phone hides an MPF preview or a motion photo's MP4, each
 * with its own GPS) or end of input, which is a truncated file that still
 * decodes as far as it goes. Returns false at any other marker, handing the
 * bytes back to scrubJpeg's marker loop — a progressive JPEG puts DQT, DHT,
 * DRI and sometimes an APP1 Exif between its scans, and searching blindly for
 * `FF D9` would both miss that APP1 and stop early on a DQT whose table bytes
 * happen to read `FF D9`, zeroing the rest of the picture.
 */
function* passScanToEoi(): ScanMachine {
	for (;;) {
		const block = yield { kind: 'takeUpTo', n: SCAN_BLOCK_BYTES };
		if (!block.length) return true;
		// A short read only happens at end of input (see the driver), which is
		// what makes it safe to emit a trailing 0xFF instead of holding it back.
		const atEnd = block.length < SCAN_BLOCK_BYTES;
		let found = -1;
		for (let i = 0; i + 1 < block.length; i++) {
			if (block[i] !== 0xff) continue;
			const next = block[i + 1];
			if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
				i++; // stuffing or a restart marker: both bytes belong to the scan
				continue;
			}
			if (next === 0xff) continue; // fill; judge the pair starting at that byte
			found = i;
			break;
		}
		if (found >= 0) {
			const endsImage = block[found + 1] === 0xd9;
			// The EOI itself is part of the picture; any other marker goes back on
			// the queue for the marker loop to read from its leading 0xFF.
			yield { kind: 'write', bytes: block.subarray(0, found + (endsImage ? 2 : 0)) };
			yield { kind: 'unread', bytes: block.subarray(found + (endsImage ? 2 : 0)) };
			if (!endsImage) return false;
			yield* zeroToEnd();
			return true;
		}
		if (!atEnd && block[block.length - 1] === 0xff) {
			// The 0xFF may be the first half of a marker split across chunks, so it
			// goes back on the queue to be judged with the byte that follows it.
			yield { kind: 'write', bytes: block.subarray(0, block.length - 1) };
			yield { kind: 'unread', bytes: block.subarray(block.length - 1) };
			continue;
		}
		yield { kind: 'write', bytes: block };
		if (atEnd) return true;
	}
}

/** Replace every remaining byte with a zero, size for size. */
function* zeroToEnd(): Machine {
	for (;;) {
		const block = yield { kind: 'takeUpTo', n: SCAN_BLOCK_BYTES };
		if (!block.length) return;
		yield { kind: 'write', bytes: new Uint8Array(block.length) };
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
			return rewriteExif(payload, payload.length, true);
		}
		if (startsWith(payload, XMP_NS)) {
			const out = new Uint8Array(payload.length);
			out.set(XMP_NS, 0);
			out.set(emptyXmpPacket(payload.length - XMP_NS.length), XMP_NS.length);
			return out;
		}
		// Anything else claiming APP1 is zeroed whole, extended XMP (a
		// continuation of a packet too big for one segment) included: it has no
		// structure worth keeping, so it needs no branch of its own.
		return new Uint8Array(payload.length);
	}
	if (marker === 0xe2) {
		return startsWith(payload, ICC_PREFIX) ? payload : new Uint8Array(payload.length);
	}
	// APP13.
	return new Uint8Array(payload.length);
}

/**
 * Rewrite an Exif record of exactly `capacity` bytes, wherever it lives. Most
 * encoders store the bare TIFF, but some prefix the JPEG-style 'Exif\0\0'
 * header; whichever shape the record already uses is kept, so a decoder that
 * keys off it still finds what it expects. A capacity too small for even an
 * empty directory is zeroed instead: an Exif record a decoder skips beats a
 * malformed one it chokes on.
 */
function rewriteExif(payload: Uint8Array, capacity: number, keepOrientation: boolean): Uint8Array {
	const out = new Uint8Array(Math.max(capacity, 0));
	const prefixed = startsWith(payload, EXIF_PREFIX);
	const start = prefixed ? EXIF_PREFIX.length : 0;
	// No room for an empty directory after the prefix, so the whole record stays
	// zeroed, the prefix included: an 'Exif\0\0' header wrapped around a zeroed
	// TIFF header is a malformed Exif record a decoder may choke on, where an
	// APP1 it does not recognise at all is simply skipped.
	if (capacity - start < MIN_TIFF_BYTES) return out;
	const tiff = minimalTiff(payload.subarray(start), capacity - start, keepOrientation);
	// Nothing worth a directory came back (no room, or no TIFF header to read),
	// so the whole record stays zeroed, prefix included, for the same reason as
	// above: a prefix around a zeroed TIFF is the hollow record, not a skipped one.
	if (!tiff.length || (tiff[0] !== 0x49 && tiff[0] !== 0x4d)) return out;
	if (prefixed) out.set(EXIF_PREFIX, 0);
	out.set(tiff, start);
	return out;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** Private ancillary, safe-to-copy chunk type the scrubbed text chunks become. */
const SCRUBBED_CHUNK = ascii('scRb');

/**
 * Walk the chunk stream. eXIf is rewritten to a minimal TIFF; the text chunks
 * (tEXt, zTXt and iTXt, which is where XMP lives as XML:com.adobe.xmp), the
 * compressed-Exif zxIf and the tXMP variant are renamed to a private ancillary
 * type and zeroed. Renaming matters: a zeroed tEXt keeps its type but loses its
 * keyword, and libpng rejects a keyword-less tEXt as malformed, whereas an
 * unknown ancillary chunk is simply skipped. zxIf is zeroed rather than
 * rewritten because reading it would mean inflating it, which this module does
 * not do.
 *
 * Types are matched case-INSENSITIVELY. The case bits carry the ancillary,
 * private and safe-to-copy flags, not the identity of the chunk, so an encoder
 * writing `exIf` or `zxIf` still means Exif — and matching only the canonical
 * spelling would let it through carrying GPS.
 *
 * Everything else — IHDR, PLTE, IDAT, iCCP, cHRM, gAMA, sRGB, pHYs, tIME, and
 * the APNG chunks — is copied through, and everything after IEND is zeroed.
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
		const canonical = type.toLowerCase();
		const isExif = canonical === 'exif';
		const rewrites =
			isExif ||
			canonical === 'text' ||
			canonical === 'ztxt' ||
			canonical === 'itxt' ||
			canonical === 'zxif' ||
			canonical === 'txmp';
		if (!rewrites) {
			yield { kind: 'write', bytes: header };
			yield { kind: 'copy', n: length + 4 };
			if (type === 'IEND') {
				// IEND ends the image; a reader stops there. Bytes parked after it
				// get the JPEG trailer's treatment — an eXIf chunk appended past
				// IEND still reads as metadata to anything that goes looking.
				yield* zeroToEnd();
				return;
			}
			continue;
		}
		if (length > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`png: ${loggable(type)} chunk is ${length} bytes, over the ${MAX_RECORD_BYTES}-byte cap`);
		}
		// The CRC covers type + data, so both the rename and the new data need a
		// recomputed one; its 4 bytes are read and replaced, not copied.
		const body = yield { kind: 'take', n: length + 4 };
		const newType = isExif ? header.subarray(4, 8) : SCRUBBED_CHUNK;
		const data = isExif
			? minimalTiff(body.subarray(0, length), length, true)
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
		// Fourccs are matched case-insensitively: the spec spells them uppercase,
		// but a writer that emits `exif` instead of `EXIF` still produces a chunk
		// decoders read, so a case-sensitive match would walk GPS straight past.
		const tag = fourcc.toUpperCase();
		const size = u32(chunkHeader, 4, false);
		// Chunks are padded to an even length; the pad byte is part of the stream
		// but not of the payload.
		const padded = size + (size & 1);
		if (padded > remaining - 8) {
			throw new UnscrubbableImageError(`webp: ${loggable(fourcc)} chunk runs past the declared RIFF size`);
		}
		remaining -= 8 + padded;
		const rewrites = tag === 'VP8X' || tag === 'EXIF' || tag === 'XMP ';
		if (!rewrites) {
			yield { kind: 'write', bytes: chunkHeader };
			if (padded) yield { kind: 'copy', n: padded };
			continue;
		}
		if (padded > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`webp: ${loggable(fourcc)} chunk is ${size} bytes, over the ${MAX_RECORD_BYTES}-byte cap`);
		}
		const body = yield { kind: 'take', n: padded };
		yield { kind: 'write', bytes: chunkHeader };
		yield { kind: 'write', bytes: scrubWebpChunk(tag, body, size) };
	}
	// Bytes past the declared RIFF size are not part of the picture and no
	// decoder reads them, so they get the JPEG trailer's treatment: zeroed
	// rather than passed through unexamined.
	yield* zeroToEnd();
}

/** `tag` is the chunk's fourcc, uppercased by the caller. */
function scrubWebpChunk(tag: string, body: Uint8Array, size: number): Uint8Array {
	if (tag === 'VP8X') {
		if (body.length < 1) return body;
		const out = new Uint8Array(body);
		out[0] &= ~0x04; // XMP metadata flag
		return out;
	}
	const out = new Uint8Array(body.length);
	if (tag === 'XMP ') {
		out.set(emptyXmpPacket(size), 0);
		return out;
	}
	// EXIF. The pad byte is outside the payload, so the rewrite fills `size`
	// bytes and the pad stays zero.
	out.set(rewriteExif(body.subarray(0, size), size, true), 0);
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

/** Refusal for an extent the walk has already passed, from either check below. */
const EXTENT_BEHIND_THE_WALK =
	'avif: a metadata extent overlaps another or sits before the meta box, so it cannot be rewritten in place';

/**
 * Walk the top-level ISOBMFF boxes. The metadata items live in `meta` (which
 * names them) but their bytes live in `mdat`, addressed by absolute file
 * offsets in the `iloc` box — so the meta box is buffered and parsed, then each
 * referenced extent is rewritten as the stream reaches it.
 *
 * The walk keeps going as boxes to the end of the input rather than passing the
 * tail through once the extents are rewritten: bytes after the last extent are
 * still boxes, and a second meta + mdat pair appended there would otherwise
 * carry a whole second set of Exif and XMP through untouched. A second meta box
 * is refused outright — a real AVIF has exactly one.
 *
 * Nothing is preserved from an AVIF's Exif payload beyond Artist and Copyright:
 * AVIF carries orientation in the irot/imir item properties, not in EXIF, so
 * keeping the Exif Orientation tag could only ever fight the real one.
 */
function* scrubAvif(): Machine {
	let pos = 0;
	let metaSeen = false;
	// Extents named by the meta box that the walk has not reached yet, sorted by
	// offset and consumed from the front as each box's content goes past.
	const pending: AvifExtent[] = [];
	for (;;) {
		const header = yield { kind: 'takeUpTo', n: 8 };
		if (header.length === 0) {
			// Clean end at a box boundary. An extent still pending here was placed
			// past the end of the file by the item list, so it was never scrubbed.
			if (pending.length) {
				throw new UnscrubbableImageError(
					'avif: the item list places a metadata extent past the end of the file'
				);
			}
			return;
		}
		if (header.length < 8) {
			throw new UnscrubbableImageError('avif: truncated box header');
		}
		yield { kind: 'write', bytes: header };
		pos += 8;
		const declared = u32(header, 0, true);
		const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
		if (!TOP_LEVEL_AVIF_BOXES.has(type)) {
			throw new UnscrubbableImageError(`avif: a top-level ${loggable(type)} box, which the scrubber does not know`);
		}
		let contentLen: number | null;
		if (declared === 1) {
			const large = yield { kind: 'take', n: 8 };
			yield { kind: 'write', bytes: large };
			pos += 8;
			contentLen = u64(large, 0) - 16;
		} else if (declared === 0) {
			// "Runs to the end of the file" is the mdat's form, and the padding
			// boxes' — both are the last box in a file that has one. On a ftyp or a
			// meta it is a way to swallow every box after it, so it is refused.
			if (type !== 'mdat' && !ZEROED_AVIF_BOXES.has(type)) {
				throw new UnscrubbableImageError(
					`avif: a ${type} box declaring size 0 would run to the end of the file, which only mdat and padding boxes may do`
				);
			}
			contentLen = null; // extends to end of file
		} else {
			contentLen = declared - 8;
		}
		if (contentLen !== null && contentLen < 0) {
			throw new UnscrubbableImageError(`avif: ${type} box declares an impossible size`);
		}
		if (type !== 'meta') {
			const zero = ZEROED_AVIF_BOXES.has(type);
			if (contentLen === null) {
				// A box that runs to end of file is normal for the mdat AFTER the
				// item list has been read. Before it, passing the rest through would
				// hand back the whole file — meta and all — unexamined.
				if (!metaSeen) {
					throw new UnscrubbableImageError(
						`avif: the ${type} box runs to the end of the file before the meta box, so the metadata items were never examined`
					);
				}
				pos = yield* passAvifContent(pos, null, pending, zero);
				// No box boundary can follow inside a box that runs to end of file,
				// so nothing left can be a second meta: the tail is payload.
				if (zero) yield* zeroToEnd();
				else yield { kind: 'rest' };
				return;
			}
			pos = yield* passAvifContent(pos, contentLen, pending, zero);
			continue;
		}
		if (metaSeen) {
			// A real AVIF has one meta box. A second one names its own items in its
			// own mdat, so accepting it would mean scrubbing whichever set of
			// offsets we happened to parse and passing the other through.
			throw new UnscrubbableImageError('avif: a second meta box, which a real file does not have');
		}
		if (contentLen === null || contentLen > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(`avif: meta box is too large to inspect (cap ${MAX_RECORD_BYTES} bytes)`);
		}
		const meta = yield { kind: 'take', n: contentLen };
		// The meta box itself is written back unchanged — the item list still
		// describes the same items at the same offsets, only their payloads change.
		yield { kind: 'write', bytes: meta };
		pos += contentLen;
		metaSeen = true;
		pending.push(...parseAvifMeta(meta));
		pending.sort((a, b) => a.offset - b.offset);
		// An mdat placed BEFORE the meta box that names it has already gone past,
		// so its extents sit behind the walk and no in-place rewrite can reach
		// them. Caught here rather than at the end of the file, where the leftover
		// pending extent would be reported as one placed past the end.
		if (pending.length && pending[0].offset < pos) {
			throw new UnscrubbableImageError(EXTENT_BEHIND_THE_WALK);
		}
	}
}

/**
 * Pass one box's content through, rewriting every pending extent inside it.
 * `contentLen` of null means the box runs to end of file, so every extent left
 * belongs to it and the caller passes the remainder through. With `zero` the
 * content is overwritten instead of copied — a padding box nothing reads (see
 * ZEROED_AVIF_BOXES) — and a pending extent inside one is still rewritten in
 * place, which is odd but legal, rather than left to the zeroing. Returns the
 * file offset the walk has reached.
 */
function* passAvifContent(
	pos: number,
	contentLen: number | null,
	pending: AvifExtent[],
	zero = false
): Generator<Step, number, Uint8Array> {
	const end = contentLen === null ? Infinity : pos + contentLen;
	while (pending.length && pending[0].offset < end) {
		const extent = pending.shift() as AvifExtent;
		if (extent.offset < pos) {
			throw new UnscrubbableImageError(EXTENT_BEHIND_THE_WALK);
		}
		if (extent.offset + extent.length > end) {
			throw new UnscrubbableImageError(
				'avif: a metadata extent runs past the end of the box holding it, so it cannot be rewritten in place'
			);
		}
		if (extent.offset > pos) yield* passAvifGap(extent.offset - pos, zero);
		const payload = yield { kind: 'take', n: extent.length };
		yield { kind: 'write', bytes: scrubAvifExtent(extent.kind, payload) };
		pos = extent.offset + extent.length;
	}
	if (contentLen === null) return pos;
	if (end > pos) yield* passAvifGap(end - pos, zero);
	return end;
}

/** Move `n` bytes of box content along: copied, or overwritten with zeros. */
function* passAvifGap(n: number, zero: boolean): Machine {
	if (!zero) {
		yield { kind: 'copy', n };
		return;
	}
	// Blocked rather than taken whole: a padding box can be megabytes, and only
	// the block under inspection should ever be held.
	for (let left = n; left > 0; ) {
		const block = Math.min(left, SCAN_BLOCK_BYTES);
		yield { kind: 'take', n: block };
		yield { kind: 'write', bytes: new Uint8Array(block) };
		left -= block;
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
	out.set(rewriteExif(original, payload.length - 4, false), 4);
	return out;
}

/**
 * Descend a container box inside `meta` and refuse the payload boxes at every
 * level. The first-level allowlist above says which boxes may sit directly
 * under meta; below it only the deny list applies, because the property and
 * reference types a real encoder writes are open-ended.
 */
function checkMetaDescendants(type: string, body: Uint8Array, depth: number): void {
	const start = AVIF_META_CONTAINERS.get(type);
	if (start === undefined) return;
	if (depth > MAX_META_DEPTH) {
		throw new UnscrubbableImageError(`avif: boxes inside the meta box nest more than ${MAX_META_DEPTH} deep`);
	}
	for (const box of isoBoxes(body, start)) {
		if (REFUSED_INSIDE_META.has(box.type)) {
			throw new UnscrubbableImageError(
				`avif: a ${loggable(box.type)} box inside the meta box's ${loggable(type)} box, which a still image does not have`
			);
		}
		checkMetaDescendants(box.type, box.body, depth + 1);
	}
}

/** iinf/iloc parse of a meta box, yielding the file extents of Exif and XMP items. */
function parseAvifMeta(meta: Uint8Array): AvifExtent[] {
	if (meta.length < 4) throw new UnscrubbableImageError('avif: meta box is truncated');
	// meta is a FullBox: version + flags precede its child boxes.
	const items = new Map<number, 'exif' | 'xmp'>();
	let locations: Map<number, { method: number; extents: { offset: number; length: number }[] }> | null = null;
	let iinfSeen = false;
	for (const box of isoBoxes(meta, 4)) {
		if (!AVIF_META_BOXES.has(box.type)) {
			throw new UnscrubbableImageError(
				`avif: a ${loggable(box.type)} box inside the meta box, which a still image does not have`
			);
		}
		checkMetaDescendants(box.type, box.body, 1);
		// A real meta box holds one iinf and one iloc. A second of either would
		// let a decoy shadow the real one: the scrubber would follow whichever it
		// kept, a reader whichever it prefers, and the metadata behind the other
		// would never be rewritten.
		if (box.type === 'iinf') {
			if (iinfSeen) throw new UnscrubbableImageError('avif: the meta box holds more than one iinf');
			iinfSeen = true;
			parseIinf(box.body, items);
		} else if (box.type === 'iloc') {
			if (locations) throw new UnscrubbableImageError('avif: the meta box holds more than one iloc');
			locations = parseIloc(box.body);
		}
	}
	// No iinf at all means the walk never saw an item list — which is what a box
	// covering the rest of the meta box buys an attacker: the items are still
	// there for a reader that walks past it, and the scrubber found nothing to
	// rewrite. An iinf naming no metadata item is a different thing and is fine.
	if (!iinfSeen) {
		throw new UnscrubbableImageError('avif: the meta box holds no iinf, so its item list was never read');
	}
	if (!items.size) return [];
	const out: AvifExtent[] = [];
	for (const [id, kind] of items) {
		const location = locations?.get(id);
		if (!location) {
			// The item list names the payload but does not say where it is, so the
			// scrubber cannot reach bytes a reader may still find another way.
			throw new UnscrubbableImageError(`avif: the ${kind} item has no iloc entry, so its bytes cannot be located`);
		}
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
		// The extent is buffered whole to be rewritten, so its DECLARED length is
		// an allocation an attacker chooses; the cap that bounds every other
		// buffered record has to bound this one too.
		if (extent.length > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(
				`avif: the ${kind} item declares a ${extent.length}-byte extent, over the ${MAX_RECORD_BYTES}-byte cap`
			);
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
	// entry_count is declared, so it is capped before anything is walked; the
	// records actually present are counted too, because a small declared count
	// with a meta box full of infe boxes costs the same map entries.
	const declared = countLen === 2 ? u16(body, 4, true) : u32(body, 4, true);
	if (declared > MAX_AVIF_ITEMS) {
		throw new UnscrubbableImageError(
			`avif: the iinf box lists ${declared} items, over the ${MAX_AVIF_ITEMS}-item cap`
		);
	}
	// Every item_ID the iinf named, recognised or not: a repeat is what a decoy
	// needs (see parseInfe).
	const seen = new Set<number>();
	let entries = 0;
	for (const box of isoBoxes(body, 4 + countLen)) {
		// Only item entries live in iinf. A `free` box sized to cover the entries
		// that follow it would hide every item from this walk while a reader that
		// knows the box type steps over it and finds them, so anything else is
		// refused rather than skipped.
		if (box.type !== 'infe') {
			throw new UnscrubbableImageError(
				`avif: a ${loggable(box.type)} box inside the iinf box, which holds only item entries`
			);
		}
		if (++entries > MAX_AVIF_ITEMS) {
			throw new UnscrubbableImageError(
				`avif: the iinf box holds more than ${MAX_AVIF_ITEMS} item entries, over the cap`
			);
		}
		parseInfe(box.body, items, seen);
	}
	// The declared count and the records present must agree: a count that
	// understates the records is what a decoy hides behind, and one that
	// overstates them points a reader at entries this walk never saw.
	if (entries !== declared) {
		throw new UnscrubbableImageError(
			`avif: the iinf box declares ${declared} item entries but holds ${entries}`
		);
	}
}

function parseInfe(body: Uint8Array, items: Map<number, 'exif' | 'xmp'>, seen: Set<number>): void {
	if (body.length < 4) throw new UnscrubbableImageError('avif: infe box is truncated');
	const version = body[0];
	// Versions 0 and 1 predate item_type, so there is no way to tell what the
	// entry describes. AVIF requires 2 or 3, and skipping the entry would let a
	// version-1 infe hide the Exif item from the walk entirely, so anything else
	// is refused.
	if (version !== 2 && version !== 3) {
		throw new UnscrubbableImageError(`avif: an infe box declares version ${version}, which AVIF does not use`);
	}
	let p = 4;
	const idLen = version === 2 ? 2 : 4;
	if (body.length < p + idLen + 2 + 4) throw new UnscrubbableImageError('avif: infe box is truncated');
	const id = idLen === 2 ? u16(body, p, true) : u32(body, p, true);
	// Two infe entries for one item_ID: the second overwrites the first here,
	// while a reader may keep either — so a decoy declaring the Exif item to be
	// some type we skip would leave the real payload unrewritten.
	if (seen.has(id)) {
		throw new UnscrubbableImageError(`avif: the iinf box names item ${id} more than once`);
	}
	seen.add(id);
	p += idLen + 2; // item_ID, then item_protection_index
	// The four-character type is compared lowercased: `exif` is the same item to
	// a reader as `Exif`, and matching only the spelled-out case let the other
	// through unscrubbed.
	const itemType = String.fromCharCode(body[p], body[p + 1], body[p + 2], body[p + 3]).toLowerCase();
	p += 4;
	const name = readCString(body, p);
	p = name.next;
	if (itemType === 'exif') {
		items.set(id, 'exif');
		return;
	}
	if (itemType !== 'mime') {
		// Everything left is either an item a real AVIF carries and the scrubber
		// knows holds no metadata, or an item type we cannot reason about at all.
		// Skipping the unknown ones is what lets a relabelled Exif payload ride
		// through unrewritten, so the inert set is spelled out and the rest refused.
		if (!INERT_AVIF_ITEM_TYPES.has(itemType)) {
			throw new UnscrubbableImageError(
				`avif: the iinf box names an item of type "${loggable(itemType)}", which the scrubber does not know`
			);
		}
		return;
	}
	// A content_type carries parameters (";charset=…") and any casing, and a
	// reader normalises both before deciding the item is XMP, so this has to as
	// well. Anything else is a mime payload the scrubber cannot classify — a
	// real AVIF has none — so it is refused rather than passed through.
	const contentType = readCString(body, p).text.split(';')[0].trim().toLowerCase();
	if (contentType !== 'application/rdf+xml') {
		// Stripped and truncated: the content_type comes from the file (see
		// loggable), and the message ends up in a log line.
		throw new UnscrubbableImageError(
			`avif: a mime item declares content type "${loggable(contentType)}", which is not XMP`
		);
	}
	items.set(id, 'xmp');
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
	// The index bytes are stepped over rather than read, so this width never
	// reaches readUint's check the way offset_size and length_size do. A width no
	// reader supports would still move the cursor, putting every extent after it
	// at bytes the file never meant, so it is checked against the same widths.
	if (indexSize !== 0 && indexSize !== 4 && indexSize !== 8) {
		throw new UnscrubbableImageError(`avif: unsupported iloc field width ${indexSize}`);
	}
	// An extent with neither an offset nor a length addresses no bytes at all,
	// and declaring one costs no input bytes either — which is what makes the
	// item list an allocation bomb: a 2 KB meta box can name millions of extents
	// nothing could ever rewrite.
	if (offsetSize === 0 && lengthSize === 0) {
		throw new UnscrubbableImageError('avif: an iloc extent declares neither an offset nor a length');
	}
	let p = 6;
	const idLen = version === 2 ? 4 : 2;
	const countLen = version === 2 ? 4 : 2;
	const itemCount = countLen === 2 ? u16(body, p, true) : u32(body, p, true);
	p += countLen;
	if (itemCount > MAX_AVIF_ITEMS) {
		throw new UnscrubbableImageError(
			`avif: the iloc box lists ${itemCount} items, over the ${MAX_AVIF_ITEMS}-item cap`
		);
	}
	let extentTotal = 0;
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
		extentTotal += extentCount;
		if (extentTotal > MAX_ILOC_EXTENTS) {
			throw new UnscrubbableImageError(
				`avif: the iloc box lists ${extentTotal} extents, over the ${MAX_ILOC_EXTENTS}-extent cap`
			);
		}
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
		// Two entries for one item_ID: the last one wins in this map, so a decoy
		// placed after the real entry moves the scrubber off the real payload
		// while a reader that keeps the first still finds it.
		if (out.has(id)) {
			throw new UnscrubbableImageError(`avif: the iloc box places item ${id} more than once`);
		}
		out.set(id, { method, extents });
	}
	return out;
}

/**
 * Text taken from the file on its way into a refusal message. The message ends
 * up in a log line and an operator-facing failure list, so a newline or a
 * control character — which is what a four-character code or a content_type
 * would need to forge a log line of its own — is dropped, and the rest is
 * truncated.
 */
function loggable(text: string): string {
	return text.replace(/[^\x20-\x7e]/g, '').slice(0, 64);
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
			// "Runs to the end of the parent" inside a meta box is how a decoy
			// swallows the iinf that follows it: a reader that knows the box type
			// skips its 8 bytes and finds the item list, this walk would not.
			throw new UnscrubbableImageError(`avif: the ${loggable(type)} box inside the meta box declares no size`);
		}
		if (size < headerLen || p + size > body.length) {
			throw new UnscrubbableImageError(`avif: ${loggable(type)} box declares a size past its parent`);
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
// GIF
// ---------------------------------------------------------------------------

/** The 11-byte application identifier + auth code of an XMP extension. */
const GIF_XMP_ID = ascii('XMP DataXMP');

/**
 * Length of the magic trailer that closes a GIF XMP extension: 0x01, then the
 * 256 descending bytes 0xFF…0x00, then the block terminator. Its shape is what
 * makes a sub-block walk over raw XML land on the terminator instead of running
 * away, which is how a decoder skips the extension and how the walk below finds
 * where the payload ends.
 */
const GIF_XMP_TRAILER_BYTES = 258;

/**
 * Walk the block stream: header, logical screen descriptor, an optional global
 * colour table, then blocks until the trailer.
 *
 * GIF has no Exif field, but GIF89a carries XMP in an application extension
 * labelled `XMP DataXMP`, and Photoshop and Lightroom write GPS coordinates
 * there — so the pass-through this format used to get was a hole. That one
 * extension's payload is replaced with an empty packet; every other block,
 * comment extension included, is copied byte for byte (same call as the JPEG
 * comment segment: it sometimes carries the artist's own notice). Bytes after
 * the trailer are zeroed.
 */
function* scrubGif(): Machine {
	// Signature and version (6) plus the logical screen descriptor (7).
	const header = yield { kind: 'take', n: 13 };
	yield { kind: 'write', bytes: header };
	if (header[10] & 0x80) yield { kind: 'copy', n: 3 * (1 << ((header[10] & 0x07) + 1)) };
	for (;;) {
		const introducer = yield { kind: 'take', n: 1 };
		yield { kind: 'write', bytes: introducer };
		if (introducer[0] === 0x3b) {
			// Trailer. A decoder stops here, so anything after it is unexamined
			// bytes — a whole second GIF with its own XMP extension fits there —
			// and it is zeroed like the JPEG trailer rather than passed through.
			yield* zeroToEnd();
			return;
		}
		if (introducer[0] === 0x2c) {
			const descriptor = yield { kind: 'take', n: 9 };
			yield { kind: 'write', bytes: descriptor };
			if (descriptor[8] & 0x80) yield { kind: 'copy', n: 3 * (1 << ((descriptor[8] & 0x07) + 1)) };
			yield { kind: 'copy', n: 1 }; // LZW minimum code size
			yield* copyGifSubBlocks();
			continue;
		}
		if (introducer[0] === 0x00) {
			// Some encoders pad between blocks with a zero byte; decoders step over
			// it, and the animation sniffer already tolerates it (see the
			// paddedMultiFrameGif fixture), so it is written through rather than
			// refusing a file that displays fine everywhere else. The rest of the
			// run goes through a block at a time: a file that is mostly pad would
			// otherwise cost one emitted piece per byte.
			const block = yield { kind: 'takeUpTo', n: SCAN_BLOCK_BYTES };
			let at = 0;
			while (at < block.length && block[at] === 0x00) at++;
			if (at) yield { kind: 'write', bytes: block.subarray(0, at) };
			yield { kind: 'unread', bytes: block.subarray(at) };
			continue;
		}
		if (introducer[0] !== 0x21) {
			throw new UnscrubbableImageError(
				`gif: expected a block introducer, found 0x${introducer[0].toString(16)}`
			);
		}
		const label = yield { kind: 'take', n: 1 };
		yield { kind: 'write', bytes: label };
		if (label[0] === 0xff) {
			yield* scrubGifApplication();
			continue;
		}
		yield* copyGifSubBlocks();
	}
}

/** Copy a sub-block chain through, terminator included. */
function* copyGifSubBlocks(): Machine {
	for (;;) {
		const size = yield { kind: 'take', n: 1 };
		yield { kind: 'write', bytes: size };
		if (size[0] === 0) return;
		yield { kind: 'copy', n: size[0] };
	}
}

function* scrubGifApplication(): Machine {
	const size = yield { kind: 'take', n: 1 };
	yield { kind: 'write', bytes: size };
	if (size[0] === 0) return; // an application extension with no identifier block
	const identifier = yield { kind: 'take', n: size[0] };
	yield { kind: 'write', bytes: identifier };
	if (size[0] !== GIF_XMP_ID.length || !startsWith(identifier, GIF_XMP_ID)) {
		// A label that reads as XMP to a looser reader than this one — "XMP Dataxmp",
		// or the identifier without its auth code — is refused rather than copied:
		// the payload behind it is raw XML with no sub-block structure, so copying
		// it through is the one way GPS could still leave this walk intact.
		if (looksLikeGifXmp(identifier)) {
			throw new UnscrubbableImageError(
				'gif: an application extension labelled like XMP but not exactly "XMP DataXMP"'
			);
		}
		yield* copyGifSubBlocks();
		return;
	}
	yield* scrubGifXmp();
}

/** Whether the first 8 bytes of an identifier spell "XMP Data" in any case. */
function looksLikeGifXmp(identifier: Uint8Array): boolean {
	if (identifier.length < 8) return false;
	for (let i = 0; i < 8; i++) {
		// ASCII letters differ from their other case by 0x20, and the space and
		// the rest of the label carry that bit already.
		if ((identifier[i] | 0x20) !== (GIF_XMP_ID[i] | 0x20)) return false;
	}
	return true;
}

/**
 * Replace the payload of an XMP application extension. The payload is raw XML,
 * NOT a sub-block chain — the magic trailer is what makes a chain walk over it
 * terminate — so the whole region is buffered, the trailer kept, and everything
 * in front of it overwritten with an empty packet plus space padding. The
 * padding is ASCII, so a walk entering it still steps forward by at most 127
 * bytes and lands inside the trailer, which resolves to the terminator from any
 * offset within itself.
 */
function* scrubGifXmp(): Machine {
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const size = yield { kind: 'take', n: 1 };
		parts.push(size);
		total += 1;
		if (size[0] === 0) break;
		const block = yield { kind: 'take', n: size[0] };
		parts.push(block);
		total += size[0];
		if (total > MAX_RECORD_BYTES) {
			throw new UnscrubbableImageError(
				`gif: the XMP extension is over the ${MAX_RECORD_BYTES}-byte cap`
			);
		}
	}
	const region = concat(parts);
	if (
		region.length < GIF_XMP_TRAILER_BYTES ||
		region[region.length - GIF_XMP_TRAILER_BYTES] !== 0x01 ||
		region[region.length - GIF_XMP_TRAILER_BYTES + 1] !== 0xff
	) {
		throw new UnscrubbableImageError(
			'gif: the XMP extension does not end in the magic trailer, so its payload cannot be located'
		);
	}
	const out = new Uint8Array(region.length);
	const payloadLen = region.length - GIF_XMP_TRAILER_BYTES;
	out.set(emptyXmpPacket(payloadLen), 0);
	out.set(region.subarray(payloadLen), payloadLen);
	yield { kind: 'write', bytes: out };
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
 * Returns a buffer of exactly `capacity` bytes, zero-filled when `capacity`
 * cannot hold even an empty directory. A malformed original does NOT throw: an
 * unreadable IFD yields an empty directory, because losing an orientation hint
 * beats refusing the upload.
 */
function minimalTiff(tiff: Uint8Array, capacity: number, keepOrientation: boolean): Uint8Array {
	// Too small for even an empty directory: zeros, which a decoder skips.
	if (capacity < MIN_TIFF_BYTES) return new Uint8Array(Math.max(capacity, 0));
	// 'MM' is big-endian, 'II' little, and anything else is not a TIFF header —
	// derived once here, because the rewrite has to be written in the SAME byte
	// order it was read in.
	const bigEndian = tiff.length >= 2 && tiff[0] === 0x4d && tiff[1] === 0x4d;
	const littleEndian = tiff.length >= 2 && tiff[0] === 0x49 && tiff[1] === 0x49;
	// No byte-order mark at all is what an ALREADY-ZEROED record looks like, and a
	// record too small for a directory behind its prefix is zeroed whole — so
	// fabricating a directory here would make a second scrub of a scrubbed file
	// change bytes. Zeros stay zeros; a real header with an unreadable IFD still
	// gets the empty directory below.
	if (!bigEndian && !littleEndian) return new Uint8Array(capacity);
	const tags: KeptTags = readIfd0(tiff, bigEndian);
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
