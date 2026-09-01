import { describe, it, expect } from 'vitest';
import {
	isUnscrubbable,
	scrubImageMetadata,
	scrubImageMetadataStream,
	UnscrubbableImageError
} from './scrub-metadata';
import {
	ascii,
	avifFixture,
	exifTiff,
	findSegment,
	gifFixture,
	gifWithXmpFixture,
	gifXmpMagicTrailer,
	gifXmpRange,
	jpegFixture,
	jpegSosOffset,
	JPEG_TRAILER,
	pngChunks,
	pngCrc,
	pngFixture,
	riffChunks,
	webpFixture,
	webpSimpleFixture
} from './scrub-metadata.fixtures';

// A tiny TIFF reader, independent of the one under test, so the assertions
// describe what a DECODER would find rather than restating the writer's logic.
interface ReadTiff {
	entries: { tag: number; type: number; count: number; value: number }[];
	orientation?: number;
	strings: Record<number, string>;
	nextIfd: number;
}

function readTiff(tiff: Uint8Array): ReadTiff {
	const bigEndian = tiff[0] === 0x4d;
	const u16 = (at: number) => (bigEndian ? (tiff[at] << 8) | tiff[at + 1] : (tiff[at + 1] << 8) | tiff[at]);
	const u32 = (at: number) =>
		bigEndian
			? ((tiff[at] << 24) | (tiff[at + 1] << 16) | (tiff[at + 2] << 8) | tiff[at + 3]) >>> 0
			: ((tiff[at + 3] << 24) | (tiff[at + 2] << 16) | (tiff[at + 1] << 8) | tiff[at]) >>> 0;
	expect(u16(2)).toBe(42);
	const ifd = u32(4);
	const count = u16(ifd);
	const out: ReadTiff = { entries: [], strings: {}, nextIfd: u32(ifd + 2 + count * 12) };
	for (let i = 0; i < count; i++) {
		const at = ifd + 2 + i * 12;
		const tag = u16(at);
		const type = u16(at + 2);
		const length = u32(at + 4);
		out.entries.push({ tag, type, count: length, value: u32(at + 8) });
		if (tag === 0x0112) out.orientation = u16(at + 8);
		if (type === 2) {
			const start = length <= 4 ? at + 8 : u32(at + 8);
			out.strings[tag] = String.fromCharCode(...tiff.subarray(start, start + length - 1));
		}
	}
	return out;
}

function text(bytes: Uint8Array): string {
	return new TextDecoder('latin1').decode(bytes);
}

async function streamScrub(input: Uint8Array, chunkSize: number): Promise<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let at = 0; at < input.length; at += chunkSize) {
				controller.enqueue(input.subarray(at, Math.min(at + chunkSize, input.length)));
			}
			controller.close();
		}
	});
	const parts: Uint8Array[] = [];
	const reader = source.pipeThrough(scrubImageMetadataStream()).getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	const total = parts.reduce((n, part) => n + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

describe('scrubImageMetadata: JPEG', () => {
	const original = jpegFixture();
	const scrubbed = scrubImageMetadata(original);

	it('preserves the byte length', () => {
		expect(scrubbed.length).toBe(original.length);
	});

	it('leaves SOS through EOI byte-identical and zeroes the trailer', () => {
		const sos = jpegSosOffset(original);
		expect(sos).toBeGreaterThan(0);
		const eoi = original.length - 'trailing junk after EOI'.length;
		// The scan carries a stuffed FF 00 and a restart marker FF D0, neither of
		// which the EOI search may mistake for the end of the image.
		expect(text(original.subarray(sos, eoi))).toContain('\xff\x00');
		expect(text(original.subarray(sos, eoi))).toContain('\xff\xd0');
		expect(scrubbed.subarray(sos, eoi)).toEqual(original.subarray(sos, eoi));
		expect([...scrubbed.subarray(eoi - 2, eoi)]).toEqual([0xff, 0xd9]);
		// Nothing after EOI survives: that is where a second picture hides.
		expect(scrubbed.subarray(eoi).every((b) => b === 0)).toBe(true);
	});

	it('leaves JFIF, ICC, COM, DQT, SOF and DHT segments untouched', () => {
		for (const [marker, id] of [
			[0xe0, 'JFIF'],
			[0xe2, 'ICC_PROFILE'],
			[0xfe, undefined],
			[0xdb, undefined],
			[0xc0, undefined],
			[0xc4, undefined]
		] as const) {
			const range = findSegment(original, marker, id);
			expect(range, `segment 0x${marker.toString(16)} ${id ?? ''}`).not.toBeNull();
			expect(scrubbed.subarray(range!.start, range!.end)).toEqual(
				original.subarray(range!.start, range!.end)
			);
		}
	});

	it('rewrites the Exif payload to exactly orientation, artist and copyright', () => {
		const range = findSegment(scrubbed, 0xe1, 'Exif')!;
		const payload = scrubbed.subarray(range.start, range.end);
		expect(text(payload.subarray(0, 6))).toBe('Exif\0\0');
		const tiff = readTiff(payload.subarray(6));
		expect(tiff.orientation).toBe(6);
		expect(tiff.strings[0x013b]).toBe('Nova Sparks');
		expect(tiff.strings[0x8298]).toBe('(c) 2019 Nova Sparks');
		expect(tiff.entries.map((e) => e.tag).sort()).toEqual([0x0112, 0x013b, 0x8298]);
		// No sub-IFD, no GPS IFD, no IFD1 with its thumbnail.
		expect(tiff.entries.some((e) => e.tag === 0x8769 || e.tag === 0x8825)).toBe(false);
		expect(tiff.nextIfd).toBe(0);
		// The GPS coordinates and the capture time are gone from the raw bytes too.
		expect(text(payload)).not.toContain('MAKERNOT');
		expect(text(payload)).not.toContain('2019:07:04');
		expect(text(payload)).not.toContain('THUMBNAI');
	});

	it('empties the XMP packet without changing its length', () => {
		const range = findSegment(scrubbed, 0xe1, 'http://ns.adobe.com/xap/1.0/')!;
		const payload = text(scrubbed.subarray(range.start, range.end));
		expect(payload.startsWith('http://ns.adobe.com/xap/1.0/\0')).toBe(true);
		const packet = payload.slice('http://ns.adobe.com/xap/1.0/\0'.length);
		expect(packet).not.toContain('GPS');
		expect(packet.trimEnd()).toBe(
			'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
				'<x:xmpmeta xmlns:x="adobe:ns:meta/"/>' +
				'<?xpacket end="w"?>'
		);
		// The slack is ASCII spaces, which an XMP packet may legally carry.
		expect(/^ *$/.test(packet.slice(packet.indexOf('<?xpacket end="w"?>') + 19))).toBe(true);
	});

	it('zeroes the MPF and Photoshop payloads', () => {
		for (const [marker, id] of [
			[0xe2, 'MPF'],
			[0xed, 'Photoshop 3.0']
		] as const) {
			const range = findSegment(original, marker, id)!;
			const payload = scrubbed.subarray(range.start, range.end);
			expect(payload.length).toBeGreaterThan(0);
			expect(payload.every((b) => b === 0)).toBe(true);
		}
	});
});

describe('scrubImageMetadata: JPEG Exif edge cases', () => {
	it('writes an empty directory when the original has nothing worth keeping', () => {
		const file = jpegFixture({ exif: { subIfd: true, gps: true } });
		const scrubbed = scrubImageMetadata(file);
		const range = findSegment(scrubbed, 0xe1, 'Exif')!;
		const tiff = readTiff(scrubbed.subarray(range.start + 6, range.end));
		expect(tiff.entries).toEqual([]);
		expect(tiff.nextIfd).toBe(0);
	});

	it('writes an empty directory for a malformed Exif rather than throwing', () => {
		const file = jpegFixture({ exif: { orientation: 6, artist: 'Nova', badIfdOffset: true } });
		const scrubbed = scrubImageMetadata(file);
		const range = findSegment(scrubbed, 0xe1, 'Exif')!;
		const tiff = readTiff(scrubbed.subarray(range.start + 6, range.end));
		expect(tiff.entries).toEqual([]);
		expect(scrubbed.length).toBe(file.length);
	});

	it('zeroes a trailer carrying a whole second JPEG with its own GPS', () => {
		// An MPF preview and a motion photo's MP4 both live after EOI, each with
		// its own Exif; a decoder stops at EOI, so the bytes are dead weight.
		const file = jpegFixture({ gpsTrailer: true });
		const scrubbed = scrubImageMetadata(file);
		expect(scrubbed.length).toBe(file.length);
		const eoi = text(file).indexOf('\xff\xd9') + 2;
		expect(eoi).toBeGreaterThan(2);
		expect(scrubbed.subarray(eoi).every((b) => b === 0)).toBe(true);
		expect(text(file)).toContain('preview scan');
		expect(text(scrubbed)).not.toContain('preview scan');
		expect(text(scrubbed)).not.toContain('MAKERNOT');
	});

	it('throws when a segment length runs past the end of the file', () => {
		expect(() => scrubImageMetadata(jpegFixture({ truncated: true }))).toThrow(UnscrubbableImageError);
	});

	it('zeroes the trailer of a file that reaches EOI before any scan', () => {
		const file = jpegFixture({ noScan: true });
		const scrubbed = scrubImageMetadata(file);
		const eoi = file.length - JPEG_TRAILER.length;
		expect(scrubbed.length).toBe(file.length);
		expect(scrubbed.subarray(0, eoi)).toEqual(file.subarray(0, eoi));
		expect(scrubbed.subarray(eoi).every((b) => b === 0)).toBe(true);
	});
});

describe('scrubImageMetadata: JPEG with more than one scan', () => {
	// A progressive JPEG interleaves scans with segments, so the walk cannot
	// treat the first SOS as the end of the marker stream.
	it('keeps the later scans when a DQT between them contains FF D9', () => {
		const file = jpegFixture({ secondScan: true });
		const scrubbed = scrubImageMetadata(file);
		const sos = jpegSosOffset(file);
		const eoi = file.length - JPEG_TRAILER.length;
		expect(scrubbed.length).toBe(file.length);
		// The trap really is in the file: the DQT's table bytes read FF D9.
		expect(text(file.subarray(sos, eoi)).indexOf('\xff\xd9')).toBeLessThan(eoi - sos - 2);
		// Everything from the first scan through the REAL end marker survives...
		expect(scrubbed.subarray(sos, eoi)).toEqual(file.subarray(sos, eoi));
		expect(text(scrubbed)).toContain('second');
		expect([...scrubbed.subarray(eoi - 2, eoi)]).toEqual([0xff, 0xd9]);
		// ...and only the true trailer is zeroed.
		expect(scrubbed.subarray(eoi).every((b) => b === 0)).toBe(true);
	});

	it('rewrites an APP1 Exif segment sitting between two scans', () => {
		const file = jpegFixture({ secondScan: true, exifBetweenScans: true });
		const scrubbed = scrubImageMetadata(file);
		expect(scrubbed.length).toBe(file.length);
		expect(text(file)).toContain('MAKERNOT');
		expect(text(scrubbed)).not.toContain('MAKERNOT');
		// The between-scans Exif became a minimal TIFF: the artist survives, the
		// GPS and sub-IFD pointers do not.
		const at = text(scrubbed).indexOf('Exif\0\0', jpegSosOffset(file));
		expect(at).toBeGreaterThan(0);
		const tiff = readTiff(scrubbed.subarray(at + 6));
		expect(tiff.strings[0x013b]).toBe('Nova Sparks');
		expect(tiff.entries.some((e) => e.tag === 0x8825 || e.tag === 0x8769)).toBe(false);
		// The second scan and the real EOI are still there.
		expect(text(scrubbed)).toContain('second');
		const eoi = file.length - JPEG_TRAILER.length;
		expect([...scrubbed.subarray(eoi - 2, eoi)]).toEqual([0xff, 0xd9]);
		expect(scrubbed.subarray(eoi).every((b) => b === 0)).toBe(true);
	});
});

describe('scrubImageMetadata: PNG', () => {
	const original = pngFixture();
	const scrubbed = scrubImageMetadata(original);
	const chunks = pngChunks(scrubbed);

	it('preserves the byte length and the chunk layout', () => {
		expect(scrubbed.length).toBe(original.length);
		expect(chunks.map((c) => c.dataEnd - c.dataStart)).toEqual(
			pngChunks(original).map((c) => c.dataEnd - c.dataStart)
		);
	});

	it('rewrites eXIf to a minimal TIFF with a valid CRC', () => {
		const chunk = chunks.find((c) => c.type === 'eXIf')!;
		const data = scrubbed.subarray(chunk.dataStart, chunk.dataEnd);
		const tiff = readTiff(data);
		expect(tiff.orientation).toBe(3);
		expect(tiff.strings[0x013b]).toBe('Nova Sparks');
		expect(tiff.strings[0x8298]).toBe('(c) Nova');
		expect(tiff.entries.some((e) => e.tag === 0x8825)).toBe(false);
		expect(pngCrc(scrubbed.subarray(chunk.dataStart - 4, chunk.dataEnd))).toBe(chunk.crc);
	});

	it('rewrites the lowercase-flag variants too (exIf, zxIf, tXMP)', () => {
		// The case bits are ancillary/private/safe-to-copy FLAGS, not identity: an
		// encoder writing exIf still means Exif, and an exact-case match let it
		// through with its GPS intact.
		expect(pngChunks(original).map((c) => c.type)).toEqual(
			expect.arrayContaining(['exIf', 'zxIf', 'tXMP'])
		);
		const exif = chunks.filter((c) => c.type === 'exIf');
		expect(exif).toHaveLength(1);
		// exIf keeps its type and becomes a minimal (here empty) directory.
		const tiff = readTiff(scrubbed.subarray(exif[0].dataStart, exif[0].dataEnd));
		expect(tiff.entries).toEqual([]);
		expect(pngCrc(scrubbed.subarray(exif[0].dataStart - 4, exif[0].dataEnd))).toBe(exif[0].crc);
		// zxIf (compressed Exif, which the scrubber does not inflate) and tXMP are
		// renamed and zeroed like the text chunks.
		expect(chunks.some((c) => c.type === 'zxIf' || c.type === 'tXMP')).toBe(false);
		expect(text(scrubbed)).not.toContain('GPSLatitude');
		expect(text(scrubbed)).not.toContain('fake deflated exif');
	});

	it('renames every text chunk to scRb, zeroes it, and fixes the CRC', () => {
		expect(pngChunks(original).filter((c) => ['tEXt', 'zTXt', 'iTXt'].includes(c.type))).toHaveLength(3);
		const renamed = chunks.filter((c) => c.type === 'scRb');
		// The three text chunks plus zxIf and tXMP.
		expect(renamed).toHaveLength(5);
		for (const chunk of renamed) {
			expect(scrubbed.subarray(chunk.dataStart, chunk.dataEnd).every((b) => b === 0)).toBe(true);
			expect(pngCrc(scrubbed.subarray(chunk.dataStart - 4, chunk.dataEnd))).toBe(chunk.crc);
		}
		expect(text(scrubbed)).not.toContain('51.5');
		expect(text(scrubbed)).not.toContain('GPSLatitude');
	});

	it('zeroes an eXIf chunk appended after IEND', () => {
		// A reader stops at IEND, so a chunk parked after it is metadata nothing
		// examines — the same hole the JPEG trailer was.
		const file = pngFixture({ afterIend: true });
		const out = scrubImageMetadata(file);
		const iend = pngFixture().length;
		expect(out.length).toBe(file.length);
		expect(out.subarray(0, iend)).toEqual(scrubbed);
		expect(text(file)).toContain('MAKERNOT');
		expect(text(out)).not.toContain('MAKERNOT');
		expect(out.subarray(iend).every((b) => b === 0)).toBe(true);
	});

	it('leaves IHDR, iCCP, pHYs, IDAT, the APNG chunks and IEND identical', () => {
		for (const type of ['IHDR', 'iCCP', 'pHYs', 'acTL', 'fcTL', 'IDAT', 'fdAT', 'IEND']) {
			const before = pngChunks(original).find((c) => c.type === type)!;
			const after = chunks.find((c) => c.type === type)!;
			expect(after.crc).toBe(before.crc);
			expect(scrubbed.subarray(after.dataStart - 8, after.dataEnd + 4)).toEqual(
				original.subarray(before.dataStart - 8, before.dataEnd + 4)
			);
		}
	});
});

describe('scrubImageMetadata: WebP', () => {
	const original = webpFixture();
	const scrubbed = scrubImageMetadata(original);
	const chunks = riffChunks(scrubbed);

	it('preserves the byte length', () => {
		expect(scrubbed.length).toBe(original.length);
	});

	it('clears the XMP feature bit but keeps the EXIF one', () => {
		const vp8x = chunks.find((c) => c.fourcc === 'VP8X')!;
		expect(original[vp8x.dataStart] & 0x04).toBe(0x04);
		expect(scrubbed[vp8x.dataStart] & 0x04).toBe(0);
		expect(scrubbed[vp8x.dataStart] & 0x08).toBe(0x08);
		expect(scrubbed[vp8x.dataStart] & 0x20).toBe(0x20);
	});

	it('rewrites the EXIF chunk and empties the XMP chunk', () => {
		const exif = chunks.find((c) => c.fourcc === 'EXIF')!;
		const tiff = readTiff(scrubbed.subarray(exif.dataStart, exif.dataEnd));
		expect(tiff.orientation).toBe(8);
		expect(tiff.strings[0x8298]).toBe('(c) Nova');
		expect(tiff.entries.some((e) => e.tag === 0x8825)).toBe(false);
		const xmp = chunks.find((c) => c.fourcc === 'XMP ')!;
		const packet = text(scrubbed.subarray(xmp.dataStart, xmp.dataEnd));
		expect(packet).not.toContain('GPS');
		expect(packet.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);
	});

	it('leaves ICCP, the animation chunks and VP8 identical, pad byte included', () => {
		for (const fourcc of ['ICCP', 'ANIM', 'ANMF', 'VP8 ']) {
			const before = riffChunks(original).find((c) => c.fourcc === fourcc)!;
			expect(scrubbed.subarray(before.dataStart, before.dataEnd + 1)).toEqual(
				original.subarray(before.dataStart, before.dataEnd + 1)
			);
		}
		// The ICCP payload is odd-length, so the walk had to honour a pad byte.
		const iccp = riffChunks(original).find((c) => c.fourcc === 'ICCP')!;
		expect((iccp.dataEnd - iccp.dataStart) % 2).toBe(1);
	});

	it('passes a simple-format file through byte-identical', () => {
		const simple = webpSimpleFixture();
		expect(scrubImageMetadata(simple)).toEqual(simple);
	});

	it('zeroes bytes past the declared RIFF size', () => {
		// Same reasoning as the JPEG trailer: no decoder looks there, so anything
		// parked past the declared size is metadata nothing examined.
		const withTrailer = webpFixture({ trailer: 'GPSLatitude 51.5 hidden past the riff size' });
		const out = scrubImageMetadata(withTrailer);
		expect(out.length).toBe(withTrailer.length);
		expect(out.subarray(original.length).every((b) => b === 0)).toBe(true);
		expect(text(out)).not.toContain('GPSLatitude');
	});
});

describe('scrubImageMetadata: AVIF', () => {
	const { file, av01, exif, xmp } = avifFixture();
	const scrubbed = scrubImageMetadata(file);

	it('preserves the byte length and the primary image bitstream', () => {
		expect(scrubbed.length).toBe(file.length);
		expect(scrubbed.subarray(av01.start, av01.end)).toEqual(file.subarray(av01.start, av01.end));
		// Everything up to the mdat payload (ftyp + meta) is untouched.
		expect(scrubbed.subarray(0, av01.start)).toEqual(file.subarray(0, av01.start));
	});

	it('rewrites the Exif extent to offset zero plus a minimal TIFF', () => {
		const payload = scrubbed.subarray(exif.start, exif.end);
		expect([...payload.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
		const tiff = readTiff(payload.subarray(4));
		expect(tiff.strings[0x013b]).toBe('Nova Sparks');
		expect(tiff.strings[0x8298]).toBe('(c) Nova');
		// AVIF carries orientation in irot/imir, so the Exif tag is not preserved.
		expect(tiff.orientation).toBeUndefined();
		expect(tiff.entries.some((e) => e.tag === 0x8825 || e.tag === 0x8769)).toBe(false);
		expect(text(payload)).not.toContain('MAKERNOT');
	});

	it('empties the XMP extent', () => {
		const packet = text(scrubbed.subarray(xmp.start, xmp.end));
		expect(packet).not.toContain('GPS');
		expect(packet.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);
	});

	it('handles an mdat declared with a 64-bit largesize', () => {
		const large = avifFixture({ largeMdat: true });
		const out = scrubImageMetadata(large.file);
		expect(out.length).toBe(large.file.length);
		expect(out.subarray(large.av01.start, large.av01.end)).toEqual(
			large.file.subarray(large.av01.start, large.av01.end)
		);
		expect(text(out.subarray(large.exif.start, large.exif.end))).not.toContain('MAKERNOT');
	});

	it('throws when a metadata item uses a construction method other than file offsets', () => {
		const idat = avifFixture({ idatConstruction: true });
		expect(() => scrubImageMetadata(idat.file)).toThrow(UnscrubbableImageError);
	});

	it('throws when an item extent declares more bytes than the record cap', () => {
		// The extent is buffered whole to be rewritten, so its declared length is
		// an allocation the file's author picks. Matching the CAP's own wording:
		// a truncation error here would mean the cap never ran.
		const huge = avifFixture({ hugeExifExtent: true });
		expect(() => scrubImageMetadata(huge.file)).toThrow(UnscrubbableImageError);
		expect(() => scrubImageMetadata(huge.file)).toThrow(/over the \d+-byte cap/);
	});

	it('throws when an item is split across extents', () => {
		const split = avifFixture({ splitExifExtent: true });
		expect(() => scrubImageMetadata(split.file)).toThrow(/split across 2 extents/);
	});

	it('throws on an item list built to allocate rather than to place bytes', () => {
		// 200 items × 65535 extents in about 1.2 KB of input: an extent whose
		// offset and length are both zero bytes wide costs the file nothing and
		// the parser an array entry, so the widths are refused outright...
		expect(() => scrubImageMetadata(avifFixture({ ilocBomb: 'zeroWidth' }).file)).toThrow(
			/neither an offset nor a length/
		);
		// ...and the declared counts are capped either side of that, so a bomb
		// built from real-width extents cannot get through either.
		expect(() => scrubImageMetadata(avifFixture({ ilocBomb: 'items' }).file)).toThrow(
			/over the \d+-item cap/
		);
		expect(() => scrubImageMetadata(avifFixture({ ilocBomb: 'extents' }).file)).toThrow(
			/over the \d+-extent cap/
		);
	});

	it('throws on a size-0 box ahead of the meta box', () => {
		// "Runs to the end of the file" before the item list has been read would
		// pass the whole AVIF through unexamined.
		const early = avifFixture({ freeBoxBeforeMeta: true });
		expect(() => scrubImageMetadata(early.file)).toThrow(UnscrubbableImageError);
	});

	it('keeps walking boxes past the last extent and refuses a second meta box', () => {
		// A whole second item list and payload store appended after a valid AVIF:
		// a walk that passed the tail through once the extents were rewritten
		// handed this second set of Exif GPS and XMP back intact.
		const attack = avifFixture({ secondMeta: true });
		expect(text(attack.file.subarray(attack.file.length / 2))).toContain('exif:GPSLatitude');
		expect(() => scrubImageMetadata(attack.file)).toThrow(/second meta box/);
	});

	it('zeroes the content of a free box between the mdat and the end of the file', () => {
		const trailing = avifFixture({ freeBoxAfterMdat: true });
		const out = scrubImageMetadata(trailing.file);
		expect(out.length).toBe(trailing.file.length);
		expect(out.subarray(trailing.av01.start, trailing.av01.end)).toEqual(
			trailing.file.subarray(trailing.av01.start, trailing.av01.end)
		);
		expect(text(out.subarray(trailing.exif.start, trailing.exif.end))).not.toContain('MAKERNOT');
		expect(text(out.subarray(trailing.xmp.start, trailing.xmp.end))).not.toContain('GPS');
		// The box header stays so the walk still adds up; its content is padding
		// nothing reads, and this one is holding an XMP packet with GPS in it.
		const box = trailing.xmp.end;
		expect(text(trailing.file.subarray(box))).toContain('exif:GPSLatitude');
		expect(out.subarray(box, box + 8)).toEqual(trailing.file.subarray(box, box + 8));
		expect(out.subarray(box + 8).every((b) => b === 0)).toBe(true);
	});

	it('zeroes the content of a uuid box carrying an XMP packet', () => {
		// The Adobe XMP UUID is the box an editor uses when there is no item for
		// the packet, and it is a top-level box no item list ever names.
		const uuid = avifFixture({ uuidBoxAfterMdat: true });
		const out = scrubImageMetadata(uuid.file);
		expect(out.length).toBe(uuid.file.length);
		expect(text(uuid.file)).toContain('exif:GPSLatitude');
		expect(text(out.subarray(uuid.xmp.end))).not.toContain('GPS');
		const box = uuid.xmp.end;
		expect(out.subarray(box, box + 8)).toEqual(uuid.file.subarray(box, box + 8));
		expect(out.subarray(box + 8).every((b) => b === 0)).toBe(true);
	});

	it('throws on a top-level box type no AVIF carries', () => {
		// Copying an unrecognised box through is what lets an Exif payload ride in
		// one, so the top-level allowlist is spelled out the way the item one is.
		expect(() => scrubImageMetadata(avifFixture({ unknownBoxAfterMdat: true }).file)).toThrow(
			/top-level zzzz box/
		);
	});

	it('scrubs an AVIF whose avif brand sits past byte 64 of a long ftyp', () => {
		// A mif1-major file can list its compatible brands for as long as the ftyp
		// box declares; a 64-byte sniff window read this one as no raster at all
		// and refused the put.
		const long = avifFixture({ longFtyp: true });
		expect(long.file.subarray(72, 76)).toEqual(Uint8Array.from(ascii('avif')));
		const out = scrubImageMetadata(long.file);
		expect(out.length).toBe(long.file.length);
		expect(text(out.subarray(long.exif.start, long.exif.end))).not.toContain('MAKERNOT');
		expect(text(out.subarray(long.xmp.start, long.xmp.end))).not.toContain('GPS');
	});

	it('scrubs extents that sit in a later box than the one after the meta box', () => {
		// av01 in the first mdat, a free box, then the Exif and XMP in a second:
		// the extents have to survive a box boundary to be reached at all.
		const split = avifFixture({ splitMdat: true });
		const out = scrubImageMetadata(split.file);
		expect(out.length).toBe(split.file.length);
		expect(out.subarray(split.av01.start, split.av01.end)).toEqual(
			split.file.subarray(split.av01.start, split.av01.end)
		);
		expect(text(out.subarray(split.exif.start, split.exif.end))).not.toContain('MAKERNOT');
		expect(text(out.subarray(split.xmp.start, split.xmp.end))).not.toContain('GPS');
	});

	it('throws when the item list places an extent past the end of the file', () => {
		const past = avifFixture({ exifExtentPastEnd: true });
		expect(() => scrubImageMetadata(past.file)).toThrow(/past the end of the file/);
	});

	it('throws when an extent runs out of the box holding it', () => {
		const straddle = avifFixture({ straddlingExifExtent: true });
		expect(() => scrubImageMetadata(straddle.file)).toThrow(/runs past the end of the box/);
	});

	it('throws when a metadata item has no iloc entry', () => {
		// Skipping the item would leave an Exif payload a reader can still find
		// by another route, unscrubbed.
		const unplaced = avifFixture({ exifItemWithoutLocation: true });
		expect(() => scrubImageMetadata(unplaced.file)).toThrow(/has no iloc entry/);
	});

	it('throws on a second iloc or iinf box inside the meta box', () => {
		// Whichever of the two the scrubber kept, the other is the one a reader
		// might follow, so the decoy works from either side.
		expect(() => scrubImageMetadata(avifFixture({ decoyIloc: 'before' }).file)).toThrow(
			/more than one iloc/
		);
		expect(() => scrubImageMetadata(avifFixture({ decoyIloc: 'after' }).file)).toThrow(
			/more than one iloc/
		);
		expect(() => scrubImageMetadata(avifFixture({ decoyIinf: true }).file)).toThrow(/more than one iinf/);
	});

	it('empties the XMP item whatever case and parameters its content type carries', () => {
		// A reader lowercases the type and ignores the parameters before deciding
		// the item is XMP; an exact-string match let all three of these through
		// with their GPS intact.
		for (const contentType of ['application/RDF+XML', 'application/rdf+xml;charset=utf-8', 'application/rdf+xml ']) {
			const fixture = avifFixture({ xmpContentType: contentType });
			const out = scrubImageMetadata(fixture.file);
			expect(text(out.subarray(fixture.xmp.start, fixture.xmp.end))).not.toContain('GPS');
		}
	});

	it('throws on a mime item whose content type is not XMP', () => {
		// A real AVIF carries no other mime item, so an unrecognised one is a
		// payload this scrubber cannot classify rather than something to skip.
		const odd = avifFixture({ xmpContentType: 'application/octet-stream' });
		expect(() => scrubImageMetadata(odd.file)).toThrow(/not XMP/);
	});

	it('rewrites an Exif item whose type is spelled in lower case', () => {
		const lower = avifFixture({ lowercaseExifType: true });
		const out = scrubImageMetadata(lower.file);
		expect(out.length).toBe(lower.file.length);
		expect(text(out.subarray(lower.exif.start, lower.exif.end))).not.toContain('MAKERNOT');
	});

	it('throws when a box inside the meta box hides the item list', () => {
		// The pitm box rewritten as a `free` that swallows the rest of the meta
		// box, either by declaring no size or by declaring the exact bytes left.
		// Every byte stays where it was, so a reader still finds the Exif item;
		// a walk that trusts the decoy found no items and stored the file whole.
		expect(() => scrubImageMetadata(avifFixture({ hideIinf: 'sizeZero' }).file)).toThrow(/declares no size/);
		expect(() => scrubImageMetadata(avifFixture({ hideIinf: 'covering' }).file)).toThrow(/holds no iinf/);
	});

	it('stores an AVIF whose item list names no metadata item', () => {
		// The counterpart to the refusal above: an iinf IS there, it just names
		// only the image. A metadata-free AVIF has to keep storing.
		const clean = avifFixture({ noMetadataItems: true });
		expect(scrubImageMetadata(clean.file)).toEqual(clean.file);
	});

	it('throws when the iinf box declares more items than the cap', () => {
		// An infe record is about 20 bytes, so a meta box at the record cap holds
		// 200,000 of them — one map entry each.
		expect(() => scrubImageMetadata(avifFixture({ iinfCountBomb: true }).file)).toThrow(/over the \d+-item cap/);
	});

	it('throws when the iinf box holds more records than the cap however few it declares', () => {
		// entry_count says 3 and 303 records follow, each with its own item_ID.
		// The declared-count check passes; the records are what cost the parser a
		// map entry apiece, so the walk has to count them itself.
		expect(() => scrubImageMetadata(avifFixture({ iinfRecordBomb: true }).file)).toThrow(
			/more than \d+ item entries/
		);
	});

	it('throws on an item type the scrubber does not know', () => {
		// A relabelled payload is the point: an item the walk skips is an item
		// whose bytes stay as they are, so an Exif payload sitting under a type
		// the scrubber has no opinion about would ship unrewritten.
		expect(() => scrubImageMetadata(avifFixture({ exifItemType: 'jpeg' }).file)).toThrow(
			/item of type "jpeg"/
		);
		expect(() => scrubImageMetadata(avifFixture({ xmpItemType: 'uriX' }).file)).toThrow(
			/item of type "uri/
		);
	});

	it('throws on an infe version AVIF does not use', () => {
		// Versions 0 and 1 have no item_type field, so there is no way to tell
		// what the entry describes — and a v0 entry carries a content_type, which
		// is all a reader needs to find the XMP the walk just skipped.
		expect(() => scrubImageMetadata(avifFixture({ exifInfeVersion: 1 }).file)).toThrow(
			/infe box declares version 1/
		);
		expect(() => scrubImageMetadata(avifFixture({ xmpInfeVersion: 0 }).file)).toThrow(
			/infe box declares version 0/
		);
	});

	it('stores an AVIF carrying derived-image items alongside the coded image', () => {
		// The counterpart to the refusal above: `grid` and `iovl` are items a real
		// AVIF carries and hold no metadata, so the allowlist has to let them by
		// or every multi-tile AVIF becomes a refusal.
		const derived = avifFixture({ derivedItems: true });
		const out = scrubImageMetadata(derived.file);
		expect(out.length).toBe(derived.file.length);
		expect(text(out.subarray(derived.exif.start, derived.exif.end))).not.toContain('MAKERNOT');
	});

	it('throws on an iloc index width no reader supports', () => {
		// The index bytes are stepped over rather than read, so this width never
		// reaches the check the offset and length widths get; a stride the file
		// never used puts every extent after it at the wrong bytes.
		expect(() => scrubImageMetadata(avifFixture({ ilocIndexWidth: true }).file)).toThrow(
			/unsupported iloc field width 2/
		);
	});

	it('throws when one item_ID is named or placed twice', () => {
		// The map keeps the last entry and a reader may keep the first, so a decoy
		// on either side of the real one moves the scrubber off the real payload.
		expect(() => scrubImageMetadata(avifFixture({ duplicateInfe: true }).file)).toThrow(
			/names item 2 more than once/
		);
		expect(() => scrubImageMetadata(avifFixture({ duplicateIlocItem: 'decoyFirst' }).file)).toThrow(
			/places item 2 more than once/
		);
		expect(() => scrubImageMetadata(avifFixture({ duplicateIlocItem: 'decoyLast' }).file)).toThrow(
			/places item 2 more than once/
		);
	});

	it('throws when a normally sized mdat comes before the meta box', () => {
		// Legal layout, no encoder writes it: the payloads have gone past by the
		// time the item list names them, and an extent behind the walk cannot be
		// rewritten in place.
		const early = avifFixture({ mdatBeforeMeta: true });
		expect(() => scrubImageMetadata(early.file)).toThrow(/sits before the meta box/);
	});
});

describe('scrubImageMetadata: pass-through and rejection', () => {
	it('leaves a GIF byte-identical, comment extension included', () => {
		const gif = gifFixture();
		const scrubbed = scrubImageMetadata(gif);
		expect(scrubbed).toEqual(gif);
		expect(text(scrubbed)).toContain('made in SW1');
	});

	it('empties a GIF XMP application extension and keeps its magic trailer', () => {
		// GIF89a has no Exif field, but Photoshop and Lightroom write GPS into an
		// "XMP DataXMP" application extension.
		const gif = gifWithXmpFixture();
		const scrubbed = scrubImageMetadata(gif);
		expect(scrubbed.length).toBe(gif.length);
		expect(text(gif)).toContain('exif:GPSLatitude');
		expect(text(scrubbed)).not.toContain('GPSLatitude');
		const { start, end } = gifXmpRange();
		const packet = text(scrubbed.subarray(start, end));
		expect(packet.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);
		// The trailer is what makes a decoder's sub-block walk terminate, so it
		// survives byte for byte.
		expect([...scrubbed.subarray(end, end + 258)]).toEqual(gifXmpMagicTrailer());
		// Everything else — identifier block, comment, frame — is untouched.
		expect(scrubbed.subarray(0, start)).toEqual(gif.subarray(0, start));
		expect(scrubbed.subarray(end)).toEqual(gif.subarray(end));
	});

	it('zeroes a second image appended after the GIF trailer', () => {
		// A decoder stops at 0x3B, so a whole second GIF parked behind it — XMP
		// extension and all — is bytes nothing walked.
		const file = gifFixture({ afterTrailer: true });
		const out = scrubImageMetadata(file);
		const end = gifFixture().length;
		expect(out.length).toBe(file.length);
		expect(out.subarray(0, end)).toEqual(file.subarray(0, end));
		expect(text(file)).toContain('GPSLatitude');
		expect(text(out)).not.toContain('GPSLatitude');
		expect(out.subarray(end).every((b) => b === 0)).toBe(true);
	});

	it('throws on a GIF whose block structure runs past the end', () => {
		const gif = gifWithXmpFixture();
		expect(() => scrubImageMetadata(gif.subarray(0, gif.length - 60))).toThrow(
			UnscrubbableImageError
		);
	});

	it('throws for bytes matching no raster signature', () => {
		expect(() => scrubImageMetadata(Uint8Array.from(ascii('<svg xmlns="x"><script/></svg>')))).toThrow(
			UnscrubbableImageError
		);
		expect(() => scrubImageMetadata(new Uint8Array(8))).toThrow(UnscrubbableImageError);
		expect(() => scrubImageMetadata(new Uint8Array(0))).toThrow(UnscrubbableImageError);
	});
});

describe('scrubImageMetadataStream chunking invariance', () => {
	const fixtures: [string, Uint8Array][] = [
		['jpeg', jpegFixture()],
		['jpeg without keepable tags', jpegFixture({ exif: { subIfd: true, gps: true } })],
		['jpeg with a malformed exif', jpegFixture({ exif: { orientation: 6, artist: 'Nova', badIfdOffset: true } })],
		['jpeg with a gps trailer', jpegFixture({ gpsTrailer: true })],
		['jpeg with a second scan', jpegFixture({ secondScan: true })],
		['jpeg with exif between two scans', jpegFixture({ secondScan: true, exifBetweenScans: true })],
		['png', pngFixture()],
		['png with a chunk after IEND', pngFixture({ afterIend: true })],
		['webp', webpFixture()],
		['webp with a trailer past the riff size', webpFixture({ trailer: 'past the riff size' })],
		['webp simple', webpSimpleFixture()],
		['avif', avifFixture().file],
		['avif with a large mdat', avifFixture({ largeMdat: true }).file],
		['avif with a free box after the mdat', avifFixture({ freeBoxAfterMdat: true }).file],
		['avif with a uuid box after the mdat', avifFixture({ uuidBoxAfterMdat: true }).file],
		['avif with a long ftyp', avifFixture({ longFtyp: true }).file],
		['avif with the metadata in a second mdat', avifFixture({ splitMdat: true }).file],
		['gif', gifFixture()],
		['gif with an image after the trailer', gifFixture({ afterTrailer: true })],
		['gif with an xmp extension', gifWithXmpFixture()]
	];

	for (const [name, fixture] of fixtures) {
		it(`matches the sync output for ${name} at every chunk size`, async () => {
			const expected = scrubImageMetadata(fixture);
			// A boundary landing inside a length field, an identifier string or a
			// marker pair is the failure mode this guards. 8191 and 8193 straddle
			// the 8192-byte scan block, where the walk holds a trailing 0xFF back;
			// fixed sizes rather than a random one so a failure is reproducible.
			for (const size of [1, 2, 3, 7, 64, 4096, 8191, 8193]) {
				const actual = await streamScrub(fixture, size);
				expect(actual, `${name} at chunk size ${size}`).toEqual(expected);
			}
		});
	}

	it('errors the stream when the body cannot be scrubbed', async () => {
		await expect(streamScrub(jpegFixture({ truncated: true }), 16)).rejects.toThrow(
			UnscrubbableImageError
		);
		await expect(streamScrub(new Uint8Array(32), 8)).rejects.toThrow(UnscrubbableImageError);
	});
});

describe('isUnscrubbable', () => {
	const refusal = new UnscrubbableImageError('jpeg: segment 0xe1 runs past the end');

	it('finds the refusal however the runtime wrapped it', () => {
		expect(isUnscrubbable(refusal)).toBe(true);
		// undici's shape: the provider's fetch rejects carrying ours underneath.
		expect(isUnscrubbable(new TypeError('fetch failed', { cause: refusal }))).toBe(true);
		// A retrying client reports every attempt at once.
		expect(isUnscrubbable(new AggregateError([new Error('first try'), refusal]))).toBe(true);
		// And a rejection need not be an Error at all to carry a cause.
		expect(isUnscrubbable({ cause: refusal })).toBe(true);
	});

	it('says no to anything else, and terminates on a cyclic chain', () => {
		expect(isUnscrubbable(new Error('storage put failed'))).toBe(false);
		expect(isUnscrubbable('jpeg: segment 0xe1 runs past the end')).toBe(false);
		expect(isUnscrubbable(null)).toBe(false);
		const loop = new Error('outer');
		loop.cause = new Error('inner', { cause: loop });
		expect(isUnscrubbable(loop)).toBe(false);
	});
});

describe('exifTiff fixture sanity', () => {
	// The scrubber assertions only mean something if the ORIGINAL really carried
	// what they claim was removed.
	it('builds a TIFF whose GPS and sub-IFD are actually there', () => {
		const tiff = Uint8Array.from(exifTiff({ orientation: 6, artist: 'Nova Sparks', gps: true, subIfd: true }));
		const read = readTiff(tiff);
		expect(read.orientation).toBe(6);
		expect(read.entries.some((e) => e.tag === 0x8825)).toBe(true);
		expect(read.entries.some((e) => e.tag === 0x8769)).toBe(true);
		expect(text(tiff)).toContain('MAKERNOT');
	});
});
