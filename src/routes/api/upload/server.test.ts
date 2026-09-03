import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isHttpError } from '@sveltejs/kit';
import { clearSettingsCache } from '$lib/server/settings';
import { getStorage } from '$lib/server/storage';
import { MAX_BUFFER_BYTES } from '$lib/server/storage/buffer';
import { UnscrubbableImageError, UNSCRUBBABLE_MESSAGE } from '$lib/server/storage/scrub-metadata';
import { withMetadataScrubbing } from '$lib/server/storage/scrub';
import { UploadThingStorage } from '$lib/server/storage/uploadthing';
import { avifFixture, jpegFixture } from '$lib/server/storage/scrub-metadata.fixtures';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';
import { PNG_MAGIC } from '$lib/server/test/raster-fixtures';

// UTApi is constructed in UploadThingStorage's constructor and never used by
// the streaming path these tests drive; stubbed so no SDK setup is needed.
vi.mock('uploadthing/server', () => ({ UTApi: class {} }));

// The 422 assertions probe what was RECORDED, not just what was thrown — a
// failure sample with the wrong status is invisible in the metrics dashboard.
const recordUpload = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/server/metrics', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/metrics')>();
	return { ...original, recordUpload };
});

// Stub only the provider resolution — the endpoint's own validation
// (allowlist, sniff, size cap) stays real. `put` is what the assertions probe:
// the endpoint must hand the provider a stream plus the declared size.
const put = vi.hoisted(() =>
	vi.fn(async (_input?: unknown) => ({ url: '/img/artwork/stored.png' }))
);
vi.mock('$lib/server/storage', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage')>();
	return { ...original, getStorage: vi.fn(() => ({ put })) };
});

function makePlatform() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	return { env: { DB: makeD1(sqlite) } } as unknown as App.Platform;
}

function pngFile(size: number, name = 'a.png', type = 'image/png') {
	const bytes = new Uint8Array(size);
	bytes.set(PNG_MAGIC);
	return new File([bytes], name, { type });
}

function postEvent(platform: App.Platform, file: File, folder?: string) {
	const form = new FormData();
	form.append('file', file);
	if (folder) form.append('folder', folder);
	const request = new Request('http://localhost/api/upload', { method: 'POST', body: form });
	return { request, platform } as never;
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		await fn();
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
	put.mockClear();
	recordUpload.mockClear();
});

describe('POST /api/upload', () => {
	it('streams the file to the provider with its declared size', async () => {
		const file = pngFile(64 * 1024);
		let drained = 0;
		put.mockImplementationOnce(async (input?: unknown) => {
			const { body } = input as { body: ReadableStream<Uint8Array> };
			drained = (await new Response(body).arrayBuffer()).byteLength;
			return { url: '/img/artwork/stored.png' };
		});

		const res = (await POST(postEvent(makePlatform(), file))) as Response;

		expect(put).toHaveBeenCalledTimes(1);
		const input = put.mock.calls[0][0] as unknown as {
			body: unknown;
			size: number;
			contentType: string;
			suggestedKey: string;
			filename: string;
		};
		// The provider gets the STREAM plus the exact declared size — never a
		// buffered copy (that is what lets large uploads bypass buffering).
		expect(input.body).toBeInstanceOf(ReadableStream);
		expect(input.size).toBe(file.size);
		expect(drained).toBe(file.size);
		expect(input.contentType).toBe('image/png');
		expect(input.suggestedKey).toMatch(/^artwork\/[0-9a-f-]+\.png$/);
		expect(input.filename).toBe('a.png');
		// The dev-relative provider URL is absolutized against the request origin.
		expect(await res.json()).toEqual({
			url: 'http://localhost/img/artwork/stored.png',
			size: file.size
		});
	});

	it('413s an oversized declared Content-Length BEFORE reading the body (pre-check layer)', async () => {
		// Layer 1: an explicit oversized header must be rejected without ever
		// materializing the multipart body — formData() must not be invoked.
		const event = postEvent(makePlatform(), pngFile(1024)) as { request: Request };
		Object.defineProperty(event.request, 'headers', {
			value: new Headers({ 'content-length': String(70 * 1024 * 1024) })
		});
		const formData = vi.spyOn(event.request, 'formData');
		expect(await statusOf(() => POST(event as never))).toBe(413);
		expect(formData).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it('413s a file over MAX_BUFFER_BYTES without calling the provider', async () => {
		const file = pngFile(MAX_BUFFER_BYTES + 1);
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(413);
		expect(put).not.toHaveBeenCalled();
	});

	it('accepts an image over the old 10 MiB cap (LITERAL — pins the raise)', async () => {
		// The cap was raised from 10 MiB: it rejected real uploads (an 11.8 MB
		// photo) and sat below art already live on forks (a ~38 MB gif). A literal
		// 12 MiB fixture pins the raise memory-cheaply so it can't silently regress.
		const file = pngFile(12 * 1024 * 1024);
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(200);
		expect(put).toHaveBeenCalledTimes(1);
	});

	it('pins the cap at 64 MiB (LITERAL — guards against silent upward drift)', () => {
		// The 64 MiB cap exists for isolate memory safety (one buffered copy is
		// half the 128 MB ceiling); a raise must trip this pin and be re-justified.
		// The constant-driven 413 test above covers enforcement.
		expect(MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024);
	});

	it('accepts a video/webm clip whose head carries the EBML magic (SONA-124)', async () => {
		// The VR showcase widening: webm rides the image endpoint but is verified
		// against its own signature, not the raster sniff.
		const bytes = new Uint8Array(2048);
		// EBML magic + webm DocType (magic alone is Matroska-family, rejected).
		bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
		const file = new File([bytes], 'clip.webm', { type: 'video/webm' });
		// The widening is scoped to the vr-media folder — other folders stay raster-only.
		const res = (await POST(postEvent(makePlatform(), file, 'vr-media'))) as Response;
		expect(res.status).toBe(200);
		expect(put).toHaveBeenCalledTimes(1);
		expect((put.mock.calls[0][0] as unknown as { contentType: string }).contentType).toBe('video/webm');
	});

	it('415s a video/webm upload whose bytes are actually HTML (spoofed type)', async () => {
		const file = new File([new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>')], 'clip.webm', {
			type: 'video/webm'
		});
		expect(await statusOf(() => POST(postEvent(makePlatform(), file, 'vr-media')))).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});

	it('415s a valid webm outside the vr-media folder (raster-only callers stay raster-only)', async () => {
		const bytes = new Uint8Array(2048);
		// EBML magic + webm DocType (magic alone is Matroska-family, rejected).
		bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
		const file = new File([bytes], 'clip.webm', { type: 'video/webm' });
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});

	it('accepts an AVIF whose avif brand sits past byte 64 of its ftyp', async () => {
		// A real encoder can pad compatible_brands far enough that the `avif`
		// brand lands past a 64-byte head. Sniffing that short a window 415s a
		// file the scrubber and the storage layer both handle, so the endpoint
		// reads SNIFF_BYTES — the same window the sniffer is specified against.
		const avif = new Uint8Array(avifFixture({ longFtyp: true }).file);
		const file = new File([avif], 'a.avif', { type: 'image/avif' });
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(200);
		expect(put).toHaveBeenCalledTimes(1);
	});

	it('415s other video types (mp4 is not in the allowlist)', async () => {
		// ftyp box — a plausible real mp4 head; the declared type alone must sink it.
		const bytes = new Uint8Array(64);
		bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
		const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});

	it('422s a file whose metadata could not be stripped, without recording an upload failure', async () => {
		// The storage layer refuses to store a raster it could not walk
		// (SONA-170). That is a file problem with a fix the operator can apply,
		// so it must not surface as an unexplained 500.
		put.mockImplementationOnce(async () => {
			throw new UnscrubbableImageError('jpeg: segment length runs past the end of the file');
		});
		const platform = makePlatform();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let thrown: unknown;
		try {
			await POST(postEvent(platform, pngFile(1024)));
		} catch (e) {
			thrown = e;
		}
		expect(isHttpError(thrown)).toBe(true);
		const httpError = thrown as { status: number; body: { message: string } };
		expect(httpError.status).toBe(422);
		expect(httpError.body.message).toBe(UNSCRUBBABLE_MESSAGE);
		// The operator sentence goes in the response; the parser's own wording
		// goes to the log, so a scrubber bug refusing real files stays diagnosable.
		expect(warn).toHaveBeenCalled();
		const [label, , logged] = warn.mock.calls[0];
		expect(label).toBe('upload: unscrubbable file');
		expect((logged as Error).message).toContain('segment length runs past the end of the file');
		warn.mockRestore();
		// A refused file is the operator's to fix, like a 413 or 415, so the
		// health panel's failure count and error samples stay untouched.
		expect(recordUpload).not.toHaveBeenCalled();
	});

	it('422s when the provider WRAPS the scrub failure (real streaming put)', async () => {
		// On the streaming path nothing ever throws UnscrubbableImageError to the
		// route: the transform errors the piped body and the provider's fetch
		// rejects with its own error ("TypeError: fetch failed") carrying ours as
		// .cause. Matching on the top-level error alone returned a 500 here.
		const token = btoa(
			JSON.stringify({ apiKey: 'sk_test_0123456789abcdef', appId: 'app123', regions: ['sea1'] })
		);
		const storage = withMetadataScrubbing(new UploadThingStorage({ token }));
		vi.mocked(getStorage).mockReturnValueOnce(storage);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				try {
					await new Response(init?.body as ReadableStream).arrayBuffer();
				} catch (e) {
					// undici's wrapping, reproduced: the real cause hangs underneath.
					throw new TypeError('fetch failed', { cause: e });
				}
				return new Response('{}', { headers: { 'content-type': 'application/json' } });
			})
		);
		const truncated = jpegFixture({ truncated: true });
		const file = new File([truncated.slice().buffer as ArrayBuffer], 'photo.jpg', {
			type: 'image/jpeg'
		});

		let thrown: unknown;
		try {
			await POST(postEvent(makePlatform(), file));
		} catch (e) {
			thrown = e;
		}
		vi.unstubAllGlobals();
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(422);
	});

	it('passes the allowlist-matched content type (parameters stripped, lowercased) to the provider', async () => {
		// new File() lowercases `type` per the Blob spec and the multipart
		// round-trip re-normalizes too, so shadow the getter and hand the route
		// the in-memory FormData — proving the endpoint normalizes on its own.
		const file = pngFile(1024);
		Object.defineProperty(file, 'type', { value: 'IMAGE/PNG; charset=UTF-8' });
		const event = postEvent(makePlatform(), file) as { request: Request };
		const form = new FormData();
		form.append('file', file);
		vi.spyOn(event.request, 'formData').mockResolvedValue(form);
		await POST(event as never);
		expect(put).toHaveBeenCalledTimes(1);
		expect((put.mock.calls[0][0] as unknown as { contentType: string }).contentType).toBe(
			'image/png'
		);
	});
});
