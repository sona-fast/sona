import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubImageMetadata } from '../../src/lib/server/storage/scrub-metadata';
import { jpegFixture } from '../../src/lib/server/storage/scrub-metadata.fixtures';

// Workerd-parity harness for the storage streaming paths (SONA-140).
//
// The SONA-136 review found its two worst bugs ONLY under real workerd — the
// Node unit suite was green through both:
//  1. workerd drops a manually-set content-length header on a plain
//     ReadableStream fetch body and sends chunked encoding; only a
//     FixedLengthStream body carries a real Content-Length.
//  2. An over-length source through FixedLengthStream leaves a truncated R2
//     object of exactly the declared size even though put() rejects.
// This suite pins both behaviors (and the happy paths) by bundling the REAL
// provider code into a worker (tests/integration/worker-fixtures/
// storage-worker.ts) and running it under Miniflare's workerd. Outbound
// fetches from the worker are routed to `outboundService` below, so nothing
// leaves the process and the ingest PUT can be captured as workerd sent it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Same shape the SDK's token schema parses; fake but sk_-shaped key.
const TOKEN = Buffer.from(
	JSON.stringify({ apiKey: 'sk_test_0123456789abcdef', appId: 'testapp', regions: ['sea1'] })
).toString('base64');

interface CapturedRequest {
	url: string;
	method: string;
	contentLength: string | null;
	transferEncoding: string | null;
	bodyBytes: number;
	bodySha256: string;
	headText: string;
	/** Whole body, for the small-body scenarios that assert on stored bytes. */
	bodyBase64: string | null;
}

let mf: Miniflare;
let workerOrigin: string;
const captured: CapturedRequest[] = [];

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [path.join(repoRoot, 'tests/integration/worker-fixtures/storage-worker.ts')],
		bundle: true,
		write: false,
		format: 'esm',
		// Resolve workerd-flavored entry points where packages offer them.
		conditions: ['workerd', 'worker', 'browser'],
		platform: 'browser',
		target: 'es2022',
		// $app/environment is a SvelteKit virtual module ($lib resolves via
		// tsconfig paths, this doesn't) — alias it to the same stub vitest
		// uses, since #289 routed buffer.ts → $lib/config → $app/environment
		// into this bundle. The stub pins dev=false, matching a prod build.
		alias: {
			'$app/environment': path.join(repoRoot, 'vitest-stubs/app-environment.ts')
		}
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		// Matches wrangler.toml.example — and must stay within what the pinned
		// miniflare's workerd binary supports.
		compatibilityDate: '2025-04-01',
		r2Buckets: ['IMAGES'],
		bindings: { UPLOADTHING_TOKEN: TOKEN },
		// Every fetch the worker makes lands here instead of the network. The
		// Request arrives as workerd dispatched it, so the content-length /
		// transfer-encoding split is observable.
		outboundService: async (request: Request) => {
			const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
			captured.push({
				url: request.url,
				method: request.method,
				contentLength: request.headers.get('content-length'),
				transferEncoding: request.headers.get('transfer-encoding'),
				bodyBytes: body.length,
				bodySha256: createHash('sha256').update(body).digest('hex'),
				headText: body.subarray(0, 512).toString('latin1'),
				bodyBase64: body.length <= 64 * 1024 ? body.toString('base64') : null
			});
			const key = new URL(request.url).pathname.slice(1);
			return new Response(JSON.stringify({ ufsUrl: `https://testapp.ufs.sh/f/${key}` }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
	});
	workerOrigin = String(await mf.ready);
}, 120_000);

afterAll(async () => {
	await mf?.dispose();
});

async function run(scenario: string): Promise<Record<string, unknown>> {
	const res = await fetch(new URL(`/?scenario=${scenario}`, workerOrigin));
	const text = await res.text();
	if (!res.ok) throw new Error(`scenario ${scenario} failed: ${res.status} ${text}`);
	return JSON.parse(text);
}

describe('storage streaming under real workerd', () => {
	it('CONTROL: workerd drops a manual content-length on a plain stream body', async () => {
		captured.length = 0;
		await run('control-manual-header');
		expect(captured).toHaveLength(1);
		// If this ever starts carrying a content-length, workerd's behavior
		// changed and the FixedLengthStream wrapping may no longer be needed —
		// but more importantly the harness would stop discriminating, so every
		// other assertion here would need re-validating.
		expect(captured[0].contentLength).toBeNull();
		expect(captured[0].bodyBytes).toBe(4 * 1024 * 1024);
	});

	it('the ingest PUT carries an exact Content-Length and well-formed framing', async () => {
		captured.length = 0;
		const result = await run('uploadthing-streaming-put');
		expect(captured).toHaveLength(1);
		const put = captured[0];
		expect(put.method).toBe('PUT');
		expect(put.url).toMatch(/^https:\/\/sea1\.ingest\.uploadthing\.com\//);

		// The load-bearing assertion: a REAL length, exactly the bytes sent, no
		// chunked encoding — the bug the FixedLengthStream wrapping fixes.
		expect(put.contentLength).not.toBeNull();
		expect(Number(put.contentLength)).toBe(put.bodyBytes);
		expect(put.transferEncoding).toBeNull();

		// Framing: multipart head, then the declared payload, then the closing
		// boundary — total = head + size + tail.
		expect(put.headText).toMatch(/^--[^\r\n]+\r\ncontent-disposition: form-data; name="file"/i);
		expect(put.bodyBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(put.bodyBytes).toBeLessThan(8 * 1024 * 1024 + 1024);

		// And the provider surfaced the ingest response's ufsUrl.
		expect(String(result.url)).toMatch(/^https:\/\/testapp\.ufs\.sh\/f\//);
	});

	it('R2 stores a streamed body byte-exact with intact httpMetadata', async () => {
		const result = await run('r2-streaming-put');
		expect(result.storedSize).toBe(8 * 1024 * 1024);
		expect(result.contentType).toBe('application/octet-stream');
		expect(result.cacheControl).toBe('public, max-age=86400');
		expect(result.url).toBe('/img/it/exact.bin');
	});

	it('an over-length source rejects the put; any leftover is exactly the declared size', async () => {
		const result = await run('r2-over-length');
		expect(String(result.rejected)).toMatch(/too many bytes/i);
		// NOT reliably atomic: whether a truncated object commits is a race
		// between the store completing its write (FixedLengthStream ends its
		// readable at exactly byteLength) and the pump's rejection. Both
		// outcomes have been observed on this stack. What must hold: the call
		// rejected, and anything left behind is exactly the declared size —
		// never a partial of some other length.
		if (result.leftoverSize != null) {
			expect(result.leftoverSize).toBe(2 * 1024 * 1024);
		}
	});

	it('the scrubbing decorator stores scrubbed bytes at the declared length', async () => {
		const result = await run('r2-scrubbing-put');
		const expected = scrubImageMetadata(jpegFixture());
		// The declared size is the ORIGINAL length: the scrub is size-preserving,
		// which is what lets a streaming put keep its length declaration.
		expect(result.declaredSize).toBe(jpegFixture().length);
		expect(result.storedSize).toBe(expected.length);
		expect(result.storedHex).toBe(Buffer.from(expected).toString('hex'));
		// And the stored object no longer carries what the fixture came in with.
		expect(Buffer.from(expected).toString('latin1')).not.toContain('GPSLatitude');
		expect(result.url).toBe('/img/it/photo.jpg');
	});

	it(
		'streams a 4 MiB GIF that is nearly all pad bytes without exhausting the heap',
		async () => {
			// The amplification this guards is per INPUT BYTE, so what matters is
			// the run, not the picture: 4 MiB of pad under the real 128 MB isolate.
			const result = await run('r2-pad-run-gif');
			expect(result.storedSize).toBe(result.declaredSize);
			expect(result.identical).toBe(true);
		},
		// Well under this suite's 180 s default on purpose: walking the run a byte
		// at a time takes about two minutes here where the block walk takes a third
		// of a second, so the cost regression fails the test rather than hiding in
		// a passing one.
		30_000
	);

	it('the scrubbing decorator scrubs the UploadThing ingest body too', async () => {
		captured.length = 0;
		const jpeg = jpegFixture();
		const result = await run('uploadthing-scrubbing-put');
		expect(captured).toHaveLength(1);
		const put = captured[0];
		// The framed body carries the scrubbed bytes, and the declared length is
		// still the original size — the same size-preserving contract R2 relies on.
		expect(result.declaredSize).toBe(jpeg.length);
		expect(Number(put.contentLength)).toBe(put.bodyBytes);
		expect(put.bodyBytes).toBeGreaterThan(jpeg.length);
		const body = Buffer.from(put.bodyBase64!, 'base64').toString('latin1');
		expect(body).toContain(Buffer.from(scrubImageMetadata(jpeg)).toString('latin1'));
		expect(body).not.toContain('GPSLatitude');
	});

	it('a body the scrubber cannot walk rejects the put instead of hanging', async () => {
		const result = await run('r2-unscrubbable-stream');
		expect(String(result.rejected)).toMatch(/UnscrubbableImageError/);
		expect(result.keyAbsent).toBe(true);
	});

	it('the UploadThing wrap keeps the refusal detectable, which is what makes the 422', async () => {
		// UploadThing is the default provider, and on its streaming path nothing
		// throws UnscrubbableImageError to the caller: the SDK's fetch rejects
		// with its own error carrying ours underneath. /api/upload decides the
		// 422 on isUnscrubbable(), so the walk has to survive the REAL wrap.
		const result = await run('uploadthing-unscrubbable-stream');
		expect(result.rejected).not.toBeNull();
		expect(result.unscrubbable).toBe(true);
	});

	it('an under-length source rejects the put and leaves the key absent', async () => {
		const result = await run('r2-under-length');
		expect(String(result.rejected)).toMatch(/did not see all expected bytes/i);
		expect(result.keyAbsent).toBe(true);
	});
});
