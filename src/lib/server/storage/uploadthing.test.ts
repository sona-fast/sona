import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifySignature } from '@uploadthing/shared';
import * as Micro from 'effect/Micro';
import * as Redacted from 'effect/Redacted';
import { UploadThingStorage } from './uploadthing';
import { MAX_BUFFER_BYTES } from './buffer';
import { ZeroKeepError } from './types';

// Stub UTApi at the module boundary — UploadThingStorage constructs its own
// instance, so the class itself is replaced with one exposing our mocks.
const { listFiles, deleteFiles, uploadFiles } = vi.hoisted(() => ({
	listFiles: vi.fn(),
	deleteFiles: vi.fn(async () => ({ success: true, deletedCount: 0 })),
	uploadFiles: vi.fn(async () => ({
		data: { ufsUrl: 'https://app123.ufs.sh/f/buffered-key' },
		error: null
	}))
}));
vi.mock('uploadthing/server', () => ({
	UTApi: class {
		listFiles = listFiles;
		deleteFiles = deleteFiles;
		uploadFiles = uploadFiles;
	}
}));

const HOUR = 60 * 60 * 1000;

// A syntactically valid UPLOADTHING_TOKEN: base64 JSON with the fields the
// streaming path needs. The apiKey is fake but sk_-shaped.
const TOKEN = btoa(
	JSON.stringify({ apiKey: 'sk_test_0123456789abcdef', appId: 'app123', regions: ['sea1'] })
);

const MiB = 1024 * 1024;

/** A pull-based source of `chunks` chunks of `chunkSize` bytes that counts how
 * many have been handed out — the probe for "consumed incrementally". */
function countingSource(chunks: number, chunkSize: number) {
	const state = { produced: 0 };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.produced === chunks) {
				controller.close();
				return;
			}
			state.produced++;
			controller.enqueue(new Uint8Array(chunkSize));
		}
	});
	return { stream, state };
}

describe('UploadThing streaming put', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		uploadFiles.mockClear();
	});

	it('uploads a body larger than MAX_BUFFER_BYTES without materializing it', async () => {
		const chunkSize = MiB;
		const chunks = 11; // 11 MiB — over the 10 MiB buffer cap the old path used
		const size = chunks * chunkSize;
		expect(size).toBeGreaterThan(MAX_BUFFER_BYTES);

		const { stream, state } = countingSource(chunks, chunkSize);
		let maxOutstanding = 0;
		let requestUrl = '';
		let requestInit: RequestInit | undefined;
		let bytesSeen = 0;

		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(url);
			requestInit = init;
			const reqBody = init?.body;
			if (!(reqBody instanceof ReadableStream)) throw new Error('expected a stream body');
			// Drain the multipart body chunk-by-chunk, tracking how far ahead the
			// source has been pulled. If put() had buffered the file, all 11 chunks
			// would already be produced before the first read.
			const reader = reqBody.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytesSeen += value.length;
				maxOutstanding = Math.max(
					maxOutstanding,
					state.produced - Math.floor(bytesSeen / chunkSize)
				);
			}
			const key = new URL(String(url)).pathname.slice(1);
			return new Response(JSON.stringify({ ufsUrl: `https://app123.ufs.sh/f/${key}` }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const storage = new UploadThingStorage({ token: TOKEN });
		const { url } = await storage.put({
			suggestedKey: 'models/x',
			body: stream,
			size,
			contentType: 'application/octet-stream',
			filename: 'avatar.vrm'
		});

		// Memory shape: the source was pulled in lockstep with the network read,
		// never ahead by more than a couple of in-flight chunks.
		expect(maxOutstanding).toBeLessThanOrEqual(3);
		expect(uploadFiles).not.toHaveBeenCalled();

		// Protocol shape: signed ingest URL for the token's region and the exact
		// framed length (declared size + multipart head/tail).
		const parsed = new URL(requestUrl);
		expect(parsed.host).toBe('sea1.ingest.uploadthing.com');
		expect(parsed.searchParams.get('x-ut-identifier')).toBe('app123');
		expect(parsed.searchParams.get('x-ut-file-size')).toBe(String(size));
		expect(parsed.searchParams.get('expires')).toBeTruthy();
		const signature = parsed.searchParams.get('signature');
		expect(signature).toBeTruthy();
		// The signature must verify against the payload it covers (the URL minus
		// the signature param itself) with the token's api key.
		const unsigned = new URL(requestUrl);
		unsigned.searchParams.delete('signature');
		await expect(
			Micro.runPromise(
				verifySignature(unsigned.toString(), signature, Redacted.make('sk_test_0123456789abcdef'))
			)
		).resolves.toBe(true);

		const headers = new Headers(requestInit?.headers);
		const contentLength = Number(headers.get('content-length'));
		expect(contentLength).toBeGreaterThan(size);
		expect(bytesSeen).toBe(contentLength);
		expect(headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);

		// Round-trip: the stored URL is one the provider recognizes as its own.
		expect(storage.owns(url)).toBe(true);
	});

	it('rejects a failed ingest response with the status detail', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('quota exceeded', { status: 403 }))
		);
		const storage = new UploadThingStorage({ token: TOKEN });
		await expect(
			storage.put({
				suggestedKey: 'models/x',
				body: new ReadableStream({ start: (c) => c.close() }),
				size: 0,
				contentType: 'application/octet-stream',
				filename: 'empty.bin'
			})
		).rejects.toThrow(/403.*quota exceeded/s);
	});

	it('falls back to the buffered uploadFiles path for a stream without a size', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const storage = new UploadThingStorage({ token: TOKEN });
		const { stream } = countingSource(2, 16);
		const { url } = await storage.put({
			suggestedKey: 'artwork/x',
			body: stream,
			contentType: 'image/png',
			filename: 'small.png'
		});
		expect(uploadFiles).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(url).toBe('https://app123.ufs.sh/f/buffered-key');
	});

	it('rejects an unusable token before touching the network', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const storage = new UploadThingStorage({ token: 'not-a-base64-json-token' });
		await expect(
			storage.put({
				suggestedKey: 'models/x',
				body: new ReadableStream({ start: (c) => c.close() }),
				size: 1,
				contentType: 'application/octet-stream',
				filename: 'x.bin'
			})
		).rejects.toThrow(/UPLOADTHING_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('UploadThing deleteOrphans', () => {
	beforeEach(() => {
		listFiles.mockReset();
		deleteFiles.mockClear();
		// Real listFiles shape: { files: [{ key, uploadedAt: <epoch millis> }] }.
		listFiles.mockResolvedValue({
			files: [
				{ key: 'referenced-key', uploadedAt: Date.now() - 100 * HOUR },
				{ key: 'old-orphan-key', uploadedAt: Date.now() - 100 * HOUR },
				{ key: 'fresh-orphan-key', uploadedAt: Date.now() }
			]
		});
	});

	it('deletes only orphans older than the gate; referenced and fresh files survive', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		const deleted = await storage.deleteOrphans(['https://app123.ufs.sh/f/referenced-key'], {
			olderThan: new Date(Date.now() - 48 * HOUR)
		});
		expect(deleted).toBe(1);
		expect(deleteFiles).toHaveBeenCalledTimes(1);
		expect(deleteFiles).toHaveBeenCalledWith(['old-orphan-key']);
	});

	it('dryRun reports the count without deleting', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		const count = await storage.deleteOrphans(['https://app123.ufs.sh/f/referenced-key'], {
			olderThan: new Date(Date.now() - 48 * HOUR),
			dryRun: true
		});
		expect(count).toBe(1);
		expect(deleteFiles).not.toHaveBeenCalled();
	});

	it('abortOnEmptyKeepSet refuses to sweep when no reference maps to a key', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		await expect(
			storage.deleteOrphans(['https://twitter.com/someone'], { abortOnEmptyKeepSet: true })
		).rejects.toBeInstanceOf(ZeroKeepError);
		expect(deleteFiles).not.toHaveBeenCalled();
	});
});
