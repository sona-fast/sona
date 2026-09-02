import { describe, it, expect } from 'vitest';
import {
	modelExtFromFilename,
	isAllowedModelContentType,
	sniffModelFormat,
	peekStream
} from './vr-models';
import { UnscrubbableImageError } from './storage/scrub-metadata';

describe('modelExtFromFilename', () => {
	it('accepts .vrm and .fbx case-insensitively', () => {
		expect(modelExtFromFilename('avatar.vrm')).toBe('vrm');
		expect(modelExtFromFilename('Avatar.VRM')).toBe('vrm');
		expect(modelExtFromFilename('avatar.fbx')).toBe('fbx');
	});

	it('rejects other or missing extensions', () => {
		expect(modelExtFromFilename('avatar.png')).toBeNull();
		expect(modelExtFromFilename('avatar')).toBeNull();
		expect(modelExtFromFilename('.vrm')).toBeNull();
		expect(modelExtFromFilename(null)).toBeNull();
	});
});

describe('isAllowedModelContentType', () => {
	it('accepts octet-stream and model/gltf-binary (parameters stripped)', () => {
		expect(isAllowedModelContentType('application/octet-stream')).toBe(true);
		expect(isAllowedModelContentType('model/gltf-binary; charset=binary')).toBe(true);
	});

	it('rejects image/document types and absence', () => {
		expect(isAllowedModelContentType('image/png')).toBe(false);
		expect(isAllowedModelContentType('text/html')).toBe(false);
		expect(isAllowedModelContentType(null)).toBe(false);
	});
});

describe('sniffModelFormat', () => {
	const bytes = (s: string) => new TextEncoder().encode(s);

	it('detects a VRM by its glTF binary magic', () => {
		expect(sniffModelFormat(bytes('glTF....'))).toBe('vrm');
	});

	it('detects binary and ASCII FBX', () => {
		expect(sniffModelFormat(bytes('Kaydara FBX Binary  \x00'))).toBe('fbx');
		expect(sniffModelFormat(bytes('; FBX 7.3.0 project file\n...'))).toBe('fbx');
	});

	it('returns null for anything else', () => {
		expect(sniffModelFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
		expect(sniffModelFormat(bytes('; a comment without the marker\nFBX'))).toBeNull();
		expect(sniffModelFormat(new Uint8Array(0))).toBeNull();
	});
});

describe('peekStream', () => {
	function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
		return new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			}
		});
	}
	async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let off = 0;
		for (const p of parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	}

	it('returns the head and replays the FULL body, across chunk boundaries', async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])];
		const { head, stream } = await peekStream(streamOf(chunks), 4);
		expect([...head]).toEqual([1, 2, 3, 4]);
		expect([...(await drain(stream))]).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('handles a body shorter than the peek window', async () => {
		const { head, stream } = await peekStream(streamOf([new Uint8Array([9])]), 64);
		expect([...head]).toEqual([9]);
		expect([...(await drain(stream))]).toEqual([9]);
	});

	it('reads past empty chunks instead of counting them', async () => {
		// An empty chunk advances the byte count by nothing, so the loop has to
		// treat it as no progress rather than as a step toward the window.
		const chunks = [new Uint8Array(0), new Uint8Array(0), new Uint8Array([1, 2, 3, 4])];
		const { head, stream } = await peekStream(streamOf(chunks), 4);
		expect([...head]).toEqual([1, 2, 3, 4]);
		expect([...(await drain(stream))]).toEqual([1, 2, 3, 4]);
	});

	it('refuses a source that only ever hands back empty chunks', async () => {
		// One real byte, then nothing but empty chunks: a loop that waits for the
		// window to fill reads until the source gives up, which on a source that
		// never gives up is forever. Giving up is not EOF, so the short head is
		// refused rather than sniffed. The read count is asserted on too.
		let reads = 0;
		const stuck = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads++;
				if (reads === 1) controller.enqueue(new Uint8Array([7]));
				else if (reads <= 64) controller.enqueue(new Uint8Array(0));
				else controller.close();
			}
		});
		await expect(peekStream(stuck, 64)).rejects.toThrow(UnscrubbableImageError);
		expect(reads).toBeLessThan(64);
	});

	it('still succeeds when a run of empty chunks precedes the real data', async () => {
		// Under the give-up budget, so the empties are just slow progress, not a
		// stalled source: the peek waits them out and returns the real head.
		const chunks = [...Array(7)].map(() => new Uint8Array(0));
		chunks.push(new Uint8Array([1, 2, 3, 4]));
		const { head, stream } = await peekStream(streamOf(chunks), 4);
		expect([...head]).toEqual([1, 2, 3, 4]);
		expect([...(await drain(stream))]).toEqual([1, 2, 3, 4]);
	});

	it('handles an empty body', async () => {
		const { head, stream } = await peekStream(streamOf([]), 64);
		expect(head.length).toBe(0);
		expect((await drain(stream)).length).toBe(0);
	});
});
