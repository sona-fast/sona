import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifySignature } from '@uploadthing/shared';
import { version as UT_SDK_VERSION } from 'uploadthing/package.json';
import * as Micro from 'effect/Micro';
import * as Redacted from 'effect/Redacted';
import { countingSource, drainTracking, FakeFixedLengthStream } from '$lib/server/test/streams';
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

/** The success response a real ingest PUT returns: the key echoed as a ufsUrl. */
function ingestOk(url: string | URL | Request): Response {
	const key = new URL(String(url)).pathname.slice(1);
	return new Response(JSON.stringify({ ufsUrl: `https://app123.ufs.sh/f/${key}` }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
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
			({ bytes: bytesSeen, maxOutstanding } = await drainTracking(reqBody, state, chunkSize));
			return ingestOk(url);
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
		expect(parsed.searchParams.get('x-ut-file-name')).toBe('avatar.vrm');
		expect(parsed.searchParams.get('x-ut-content-disposition')).toBe('inline');
		// No explicit ACL: the app default applies, matching UTApi.uploadFiles.
		expect(parsed.searchParams.get('x-ut-acl')).toBeNull();
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
		// Protocol parity with the SDK's own ingest PUT: version header and the
		// resumable-protocol range for a fresh upload.
		expect(headers.get('x-uploadthing-version')).toBe(UT_SDK_VERSION);
		expect(headers.get('range')).toBe('bytes=0-');

		// Round-trip: the stored URL is one the provider recognizes as its own.
		expect(storage.owns(url)).toBe(true);
	});

	it('sends the framed body through FixedLengthStream when workerd provides it', async () => {
		// workerd drops a manually-set content-length on a plain-stream body and
		// falls back to chunked encoding — the fetch body must be the readable of
		// a FixedLengthStream sized to the exact framed total.
		const created: FakeFixedLengthStream[] = [];
		class RecordingFixedLengthStream extends FakeFixedLengthStream {
			constructor(byteLength: number) {
				super(byteLength);
				created.push(this);
			}
		}
		vi.stubGlobal('FixedLengthStream', RecordingFixedLengthStream);

		const size = 4 * 1024;
		const { stream } = countingSource(4, 1024);
		let requestInit: RequestInit | undefined;
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestInit = init;
			// Drain so the pipeTo pump settles.
			await new Response(init?.body as ReadableStream).arrayBuffer();
			return ingestOk(url);
		});
		vi.stubGlobal('fetch', fetchMock);

		const storage = new UploadThingStorage({ token: TOKEN });
		await storage.put({
			suggestedKey: 'artwork/x',
			body: stream,
			size,
			contentType: 'image/png',
			filename: 'x.png'
		});

		expect(created).toHaveLength(1);
		const headers = new Headers(requestInit?.headers);
		expect(created[0].byteLength).toBe(Number(headers.get('content-length')));
		expect(requestInit?.body).toBe(created[0].readable);
	});

	it.each([{ name: 'without FixedLengthStream' }, { name: 'through FixedLengthStream', stub: true }])(
		'rejects a source that yields more bytes than declared, $name',
		async ({ stub }) => {
			if (stub) vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
			const { stream } = countingSource(3, 8); // 24 bytes actual
			const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				// Drain like a real fetch would; the framed stream errors mid-body.
				// On the fixed path swallow the drain error — there the pump's
				// rejection is the one the Promise.all([fetch, pump]) contract
				// guards; on the plain path the fetch rejection itself is the signal.
				const drain = new Response(init?.body as ReadableStream).arrayBuffer();
				await (stub ? drain.catch(() => {}) : drain);
				return ingestOk(url);
			});
			vi.stubGlobal('fetch', fetchMock);
			const storage = new UploadThingStorage({ token: TOKEN });
			await expect(
				storage.put({
					suggestedKey: 'artwork/x',
					body: stream,
					size: 16, // lies: declares fewer bytes than the stream holds
					contentType: 'image/png',
					filename: 'x.png'
				})
			).rejects.toThrow(/exceeded the declared 16 bytes/);
		}
	);

	it('rejects when the source stream errors mid-body (workerd pump path)', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(8));
				c.error(new Error('source died mid-body'));
			}
		});
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			// Drain like a real fetch; swallow the readable's error — the pump's
			// rejection must surface through Promise.all, not float.
			await new Response(init?.body as ReadableStream).arrayBuffer().catch(() => {});
			return ingestOk(url);
		});
		vi.stubGlobal('fetch', fetchMock);
		const storage = new UploadThingStorage({ token: TOKEN });
		await expect(
			storage.put({
				suggestedKey: 'artwork/x',
				body: stream,
				size: 16,
				contentType: 'image/png',
				filename: 'x.png'
			})
		).rejects.toThrow('source died mid-body');
	});

	it('strips CR/LF, quotes and backslashes from the filename in the multipart head', async () => {
		let bodyText = '';
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			bodyText = await new Response(init?.body as ReadableStream).text();
			return ingestOk(url);
		});
		vi.stubGlobal('fetch', fetchMock);

		const storage = new UploadThingStorage({ token: TOKEN });
		const { stream } = countingSource(1, 4);
		await storage.put({
			suggestedKey: 'artwork/x',
			body: stream,
			size: 4,
			contentType: 'image/png',
			filename: 'evil"name\r\n.png\\'
		});

		const head = bodyText.slice(0, bodyText.indexOf('\r\n\r\n'));
		const lines = head.split('\r\n');
		// Exactly boundary + disposition + content-type: a smuggled CR/LF would
		// add a line, an unescaped quote would break the filename token, and a
		// trailing backslash would escape the closing quote.
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe(
			'Content-Disposition: form-data; name="file"; filename="evil_name__.png_"'
		);
		expect(lines[2]).toBe('Content-Type: image/png');
	});

	it('rejects a content type with unsafe characters before touching the network', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const storage = new UploadThingStorage({ token: TOKEN });
		const { stream } = countingSource(1, 4);
		await expect(
			storage.put({
				suggestedKey: 'artwork/x',
				body: stream,
				size: 4,
				contentType: 'image/png\r\nx-injected: 1',
				filename: 'x.png'
			})
		).rejects.toThrow(/unsafe characters/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a token whose ingestHost is not a plain DNS name', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const hostileToken = btoa(
			JSON.stringify({
				apiKey: 'sk_test_0123456789abcdef',
				appId: 'app123',
				regions: ['sea1'],
				ingestHost: 'x@evil.example'
			})
		);
		const storage = new UploadThingStorage({ token: hostileToken });
		await expect(
			storage.put({
				suggestedKey: 'artwork/x',
				body: countingSource(1, 4).stream,
				size: 4,
				contentType: 'image/png',
				filename: 'x.png'
			})
		).rejects.toThrow(/UPLOADTHING_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Shapes that ONLY the HOST_RE gate rejects (a path suffix and a port pass
	// both base64-JSON parsing and the string-type checks): the guard must be
	// what stops the token author from steering the signed upload elsewhere.
	it.each([
		['a region carrying a path', { regions: ['evil.example/'] }],
		['an ingestHost carrying a port', { regions: ['sea1'], ingestHost: 'evil.example:1337' }]
	])('rejects a token with %s', async (_shape, fields) => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const hostileToken = btoa(
			JSON.stringify({ apiKey: 'sk_test_0123456789abcdef', appId: 'app123', ...fields })
		);
		const storage = new UploadThingStorage({ token: hostileToken });
		await expect(
			storage.put({
				suggestedKey: 'artwork/x',
				body: countingSource(1, 4).stream,
				size: 4,
				contentType: 'image/png',
				filename: 'x.png'
			})
		).rejects.toThrow(/UPLOADTHING_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
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

	it('rejects a 200 response that carries no ufsUrl, surfacing the detail', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: 'no slot' }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
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
		).rejects.toThrow(/returned no ufsUrl: no slot/);
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

	it('round-trips: a URL returned by the streaming put survives an orphan sweep', async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => ingestOk(url));
		vi.stubGlobal('fetch', fetchMock);
		const storage = new UploadThingStorage({ token: TOKEN });
		const { stream } = countingSource(1, 8);
		const { url } = await storage.put({
			suggestedKey: 'artwork/x',
			body: stream,
			size: 8,
			contentType: 'image/png',
			filename: 'x.png'
		});

		// The store lists exactly the generated key the put uploaded to; sweeping
		// with the stored URL as the reference set must keep it.
		deleteFiles.mockClear();
		listFiles.mockResolvedValue({
			files: [{ key: new URL(url).pathname.split('/').pop(), uploadedAt: 0 }]
		});
		const deleted = await storage.deleteOrphans([url]);
		expect(deleted).toBe(0);
		expect(deleteFiles).not.toHaveBeenCalled();
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
