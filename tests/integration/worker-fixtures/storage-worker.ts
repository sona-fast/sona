// Worker entry for the storage-streaming integration harness (SONA-140).
// Bundled by esbuild inside the test and run under REAL workerd via Miniflare —
// the whole point is to exercise runtime behavior Node cannot model: how
// workerd treats manually-set content-length headers on stream bodies, and how
// R2 + FixedLengthStream behave on length mismatches. Each request runs one
// named scenario and returns a JSON verdict for the Node side to assert on.
import { R2Storage } from '../../../src/lib/server/storage/r2';
import { UploadThingStorage } from '../../../src/lib/server/storage/uploadthing';
import type { R2Bucket } from '@cloudflare/workers-types';

interface Env {
	IMAGES: R2Bucket;
	UPLOADTHING_TOKEN: string;
}

const MiB = 1024 * 1024;

/** A pull-based stream of `chunks` × `chunkSize` zero bytes. */
function source(chunks: number, chunkSize: number): ReadableStream<Uint8Array> {
	let produced = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (produced === chunks) {
				controller.close();
				return;
			}
			produced++;
			controller.enqueue(new Uint8Array(chunkSize));
		}
	});
}

async function json(data: unknown): Promise<Response> {
	return new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json' }
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const scenario = new URL(request.url).searchParams.get('scenario');
		try {
			switch (scenario) {
				// CONTROL: a plain stream body with a manually-set content-length.
				// Under workerd the header is dropped and the request goes out
				// chunked — if the capture side sees a content-length here, the
				// harness cannot discriminate and every other assertion is void.
				case 'control-manual-header': {
					const res = await fetch('https://sea1.ingest.uploadthing.com/control', {
						method: 'PUT',
						headers: { 'content-length': String(4 * MiB) },
						body: source(4, MiB)
					});
					return json({ ok: res.ok });
				}

				// The real provider path: streaming put via the presigned ingest
				// PUT. The capture side asserts the outbound request carries an
				// exact content-length (head+size+tail) and no chunked encoding.
				case 'uploadthing-streaming-put': {
					const storage = new UploadThingStorage({ token: env.UPLOADTHING_TOKEN });
					const size = 8 * MiB;
					const { url } = await storage.put({
						suggestedKey: 'models/x',
						body: source(8, MiB),
						size,
						contentType: 'application/octet-stream',
						filename: 'model.vrm'
					});
					return json({ url, size });
				}

				// R2 streamed put: byte-exact storage with intact httpMetadata.
				case 'r2-streaming-put': {
					const storage = new R2Storage({ bucket: env.IMAGES, publicBase: '/img' });
					const size = 8 * MiB;
					const { url } = await storage.put({
						suggestedKey: 'it/exact.bin',
						body: source(8, MiB),
						size,
						contentType: 'application/octet-stream',
						filename: 'exact.bin'
					});
					const head = await env.IMAGES.head('it/exact.bin');
					return json({
						url,
						storedSize: head?.size ?? null,
						contentType: head?.httpMetadata?.contentType ?? null,
						cacheControl: head?.httpMetadata?.cacheControl ?? null
					});
				}

				// Over-length source: put() must reject — and per the documented
				// (non-atomic) invariant, a truncated object of exactly the
				// declared size persists at the key.
				case 'r2-over-length': {
					const storage = new R2Storage({ bucket: env.IMAGES, publicBase: '/img' });
					let rejected: string | null = null;
					try {
						await storage.put({
							suggestedKey: 'it/over.bin',
							body: source(4, MiB), // 4 MiB actual
							size: 2 * MiB, // declares less
							contentType: 'application/octet-stream',
							filename: 'over.bin'
						});
					} catch (e) {
						rejected = e instanceof Error ? e.message : String(e);
					}
					const head = await env.IMAGES.head('it/over.bin');
					return json({ rejected, leftoverSize: head?.size ?? null });
				}

				// Under-length source: put() must reject and leave the key absent.
				case 'r2-under-length': {
					const storage = new R2Storage({ bucket: env.IMAGES, publicBase: '/img' });
					let rejected: string | null = null;
					try {
						await storage.put({
							suggestedKey: 'it/under.bin',
							body: source(2, MiB), // 2 MiB actual
							size: 4 * MiB, // declares more
							contentType: 'application/octet-stream',
							filename: 'under.bin'
						});
					} catch (e) {
						rejected = e instanceof Error ? e.message : String(e);
					}
					const head = await env.IMAGES.head('it/under.bin');
					return json({ rejected, keyAbsent: head === null });
				}

				default:
					return new Response(`unknown scenario: ${scenario}`, { status: 400 });
			}
		} catch (e) {
			return new Response(e instanceof Error ? `${e.message}\n${e.stack}` : String(e), {
				status: 500
			});
		}
	}
};
