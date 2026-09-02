// Worker entry for the storage-streaming integration harness (SONA-140).
// Bundled by esbuild inside the test and run under REAL workerd via Miniflare —
// the whole point is to exercise runtime behavior Node cannot model: how
// workerd treats manually-set content-length headers on stream bodies, and how
// R2 + FixedLengthStream behave on length mismatches. Each request runs one
// named scenario and returns a JSON verdict for the Node side to assert on.
import { R2Storage } from '../../../src/lib/server/storage/r2';
import { UploadThingStorage } from '../../../src/lib/server/storage/uploadthing';
import { withMetadataScrubbing } from '../../../src/lib/server/storage/scrub';
import { jpegFixture, padRunGif } from '../../../src/lib/server/storage/scrub-metadata.fixtures';
import { isUnscrubbable } from '../../../src/lib/server/storage/scrub-metadata';
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

/** A pull-based stream replaying `bytes` in `chunkSize` pieces. */
function chunked(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.subarray(at, Math.min(at + chunkSize, bytes.length)));
			at += chunkSize;
		}
	});
}

function hex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
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

				// SONA-170: the scrubbing decorator on the STREAMING R2 path under
				// real workerd. Node's unit suite exercises the buffering branch
				// (there is no FixedLengthStream there), so only this proves the
				// scrub keeps the declared length through a FixedLengthStream.
				case 'r2-scrubbing-put': {
					const storage = withMetadataScrubbing(
						new R2Storage({ bucket: env.IMAGES, publicBase: '/img' })
					);
					const jpeg = jpegFixture();
					const { url } = await storage.put({
						suggestedKey: 'it/photo.jpg',
						body: chunked(jpeg, 7),
						size: jpeg.length,
						contentType: 'image/jpeg',
						filename: 'photo.jpg'
					});
					const object = await env.IMAGES.get('it/photo.jpg');
					const stored = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array(0);
					return json({ url, declaredSize: jpeg.length, storedSize: stored.length, storedHex: hex(stored) });
				}

				// A file that is mostly a run of ONE repeated byte: the walk used to
				// step through it a byte at a time and hand the driver a piece per
				// byte, which exhausts this isolate's heap long before the upload
				// cap. Node's suite cannot show that, because only here is the heap
				// the real one.
				case 'r2-pad-run-gif': {
					const storage = withMetadataScrubbing(
						new R2Storage({ bucket: env.IMAGES, publicBase: '/img' })
					);
					const gif = padRunGif(4 * MiB);
					await storage.put({
						suggestedKey: 'it/pad.gif',
						body: chunked(gif, 64 * 1024),
						size: gif.length,
						contentType: 'image/gif',
						filename: 'pad.gif'
					});
					const object = await env.IMAGES.get('it/pad.gif');
					const stored = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array(0);
					// Compared here rather than shipped out as hex: 4 MiB of pad is
					// an 8 MB string the Node side has no use for.
					let identical = stored.length === gif.length;
					for (let at = 0; identical && at < gif.length; at++) identical = stored[at] === gif[at];
					return json({ declaredSize: gif.length, storedSize: stored.length, identical });
				}

				// The same scrub on the OTHER provider's streaming path: the bytes
				// the ingest PUT carries are what UploadThing would store, and the
				// capture side reads them out of the multipart frame.
				case 'uploadthing-scrubbing-put': {
					const storage = withMetadataScrubbing(
						new UploadThingStorage({ token: env.UPLOADTHING_TOKEN })
					);
					const jpeg = jpegFixture();
					const { url } = await storage.put({
						suggestedKey: 'it/photo.jpg',
						body: chunked(jpeg, 7),
						size: jpeg.length,
						contentType: 'image/jpeg',
						filename: 'photo.jpg'
					});
					return json({ url, declaredSize: jpeg.length });
				}

				// A body the scrubber cannot walk must REJECT the put rather than
				// leave the provider waiting on bytes that never arrive.
				case 'r2-unscrubbable-stream': {
					const storage = withMetadataScrubbing(
						new R2Storage({ bucket: env.IMAGES, publicBase: '/img' })
					);
					const truncated = jpegFixture({ truncated: true });
					let rejected: string | null = null;
					try {
						await storage.put({
							suggestedKey: 'it/bad.jpg',
							body: chunked(truncated, 7),
							size: truncated.length,
							contentType: 'image/jpeg',
							filename: 'bad.jpg'
						});
					} catch (e) {
						rejected = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
					}
					const head = await env.IMAGES.head('it/bad.jpg');
					return json({ rejected, keyAbsent: head === null });
				}

				// The same refusal on the UploadThing path, where the SDK's own fetch
				// wraps it. /api/upload maps the 422 off isUnscrubbable(), so what
				// matters is that the refusal is still FINDABLE after that wrap —
				// under the real SDK and the real runtime, not a stubbed fetch.
				case 'uploadthing-unscrubbable-stream': {
					const storage = withMetadataScrubbing(
						new UploadThingStorage({ token: env.UPLOADTHING_TOKEN })
					);
					const truncated = jpegFixture({ truncated: true });
					let rejected: string | null = null;
					let unscrubbable = false;
					try {
						await storage.put({
							suggestedKey: 'it/bad.jpg',
							body: chunked(truncated, 7),
							size: truncated.length,
							contentType: 'image/jpeg',
							filename: 'bad.jpg'
						});
					} catch (e) {
						rejected = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
						unscrubbable = isUnscrubbable(e);
					}
					return json({ rejected, unscrubbable });
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
