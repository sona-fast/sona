import { describe, it, expect } from 'vitest';
import { scrubImageMetadata, scrubImageMetadataStream, UnscrubbableImageError } from './scrub-metadata';
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
		// an allocation the file's author picks.
		const huge = avifFixture({ hugeExifExtent: true });
		expect(() => scrubImageMetadata(huge.file)).toThrow(UnscrubbableImageError);
	});

	it('throws on a size-0 box ahead of the meta box', () => {
		// "Runs to the end of the file" before the item list has been read would
		// pass the whole AVIF through unexamined.
		const early = avifFixture({ freeBoxBeforeMeta: true });
		expect(() => scrubImageMetadata(early.file)).toThrow(UnscrubbableImageError);
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
		['png', pngFixture()],
		['webp', webpFixture()],
		['webp with a trailer past the riff size', webpFixture({ trailer: 'past the riff size' })],
		['webp simple', webpSimpleFixture()],
		['avif', avifFixture().file],
		['avif with a large mdat', avifFixture({ largeMdat: true }).file],
		['gif', gifFixture()],
		['gif with an xmp extension', gifWithXmpFixture()]
	];

	for (const [name, fixture] of fixtures) {
		it(`matches the sync output for ${name} at every chunk size`, async () => {
			const expected = scrubImageMetadata(fixture);
			// A random split as well as the fixed sizes: a boundary landing inside a
			// length field or an identifier string is the failure mode this guards.
			const random = 1 + Math.floor(Math.random() * Math.max(fixture.length - 1, 1));
			for (const size of [1, 2, 3, 7, 64, 4096, random]) {
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
