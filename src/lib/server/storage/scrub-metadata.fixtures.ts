// Hand-built raster fixtures for the metadata scrubber (SONA-170).
//
// Built byte by byte rather than checked in as binaries: the point of each
// fixture is the metadata records it contains, and a hex blob hides those. Kept
// in their own module so other suites (storage decorator tests, the workerd
// parity harness) can put the same real bytes instead of placeholder buffers.

import { ascii, PNG_MAGIC } from '../test/raster-fixtures';

// ascii and the PNG signature already exist for the animation-sniff suites;
// re-exported so the scrubber tests keep one import site.
export { ascii };

/** ASCII bytes of `text` plus a trailing NUL. */
function cstring(text: string): number[] {
	return [...ascii(text), 0];
}

function u16be(value: number): number[] {
	return [(value >> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function bytes(...parts: (number | number[])[]): Uint8Array {
	return Uint8Array.from(parts.flat());
}

// ---------------------------------------------------------------------------
// TIFF / Exif
// ---------------------------------------------------------------------------

const TAG_ORIENTATION = 0x0112;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_MAKERNOTE = 0x927c;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE = 0x0004;
const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

interface Entry {
	tag: number;
	type: number;
	count: number;
	/** Inline 4-byte value, or bytes to place in the data area. */
	inline?: number[];
	data?: number[];
	/** Resolved during layout when `data` is used. */
	pointerToIfd?: 'exif' | 'gps';
}

/** Lay out one IFD at `at`, returning its bytes plus the data that follows it. */
function layoutIfd(entries: Entry[], at: number, next: number, offsets: Record<string, number>): number[] {
	const sorted = [...entries].sort((a, b) => a.tag - b.tag);
	const dataStart = at + 2 + sorted.length * 12 + 4;
	let dataAt = dataStart;
	const data: number[] = [];
	const out: number[] = [...u16be(sorted.length)];
	for (const entry of sorted) {
		out.push(...u16be(entry.tag), ...u16be(entry.type), ...u32be(entry.count));
		if (entry.pointerToIfd) {
			out.push(...u32be(offsets[entry.pointerToIfd]));
		} else if (entry.inline) {
			const padded = [...entry.inline, 0, 0, 0, 0].slice(0, 4);
			out.push(...padded);
		} else {
			out.push(...u32be(dataAt));
			data.push(...entry.data!);
			dataAt += entry.data!.length;
		}
	}
	out.push(...u32be(next));
	return [...out, ...data];
}

export interface ExifOptions {
	orientation?: number;
	artist?: string;
	copyright?: string;
	/** Include the Exif sub-IFD (DateTimeOriginal + a MakerNote). */
	subIfd?: boolean;
	/** Include a GPS IFD with a latitude and longitude. */
	gps?: boolean;
	/** Include IFD1 with a fake embedded thumbnail. */
	thumbnail?: boolean;
	/** Write an IFD0 offset past the end of the payload (a malformed original). */
	badIfdOffset?: boolean;
}

/**
 * A big-endian Exif TIFF. Every optional part is a real, separately-addressed
 * IFD so the scrubbed output can be checked for its absence rather than for the
 * absence of a substring.
 */
export function exifTiff(opts: ExifOptions = {}): number[] {
	const header = [...ascii('MM'), ...u16be(42), ...u32be(opts.badIfdOffset ? 0xffff : 8)];
	// Lay the sub-IFDs out after a generous IFD0 allowance, then place IFD0's
	// pointers at those addresses. Overlap is impossible because IFD0's own data
	// area is sized from its entry list below.
	const ifd0Entries: Entry[] = [];
	if (opts.orientation !== undefined) {
		ifd0Entries.push({
			tag: TAG_ORIENTATION,
			type: TYPE_SHORT,
			count: 1,
			inline: u16be(opts.orientation)
		});
	}
	if (opts.artist !== undefined) {
		ifd0Entries.push({ tag: TAG_ARTIST, type: TYPE_ASCII, count: opts.artist.length + 1, data: cstring(opts.artist) });
	}
	if (opts.copyright !== undefined) {
		ifd0Entries.push({
			tag: TAG_COPYRIGHT,
			type: TYPE_ASCII,
			count: opts.copyright.length + 1,
			data: cstring(opts.copyright)
		});
	}
	if (opts.subIfd) ifd0Entries.push({ tag: TAG_EXIF_IFD, type: TYPE_LONG, count: 1, pointerToIfd: 'exif' });
	if (opts.gps) ifd0Entries.push({ tag: TAG_GPS_IFD, type: TYPE_LONG, count: 1, pointerToIfd: 'gps' });

	// Two passes: the first sizes IFD0 (with placeholder pointers), the second
	// writes the real sub-IFD addresses.
	const sized = layoutIfd(ifd0Entries, 8, 0, { exif: 0, gps: 0 });
	const exifAt = 8 + sized.length;
	const exifEntries: Entry[] = [
		{ tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, count: 20, data: cstring('2019:07:04 11:22:33') },
		{ tag: TAG_MAKERNOTE, type: TYPE_BYTE, count: 8, data: [...ascii('MAKERNOT')] }
	];
	const exifIfd = opts.subIfd ? layoutIfd(exifEntries, exifAt, 0, {}) : [];
	const gpsAt = exifAt + exifIfd.length;
	const gpsEntries: Entry[] = [
		// 51/1 30/1 0/1 — a real-looking latitude, as three RATIONALs.
		{
			tag: TAG_GPS_LATITUDE,
			type: TYPE_RATIONAL,
			count: 3,
			data: [...u32be(51), ...u32be(1), ...u32be(30), ...u32be(1), ...u32be(0), ...u32be(1)]
		},
		{
			tag: TAG_GPS_LONGITUDE,
			type: TYPE_RATIONAL,
			count: 3,
			data: [...u32be(0), ...u32be(1), ...u32be(7), ...u32be(1), ...u32be(0), ...u32be(1)]
		}
	];
	const gpsIfd = opts.gps ? layoutIfd(gpsEntries, gpsAt, 0, {}) : [];
	const ifd1At = gpsAt + gpsIfd.length;
	const ifd1 = opts.thumbnail
		? layoutIfd(
				[{ tag: 0x0201, type: TYPE_LONG, count: 1, inline: u32be(ifd1At + 30) }, { tag: 0x0202, type: TYPE_LONG, count: 1, inline: u32be(8) }],
				ifd1At,
				0,
				{}
			)
		: [];
	const thumb = opts.thumbnail ? [...ascii('THUMBNAI')] : [];
	const ifd0 = layoutIfd(ifd0Entries, 8, opts.thumbnail ? ifd1At : 0, { exif: exifAt, gps: gpsAt });
	return [...header, ...ifd0, ...exifIfd, ...gpsIfd, ...ifd1, ...thumb];
}

/** An XMP packet carrying a GPS latitude, long enough to pad an empty one into. */
function xmpWithGps(): number[] {
	return ascii(
		'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
			'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
			'<rdf:Description exif:GPSLatitude="51,30.000000N" exif:GPSLongitude="0,7.000000W"/>' +
			'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
	);
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** One marker segment: FF <marker> <2-byte length> <payload>. */
function segment(marker: number, payload: number[]): number[] {
	return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

export interface JpegOptions {
	exif?: ExifOptions | null;
	/** Truncate the file mid-segment (the length field promises more than exists). */
	truncated?: boolean;
	/**
	 * Put a whole second JPEG after the EOI, Exif GPS and all — the shape an MPF
	 * preview and a motion photo's trailer both take.
	 */
	gpsTrailer?: boolean;
	/**
	 * The progressive shape: a second scan, with a DQT between the two whose
	 * table bytes contain FF D9 — the pair a blind end-of-image search stops at.
	 */
	secondScan?: boolean;
	/** With `secondScan`, an APP1 Exif GPS segment in front of the second scan. */
	exifBetweenScans?: boolean;
	/** EOI straight after the JFIF segment, with no scan at all, then a trailer. */
	noScan?: boolean;
}

/** The junk every non-truncated jpegFixture() parks after its EOI. */
export const JPEG_TRAILER = 'trailing junk after EOI';

/**
 * A JPEG carrying every segment kind the scrubber has an opinion about: APP0
 * JFIF, APP1 Exif, APP1 XMP, APP2 ICC, APP2 MPF, APP13 Photoshop/IPTC, COM,
 * DQT, SOF0, DHT, SOS with entropy data, EOI, and a junk trailer after EOI.
 */
export function jpegFixture(opts: JpegOptions = {}): Uint8Array {
	const exif = opts.exif === null ? null : exifTiff(opts.exif ?? { orientation: 6, artist: 'Nova Sparks', copyright: '(c) 2019 Nova Sparks', subIfd: true, gps: true, thumbnail: true });
	const parts: number[] = [0xff, 0xd8];
	parts.push(...segment(0xe0, [...cstring('JFIF'), 1, 2, 0, ...u16be(72), ...u16be(72), 0, 0]));
	if (opts.noScan) {
		// The marker loop's own end-of-image path: a file that reaches EOI before
		// any SOS still has a trailer to zero.
		parts.push(0xff, 0xd9, ...ascii(JPEG_TRAILER));
		return Uint8Array.from(parts);
	}
	if (exif) parts.push(...segment(0xe1, [...ascii('Exif'), 0, 0, ...exif]));
	parts.push(...segment(0xe1, [...cstring('http://ns.adobe.com/xap/1.0/'), ...xmpWithGps()]));
	parts.push(...segment(0xe2, [...cstring('ICC_PROFILE'), 1, 1, ...ascii('fake icc profile bytes')]));
	parts.push(...segment(0xe2, [...cstring('MPF'), ...ascii('MM'), ...u16be(42), ...u32be(8), ...ascii('mpf index with a preview offset')]));
	parts.push(...segment(0xed, [...cstring('Photoshop 3.0'), ...ascii('8BIM'), 0x04, 0x04, ...ascii('IPTC city: London')]));
	parts.push(...segment(0xfe, ascii('a plain comment')));
	parts.push(...segment(0xdb, [0x00, ...new Array(64).fill(0x10)]));
	parts.push(...segment(0xc0, [0x08, ...u16be(8), ...u16be(8), 1, 0x01, 0x11, 0x00]));
	parts.push(...segment(0xc4, [0x00, ...new Array(16).fill(0), ...new Array(1).fill(0x0a)]));
	if (opts.truncated) {
		// A segment whose declared length runs past the end of the file.
		parts.push(0xff, 0xe1, ...u16be(500), ...ascii('short'));
		return Uint8Array.from(parts);
	}
	parts.push(...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
	// A stuffed 0xFF (FF 00) and a restart marker (FF D0) inside the scan: the
	// two things an EOI search must not mistake for the end of the image.
	parts.push(...ascii('entropy'), 0xff, 0x00, ...ascii('scan'), 0xff, 0xd0, ...ascii('data'));
	if (opts.secondScan) {
		// A quantisation table whose bytes happen to contain FF D9. A search that
		// only looks for that pair stops here and zeroes the rest of the picture,
		// real EOI included.
		parts.push(...segment(0xdb, [0x01, ...new Array(30).fill(0x11), 0xff, 0xd9, ...new Array(32).fill(0x11)]));
		if (opts.exifBetweenScans) {
			parts.push(...segment(0xe1, [...ascii('Exif'), 0, 0, ...exifTiff({ artist: 'Nova Sparks', gps: true, subIfd: true })]));
		}
		parts.push(...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
		parts.push(...ascii('second'), 0xff, 0x00, ...ascii('scan'), 0xff, 0xd7, ...ascii('bytes'));
	}
	parts.push(0xff, 0xd9);
	if (opts.gpsTrailer) {
		parts.push(
			0xff,
			0xd8,
			...segment(0xe1, [...ascii('Exif'), 0, 0, ...exifTiff({ gps: true, subIfd: true })]),
			...ascii('preview scan'),
			0xff,
			0xd9
		);
		return Uint8Array.from(parts);
	}
	parts.push(...ascii(JPEG_TRAILER));
	return Uint8Array.from(parts);
}

/** Offset of the first byte of the SOS marker in `jpegFixture()`. */
export function jpegSosOffset(file: Uint8Array): number {
	for (let i = 2; i + 1 < file.length; i++) {
		if (file[i] === 0xff && file[i + 1] === 0xda) return i;
	}
	return -1;
}

/**
 * Find a marker segment's payload range (the bytes after its 2-byte length),
 * matching on the payload's leading identifier so APP1 Exif and APP1 XMP can be
 * told apart. Returns null when no such segment exists.
 */
export function findSegment(
	file: Uint8Array,
	marker: number,
	identifier?: string
): { start: number; end: number } | null {
	let at = 2;
	while (at + 4 <= file.length) {
		if (file[at] !== 0xff) return null;
		const code = file[at + 1];
		if (code === 0xda || code === 0xd9) return null;
		const length = (file[at + 2] << 8) | file[at + 3];
		const start = at + 4;
		const end = at + 2 + length;
		if (code === marker) {
			const id = identifier ? String.fromCharCode(...file.subarray(start, start + identifier.length)) : null;
			if (!identifier || id === identifier) return { start, end };
		}
		at = end;
	}
	return null;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

/** PNG's CRC-32, reimplemented here so the fixtures don't lean on the code under test. */
export function pngCrc(data: number[] | Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
	const typed = [...ascii(type), ...data];
	return [...u32be(data.length), ...typed, ...u32be(pngCrc(typed))];
}

/**
 * A PNG with the metadata chunks the scrubber rewrites (eXIf, tEXt, zTXt, iTXt
 * holding XMP, plus the case variants exIf/zxIf/tXMP an encoder may write)
 * alongside ones it must leave alone (iCCP, pHYs, IDAT and the APNG chunks).
 */
export interface PngOptions {
	/** Append an eXIf chunk AFTER IEND, where a reader stops looking. */
	afterIend?: boolean;
}

export function pngFixture(opts: PngOptions = {}): Uint8Array {
	const parts: number[] = [...PNG_MAGIC];
	parts.push(...pngChunk('IHDR', [...u32be(8), ...u32be(8), 8, 2, 0, 0, 0]));
	parts.push(...pngChunk('eXIf', exifTiff({ orientation: 3, artist: 'Nova Sparks', copyright: '(c) Nova', gps: true, subIfd: true })));
	// The case bits are flags, not identity: exIf/zxIf/tXMP mean the same thing.
	parts.push(...pngChunk('exIf', exifTiff({ gps: true, subIfd: true })));
	parts.push(...pngChunk('zxIf', [0, ...ascii('fake deflated exif with GPSLatitude 51.5')]));
	parts.push(...pngChunk('tXMP', xmpWithGps()));
	parts.push(...pngChunk('iCCP', [...cstring('icc'), 0, ...ascii('fake deflate stream')]));
	parts.push(...pngChunk('pHYs', [...u32be(2835), ...u32be(2835), 1]));
	parts.push(...pngChunk('acTL', [...u32be(2), ...u32be(0)]));
	parts.push(...pngChunk('tEXt', [...cstring('Comment'), ...ascii('shot at 51.5,-0.12')]));
	parts.push(...pngChunk('zTXt', [...cstring('Location'), 0, ...ascii('fake deflate stream')]));
	parts.push(...pngChunk('iTXt', [...cstring('XML:com.adobe.xmp'), 0, 0, 0, 0, ...xmpWithGps()]));
	parts.push(...pngChunk('fcTL', [...u32be(0), ...u32be(8), ...u32be(8), ...u32be(0), ...u32be(0), ...u16be(1), ...u16be(10), 0, 0]));
	parts.push(...pngChunk('IDAT', [...ascii('fake idat payload')]));
	parts.push(...pngChunk('fdAT', [...u32be(1), ...ascii('fake second frame')]));
	parts.push(...pngChunk('IEND', []));
	if (opts.afterIend) parts.push(...pngChunk('eXIf', exifTiff({ gps: true, subIfd: true })));
	return Uint8Array.from(parts);
}

/** Walk a PNG's chunks: { type, dataStart, dataEnd, crc }. */
export function pngChunks(file: Uint8Array): { type: string; dataStart: number; dataEnd: number; crc: number }[] {
	const out: { type: string; dataStart: number; dataEnd: number; crc: number }[] = [];
	let at = 8;
	while (at + 12 <= file.length) {
		const length = ((file[at] << 24) | (file[at + 1] << 16) | (file[at + 2] << 8) | file[at + 3]) >>> 0;
		const type = String.fromCharCode(file[at + 4], file[at + 5], file[at + 6], file[at + 7]);
		const dataStart = at + 8;
		const dataEnd = dataStart + length;
		const crc =
			((file[dataEnd] << 24) | (file[dataEnd + 1] << 16) | (file[dataEnd + 2] << 8) | file[dataEnd + 3]) >>> 0;
		out.push({ type, dataStart, dataEnd, crc });
		at = dataEnd + 4;
	}
	return out;
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

function riffChunk(fourcc: string, data: number[]): number[] {
	const pad = data.length & 1 ? [0] : [];
	return [...ascii(fourcc), ...u32le(data.length), ...data, ...pad];
}

export interface WebpOptions {
	/** Append bytes past the declared RIFF size, where a reader stops looking. */
	trailer?: string;
	/** Spell the EXIF chunk's fourcc lowercase, as a sloppy writer may. */
	lowercaseExif?: boolean;
}

/**
 * An extended-format (VP8X) WebP with ICCP, animation, VP8, EXIF and XMP
 * chunks. The ICCP payload is deliberately odd-length so the pad byte is
 * exercised.
 */
export function webpFixture(opts: WebpOptions = {}): Uint8Array {
	const chunks = [
		// Flags byte: ICC (0x20) | EXIF (0x08) | XMP (0x04) | ANIM (0x02); then canvas size.
		...riffChunk('VP8X', [0x2e, 0, 0, 0, 7, 0, 0, 7, 0, 0]),
		...riffChunk('ICCP', ascii('an odd-length icc')),
		...riffChunk('ANIM', [0, 0, 0, 0xff, 0, 0]),
		...riffChunk('ANMF', [...ascii('fake frame header'), ...ascii('and its payload')]),
		...riffChunk('VP8 ', ascii('fake lossy bitstream')),
		...riffChunk(
			opts.lowercaseExif ? 'exif' : 'EXIF',
			exifTiff({ orientation: 8, copyright: '(c) Nova', gps: true })
		),
		...riffChunk('XMP ', xmpWithGps())
	];
	return Uint8Array.from([
		...ascii('RIFF'),
		...u32le(4 + chunks.length),
		...ascii('WEBP'),
		...chunks,
		...ascii(opts.trailer ?? '')
	]);
}

/** A simple-format (VP8-only) WebP, which has nowhere to put metadata. */
export function webpSimpleFixture(): Uint8Array {
	const chunks = riffChunk('VP8 ', ascii('fake lossy bitstream, odd'));
	return Uint8Array.from([...ascii('RIFF'), ...u32le(4 + chunks.length), ...ascii('WEBP'), ...chunks]);
}

/** Walk a RIFF file's chunks: { fourcc, dataStart, dataEnd }. */
export function riffChunks(file: Uint8Array): { fourcc: string; dataStart: number; dataEnd: number }[] {
	const out: { fourcc: string; dataStart: number; dataEnd: number }[] = [];
	let at = 12;
	while (at + 8 <= file.length) {
		const fourcc = String.fromCharCode(file[at], file[at + 1], file[at + 2], file[at + 3]);
		const size = (file[at + 4] | (file[at + 5] << 8) | (file[at + 6] << 16) | (file[at + 7] << 24)) >>> 0;
		out.push({ fourcc, dataStart: at + 8, dataEnd: at + 8 + size });
		at += 8 + size + (size & 1);
	}
	return out;
}

// ---------------------------------------------------------------------------
// AVIF
// ---------------------------------------------------------------------------

function isoBox(type: string, body: number[]): number[] {
	return [...u32be(body.length + 8), ...ascii(type), ...body];
}

/**
 * A QuickTime `©xyz` location atom, coordinates and all: a 2-byte string
 * length, a 2-byte language code, then ISO 6709 text. The `©` is 0xA9, so the
 * four-character type is built rather than written as ASCII.
 */
function quickTimeLocationAtom(): number[] {
	const coords = ascii('+37.7749-122.4194/');
	return [...u32be(coords.length + 12), 0xa9, ...ascii('xyz'), ...u16be(coords.length), ...u16be(0), ...coords];
}

/** BE7ACFCB-97A9-42E8-9C71-999491E3AFAC: the UUID Adobe stamps an XMP box with. */
const ADOBE_XMP_UUID = [
	0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac
];

function fullBox(type: string, version: number, flags: number, body: number[]): number[] {
	return isoBox(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, ...body]);
}

function infe(id: number, itemType: string, name: string, contentType?: string, version = 2): number[] {
	// Versions other than 2 are written with a v2 body on purpose: the parser
	// refuses on the version byte alone, so what follows it never gets read.
	return fullBox('infe', version, 0, [
		...u16be(id),
		...u16be(0),
		...ascii(itemType),
		...cstring(name),
		...(contentType ? cstring(contentType) : [])
	]);
}

export interface AvifOptions {
	/** Use iloc v1 with construction_method 1 (idat) for the Exif item. */
	idatConstruction?: boolean;
	/** Declare mdat with size==1 and a 64-bit largesize. */
	largeMdat?: boolean;
	/** Declare an Exif extent far past the record cap (the real payload is unchanged). */
	hugeExifExtent?: boolean;
	/** Insert a size-0 `free` box ("to end of file") ahead of the meta box. */
	freeBoxBeforeMeta?: boolean;
	/** Split the Exif item across two extents, which cannot be rewritten in place. */
	splitExifExtent?: boolean;
	/** Put a `free` box holding an XMP packet between the mdat and the end of the file. */
	freeBoxAfterMdat?: boolean;
	/**
	 * Put a `uuid` box after the mdat carrying the Adobe XMP UUID and a packet
	 * with GPS — where an editor parks XMP that has no box of its own.
	 */
	uuidBoxAfterMdat?: boolean;
	/** Put a box of a top-level type no AVIF carries after the mdat. */
	unknownBoxAfterMdat?: boolean;
	/**
	 * Put a `moov` box after the mdat whose `udta` holds a QuickTime `©xyz`
	 * location atom — the box an `avis` image sequence carries, with coordinates
	 * in a place the walk does not descend into.
	 */
	moovBoxAfterMdat?: boolean;
	/**
	 * Write the trailing box with a declared size of 0 ("runs to the end of the
	 * file") as a `free`, `skip` or `uuid` padding box holding an XMP packet, or
	 * as a `ftyp` — a box that has no business claiming the rest of the file.
	 */
	zeroSizeTrailingBox?: 'free' | 'skip' | 'uuid' | 'ftyp';
	/**
	 * Write a 76-byte ftyp with `mif1` as the major brand and `avif` as the last
	 * compatible brand, at offset 72 — past a 64-byte sniff window.
	 */
	longFtyp?: boolean;
	/**
	 * Hold the Exif and XMP payloads in a SECOND mdat, with a `free` box between
	 * it and the mdat holding the av01 — so the extents sit two boxes past the
	 * meta box rather than in the one right after it.
	 */
	splitMdat?: boolean;
	/**
	 * Append a second meta + mdat pair, Exif GPS and XMP and all, after the end
	 * of a complete AVIF — the bytes a walk that stopped at the last extent
	 * would hand back untouched.
	 */
	secondMeta?: boolean;
	/** Point the Exif extent past the end of the file. */
	exifExtentPastEnd?: boolean;
	/** Give the Exif extent a length that runs out of the mdat into the next box. */
	straddlingExifExtent?: boolean;
	/** Name the Exif item in iinf but leave it out of the iloc, so it has no place. */
	exifItemWithoutLocation?: boolean;
	/** Add a decoy iloc box before or after the real one. */
	decoyIloc?: 'before' | 'after';
	/** Add a decoy iinf box naming the Exif item a second time. */
	decoyIinf?: boolean;
	/**
	 * Put a `uuid` box carrying the Adobe XMP UUID and a packet with GPS INSIDE
	 * the meta box, where no item list names it.
	 */
	uuidInsideMeta?: boolean;
	/**
	 * Put that same `uuid` box one level DOWN inside the meta box: in the `ipco`
	 * property list, or in an `iref` next to a real `dimg` reference.
	 */
	uuidDeepInMeta?: 'ipco' | 'iref';
	/**
	 * Fill the `ipco` with the property boxes a real encoder writes — `ispe`,
	 * `pixi`, `colr` and `auxC` alongside `av1C` and `irot` — none of which the
	 * walk knows by name.
	 */
	richIpco?: boolean;
	/** Write the XMP item's content_type as this instead of `application/rdf+xml`. */
	xmpContentType?: string;
	/** Spell the Exif item's four-character type in lower case. */
	lowercaseExifType?: boolean;
	/** Write the Exif item's four-character type as this (a relabelled payload). */
	exifItemType?: string;
	/** Write the XMP item's four-character type as this instead of `mime`. */
	xmpItemType?: string;
	/** Write the Exif item's infe box at this version instead of 2. */
	exifInfeVersion?: number;
	/** Write the XMP item's infe box at this version instead of 2. */
	xmpInfeVersion?: number;
	/** Name a `grid` and an `iovl` item as well: derived images a real AVIF carries. */
	derivedItems?: boolean;
	/**
	 * Keep the entry_count legal (3) but follow it with far more infe records
	 * than the item cap, each with its own item_ID — the records cost the file
	 * about 20 bytes apiece and the parser a map entry apiece.
	 */
	iinfRecordBomb?: boolean;
	/** Declare an iloc index_size of 2, a width no reader supports. */
	ilocIndexWidth?: boolean;
	/** Name only the av01 item: a legitimately metadata-free AVIF. */
	noMetadataItems?: boolean;
	/**
	 * Rewrite the `pitm` box's header so it hides the `iinf` that follows it —
	 * `sizeZero` declares "to the end of the parent", `covering` declares a size
	 * reaching the end of the meta box. Both keep every other byte in place.
	 */
	hideIinf?: 'sizeZero' | 'covering';
	/** Declare an iinf entry_count over the parser's item cap. */
	iinfCountBomb?: boolean;
	/** Put a `free` box in front of the item entries inside iinf. */
	iinfDecoyChild?: boolean;
	/** Name the Exif item twice inside the one iinf box. */
	duplicateInfe?: boolean;
	/** Place item 2 twice in the one iloc box, decoy first or decoy last. */
	duplicateIlocItem?: 'decoyFirst' | 'decoyLast';
	/**
	 * Leave the meta box out altogether: ftyp and mdat only, so no item list
	 * names what the payload store holds.
	 */
	noMeta?: boolean;
	/** Put the mdat ahead of the meta box, so the payloads go past before the
	 * item list names them. Nothing follows the meta box, so the refusal has to
	 * come from reading the item list, not from reaching a later box. */
	mdatBeforeMeta?: boolean;
	/**
	 * Replace the iloc with one built to make the PARSE expensive rather than to
	 * place any bytes: `zeroWidth` names 200 items of 65535 extents each, in
	 * about 1.2 KB, by declaring offset and length widths of zero; `items` and
	 * `extents` declare counts over the parser's caps with none of the records
	 * they promise.
	 */
	ilocBomb?: 'zeroWidth' | 'items' | 'extents';
}

/**
 * An iloc built to cost the parser far more than it costs the file. Every
 * variant is a few hundred bytes: an extent record can be zero bytes wide
 * (offset_size and length_size both 0), and a declared count needs no records
 * behind it at all.
 */
function bombIloc(kind: 'zeroWidth' | 'items' | 'extents'): number[] {
	if (kind === 'items') {
		// item_count says 1000; not one item record follows.
		return fullBox('iloc', 0, 0, [0x44, 0x00, ...u16be(1000)]);
	}
	if (kind === 'extents') {
		// One item claiming 65535 extents, with none of their bytes present.
		return fullBox('iloc', 0, 0, [0x44, 0x00, ...u16be(1), ...u16be(1), ...u16be(0), ...u16be(65535)]);
	}
	// 200 items × 65535 zero-width extents: 13 million extents in 1.2 KB.
	const items: number[] = [];
	for (let id = 1; id <= 200; id++) items.push(...u16be(id), ...u16be(0), ...u16be(65535));
	return fullBox('iloc', 0, 0, [0x00, 0x00, ...u16be(200), ...items]);
}

/**
 * Rewrite the `pitm` box's 8-byte header in place as a `free` box that hides
 * everything after it: `sizeZero` says "to the end of the parent", `covering`
 * declares the exact number of bytes left in the meta box. Nothing moves, so
 * the item list is still there for a reader that walks past the decoy — only a
 * walk that trusts the declared size stops seeing it.
 */
function hideIinfBehindPitm(meta: number[], mode: 'sizeZero' | 'covering'): number[] {
	const out = [...meta];
	const marker = ascii('pitm');
	const at = out.findIndex((_, i) => marker.every((b, k) => out[i + k] === b)) - 4;
	out.splice(at, 8, ...u32be(mode === 'sizeZero' ? 0 : out.length - at), ...ascii('free'));
	return out;
}

export interface AvifFixture {
	file: Uint8Array;
	av01: { start: number; end: number };
	exif: { start: number; end: number };
	xmp: { start: number; end: number };
}

/**
 * A minimal AVIF: ftyp, a meta box naming an av01 image item plus an Exif item
 * and an XMP mime item, and an mdat holding all three payloads. The item
 * offsets in iloc are absolute file offsets, so the layout is computed twice —
 * once to size the meta box, once with the real mdat addresses.
 */
export function avifFixture(opts: AvifOptions = {}): AvifFixture {
	const av01Payload = ascii('fake av01 primary image bitstream');
	const exifPayload = [
		...u32be(0),
		...exifTiff({ artist: 'Nova Sparks', copyright: '(c) Nova', orientation: 6, gps: true, subIfd: true })
	];
	const xmpPayload = xmpWithGps();
	// A straddling extent claims the XMP payload after it plus 32 bytes of the
	// box that follows the mdat.
	const exifExtentLen = opts.straddlingExifExtent
		? exifPayload.length + xmpPayload.length + 32
		: exifPayload.length;

	// The long form pads the compatible_brands so the `avif` brand lands at file
	// offset 72: fourteen filler brands, then `avif` as the fifteenth.
	const longBrands = Array.from({ length: 14 }, (_, i) => ascii(`br${String(i).padStart(2, '0')}`)).flat();
	const ftyp = opts.longFtyp
		? isoBox('ftyp', [...ascii('mif1'), ...u32be(0), ...longBrands, ...ascii('avif')])
		: isoBox('ftyp', [...ascii('avif'), ...u32be(0), ...ascii('avif'), ...ascii('mif1'), ...ascii('miaf')]);

	const build = (av01At: number, exifAt: number, xmpAt: number): number[] => {
		const hdlr = fullBox('hdlr', 0, 0, [...u32be(0), ...ascii('pict'), ...u32be(0), ...u32be(0), ...u32be(0), 0]);
		const pitm = fullBox('pitm', 0, 0, u16be(1));
		const exifType = opts.exifItemType ?? (opts.lowercaseExifType ? 'exif' : 'Exif');
		// Records past the declared count, each with an item_ID of its own, so the
		// walk is what stops them rather than the entry_count check.
		const recordBomb: number[] = [];
		if (opts.iinfRecordBomb) {
			for (let id = 100; id < 400; id++) recordBomb.push(...infe(id, 'av01', 'Image'));
		}
		const iinf = opts.noMetadataItems
			? fullBox('iinf', 0, 0, [...u16be(1), ...infe(1, 'av01', 'Image')])
			: fullBox('iinf', 0, 0, [
					...u16be(opts.iinfCountBomb ? 1000 : (opts.duplicateInfe ? 4 : 3) + (opts.derivedItems ? 2 : 0)),
					...(opts.iinfDecoyChild ? isoBox('free', [0, 0, 0, 0]) : []),
					...infe(1, 'av01', 'Image'),
					...infe(2, exifType, 'Exif', undefined, opts.exifInfeVersion),
					...(opts.duplicateInfe ? infe(2, exifType, 'Exif') : []),
					...infe(
						3,
						opts.xmpItemType ?? 'mime',
						'XMP',
						opts.xmpContentType ?? 'application/rdf+xml',
						opts.xmpInfeVersion
					),
					...(opts.derivedItems ? [...infe(4, 'grid', 'Grid'), ...infe(5, 'iovl', 'Overlay')] : []),
					...recordBomb
				]);
		const version = opts.idatConstruction || opts.ilocIndexWidth ? 1 : 0;
		const item = (id: number, method: number, at: number, length: number, split = false): number[] => [
			...u16be(id),
			// construction_method occupies 4 bits of a reserved 16 in v1/v2 only.
			...(version === 0 ? [] : u16be(method)),
			...u16be(0), // data_reference_index
			// base_offset_size is 0, so no base offset bytes follow.
			...u16be(split ? 2 : 1), // extent_count
			...u32be(at),
			...u32be(split ? length - 4 : length),
			...(split ? [...u32be(at + length - 4), ...u32be(4)] : [])
		];
		// offset_size=4, length_size=4, base_offset_size=0, index_size/reserved=0.
		// A second entry for item 2 pointing at four harmless bytes: whichever of
		// the two the scrubber keeps, the other is the one a reader may follow.
		const decoyItem = opts.duplicateIlocItem ? item(2, 0, 0, 4) : [];
		const realItem = item(
			2,
			opts.idatConstruction ? 1 : 0,
			exifAt,
			opts.hugeExifExtent ? 0x7ffffff0 : exifExtentLen,
			opts.splitExifExtent
		);
		const placed = opts.noMetadataItems
			? [...u16be(1), ...item(1, 0, av01At, av01Payload.length)]
			: opts.exifItemWithoutLocation
				? [...u16be(2), ...item(1, 0, av01At, av01Payload.length), ...item(3, 0, xmpAt, xmpPayload.length)]
				: [
						...u16be(opts.duplicateIlocItem ? 4 : 3),
						...item(1, 0, av01At, av01Payload.length),
						...(opts.duplicateIlocItem === 'decoyFirst' ? [...decoyItem, ...realItem] : [...realItem, ...decoyItem]),
						...item(3, 0, xmpAt, xmpPayload.length)
					];
		const iloc = opts.ilocBomb
			? bombIloc(opts.ilocBomb)
			: fullBox('iloc', version, 0, [0x44, opts.ilocIndexWidth ? 0x02 : 0x00, ...placed]);
		// A decoy places the Exif item somewhere harmless; whichever iloc the
		// scrubber kept, the other one is the copy a reader might follow.
		const decoyIloc = opts.decoyIloc
			? fullBox('iloc', 0, 0, [0x44, 0x00, ...u16be(1), ...u16be(2), ...u16be(0), ...u16be(1), ...u32be(0), ...u32be(4)])
			: [];
		const decoyIinf = opts.decoyIinf ? fullBox('iinf', 0, 0, [...u16be(1), ...infe(2, 'Exif', 'Exif')]) : [];
		const adobeUuidBox = isoBox('uuid', [...ADOBE_XMP_UUID, ...xmpWithGps()]);
		// The property boxes a real encoder writes alongside the codec config:
		// image size, bit depth per channel, colour, and the alpha marker.
		const realProperties = opts.richIpco
			? [
					...fullBox('ispe', 0, 0, [...u32be(64), ...u32be(64)]),
					...fullBox('pixi', 0, 0, [3, 8, 8, 8]),
					...isoBox('colr', [...ascii('nclx'), ...u16be(1), ...u16be(13), ...u16be(6), 0x80]),
					...fullBox('auxC', 0, 0, cstring('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'))
				]
			: [];
		const iprp = isoBox('iprp', [
			...isoBox('ipco', [
				...realProperties,
				...fullBox('av1C', 0, 0, [0x81, 0x00, 0x0c, 0x00]),
				...isoBox('irot', [1]),
				...(opts.uuidDeepInMeta === 'ipco' ? adobeUuidBox : [])
			]),
			...fullBox('ipma', 0, 0, [...u32be(1), ...u16be(1), 1, 0x81])
		]);
		// An item reference box, with a `dimg` reference of the kind a real file
		// carries next to whatever is being hidden in it.
		const iref =
			opts.uuidDeepInMeta === 'iref'
				? fullBox('iref', 0, 0, [...isoBox('dimg', [...u16be(1), ...u16be(1), ...u16be(4)]), ...adobeUuidBox])
				: [];
		const meta = fullBox('meta', 0, 0, [
			...hdlr,
			...pitm,
			...iinf,
			...decoyIinf,
			...(opts.decoyIloc === 'before' ? decoyIloc : []),
			...iloc,
			...(opts.decoyIloc === 'after' ? decoyIloc : []),
			...iprp,
			...iref,
			...(opts.uuidInsideMeta ? isoBox('uuid', [...ADOBE_XMP_UUID, ...xmpWithGps()]) : [])
		]);
		return opts.hideIinf ? hideIinfBehindPitm(meta, opts.hideIinf) : meta;
	};

	// Pass one sizes the meta box with placeholder offsets; the layout is
	// offset-independent because every offset field is a fixed 4 bytes.
	const metaSize = build(0, 0, 0).length;
	const mdatHeader = opts.largeMdat ? 16 : 8;
	// A size-0 box says "runs to the end of the file"; placed before meta, it
	// would hand the whole file back unexamined.
	const free = opts.freeBoxBeforeMeta ? [...u32be(0), ...ascii('free')] : [];
	// With mdatBeforeMeta the payload store comes first, so the meta box that
	// names it is what the walk reaches last.
	const mdatStart =
		opts.mdatBeforeMeta || opts.noMeta ? ftyp.length : ftyp.length + free.length + metaSize;
	const av01At = mdatStart + mdatHeader;
	// With splitMdat the metadata payloads live in a second mdat, past a `free`
	// box: the extents are then two boxes on from the meta box, not in the one
	// right after it.
	const gapFree = isoBox('free', [0, 0, 0, 0]);
	const exifAt = av01At + av01Payload.length + (opts.splitMdat ? gapFree.length + 8 : 0);
	const xmpAt = exifAt + exifPayload.length;
	const mdatBody = opts.noMetadataItems ? [...av01Payload] : [...av01Payload, ...exifPayload, ...xmpPayload];
	const mdat = opts.splitMdat
		? [...isoBox('mdat', av01Payload), ...gapFree, ...isoBox('mdat', [...exifPayload, ...xmpPayload])]
		: opts.largeMdat
			? [...u32be(1), ...ascii('mdat'), ...u32be(0), ...u32be(mdatBody.length + 16), ...mdatBody]
			: isoBox('mdat', mdatBody);
	// The straddling extent needs bytes past the mdat to reach into. The padding
	// boxes carry a real XMP packet so a test can tell a zeroed box from a copied
	// one; `zzzz` is a top-level type no AVIF has.
	const trailingBox = opts.zeroSizeTrailingBox
		? [...u32be(0), ...ascii(opts.zeroSizeTrailingBox), ...xmpWithGps()]
		: opts.moovBoxAfterMdat
			? isoBox('moov', isoBox('udta', quickTimeLocationAtom()))
			: opts.uuidBoxAfterMdat
				? isoBox('uuid', [...ADOBE_XMP_UUID, ...xmpWithGps()])
				: opts.unknownBoxAfterMdat
					? isoBox('zzzz', xmpWithGps())
					: opts.freeBoxAfterMdat || opts.straddlingExifExtent
						? isoBox('free', xmpWithGps())
						: [];
	const meta = build(av01At, opts.exifExtentPastEnd ? mdatStart + mdat.length + 16 : exifAt, xmpAt);
	const baseLen = mdatStart + mdat.length + trailingBox.length;
	// A whole second AVIF item list and payload store, appended past the end of
	// the first — the bytes a walk that stopped at the last extent hands back.
	const secondAt = baseLen + metaSize + 8;
	const second = opts.secondMeta
		? [
				...build(secondAt, secondAt + av01Payload.length, secondAt + av01Payload.length + exifPayload.length),
				...isoBox('mdat', mdatBody)
			]
		: [];
	return {
		file: Uint8Array.from(
			opts.noMeta
				? [...ftyp, ...mdat]
				: opts.mdatBeforeMeta
					? [...ftyp, ...mdat, ...meta, ...trailingBox]
					: [...ftyp, ...free, ...meta, ...mdat, ...trailingBox, ...second]
		),
		av01: { start: av01At, end: av01At + av01Payload.length },
		exif: { start: exifAt, end: exifAt + exifPayload.length },
		xmp: { start: xmpAt, end: xmpAt + xmpPayload.length }
	};
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

export interface GifOptions {
	/**
	 * Append a second image — an XMP application extension carrying GPS, a frame
	 * and another trailer — AFTER the trailer, where a decoder stops reading.
	 */
	afterTrailer?: boolean;
}

/** A one-frame GIF with a comment extension, which the scrubber leaves alone. */
export function gifFixture(opts: GifOptions = {}): Uint8Array {
	return bytes(
		ascii('GIF89a'),
		[8, 0, 8, 0, 0x80, 0, 0], // logical screen descriptor, global colour table of 2
		[0, 0, 0, 0xff, 0xff, 0xff],
		[0x21, 0xfe, 11],
		ascii('made in SW1'),
		[0],
		[0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0],
		[0x02, 0x02, 0x44, 0x01, 0x00],
		[0x3b],
		opts.afterTrailer ? gifAfterTrailer() : []
	);
}

/** A whole second GIF image, XMP extension and all, to park past the trailer. */
function gifAfterTrailer(): number[] {
	return [
		0x21, 0xff, 11, ...ascii('XMP DataXMP'), ...xmpWithGps(), ...gifXmpMagicTrailer(),
		0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0,
		0x02, 0x02, 0x44, 0x01, 0x00,
		0x3b
	];
}

/**
 * The 258-byte magic trailer that closes a GIF XMP extension: 0x01, the
 * descending bytes 0xFF…0x00, then the sub-block terminator. Written out here
 * (rather than imported) so the test proves the scrubber keeps the real one.
 */
export function gifXmpMagicTrailer(): number[] {
	const descending: number[] = [];
	for (let value = 0xff; value >= 0; value--) descending.push(value);
	return [0x01, ...descending, 0x00];
}

/**
 * The same GIF with an `XMP DataXMP` application extension carrying GPS —
 * where Photoshop and Lightroom put it. The payload is raw XML, not a sub-block
 * chain; only the magic trailer makes a chain walk over it terminate.
 */
export function gifWithXmpFixture(): Uint8Array {
	return bytes(
		ascii('GIF89a'),
		[8, 0, 8, 0, 0x80, 0, 0],
		[0, 0, 0, 0xff, 0xff, 0xff],
		[0x21, 0xff, 11],
		ascii('XMP DataXMP'),
		xmpWithGps(),
		gifXmpMagicTrailer(),
		[0x21, 0xfe, 11],
		ascii('made in SW1'),
		[0],
		[0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0],
		[0x02, 0x02, 0x44, 0x01, 0x00],
		[0x3b]
	);
}

/**
 * A GIF that is header, `padBytes` of 0x00 inter-block padding, then trailer.
 * A pad run is one of the two shapes that used to cost an emitted piece per
 * input byte, so it is what the block-consume walk and the driver's output
 * coalescing are measured against.
 */
export function padRunGif(padBytes: number): Uint8Array {
	const out = new Uint8Array(13 + padBytes + 1);
	out.set(ascii('GIF89a'), 0);
	out.set([1, 0, 1, 0, 0, 0, 0], 6); // 1×1 logical screen, no global colour table
	out[out.length - 1] = 0x3b; // trailer
	return out;
}

/** The other one: SOI, `fillBytes` of 0xFF marker fill, then EOI. */
export function fillRunJpeg(fillBytes: number): Uint8Array {
	const out = new Uint8Array(2 + fillBytes + 1);
	out[0] = 0xff;
	out[1] = 0xd8;
	out.fill(0xff, 2, 2 + fillBytes);
	out[out.length - 1] = 0xd9;
	return out;
}

/** Offsets in gifWithXmpFixture() of the XMP payload, magic trailer excluded. */
export function gifXmpRange(): { start: number; end: number } {
	// header 6 + screen descriptor 7 + colour table 6 + extension head 3 + id 11.
	const start = 33;
	return { start, end: start + xmpWithGps().length };
}
