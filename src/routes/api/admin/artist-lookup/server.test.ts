import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { isHttpError } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';
import { setRawSetting, getRawSetting } from '$lib/server/settings';
import {
	FUZZYSEARCH_API_KEY_SETTING,
	FUZZYSEARCH_KEY_REFUSED_SETTING,
	FUZZYSEARCH_MAX_BYTES,
	type LookupResult
} from '$lib/server/fuzzysearch';
import { makeD1 } from '$lib/server/test/d1';
import { POST } from './+server';

// Only the outbound call is stubbed: normalization, banding, URL building and
// the local-artist matching stay real, so the endpoint's own wiring is what
// these tests exercise.
const searchImage = vi.hoisted(() =>
	vi.fn(
		async (
			_bytes: Blob | ArrayBuffer,
			_key: string,
			_fetchFn?: typeof fetch
		): Promise<LookupResult> => ({ ok: true, matches: [] })
	)
);
vi.mock('$lib/server/fuzzysearch', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/fuzzysearch')>();
	return { ...original, searchImage };
});

const DDL = `CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT,
		image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
		md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
		source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
		parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
		featured_order INTEGER, created_at TEXT);
	CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, global_id TEXT UNIQUE,
		registry_version INTEGER, registry_synced_at TEXT, aliases TEXT,
		avatar_resolved_at TEXT, created_at TEXT NOT NULL);`;

/** A PNG stand-in — the endpoint never decodes, but it does sniff the leading
 * bytes of an uploaded file, so the signature has to be the real one. */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeEnv(env: Record<string, unknown> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	const d1 = makeD1(sqlite);
	return {
		sqlite,
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1, ...env } } as unknown as App.Platform
	};
}

/** event.fetch, answering with stored image bytes unless told otherwise. */
function imageFetch(response?: Response) {
	const calls: string[] = [];
	const fn = (async (url: string) => {
		calls.push(String(url));
		return (
			response ??
			new Response(IMAGE_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
		);
	}) as unknown as typeof fetch;
	return { fn, calls };
}

function multipartEvent(
	platform: App.Platform,
	file: File,
	fetchFn: typeof fetch = imageFetch().fn
) {
	const form = new FormData();
	form.append('file', file);
	const request = new Request('http://localhost/api/admin/artist-lookup', {
		method: 'POST',
		body: form
	});
	return { request, platform, fetch: fetchFn } as never;
}

function jsonEvent(platform: App.Platform, body: unknown, fetchFn: typeof fetch = imageFetch().fn) {
	const request = new Request('http://localhost/api/admin/artist-lookup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { request, platform, fetch: fetchFn } as never;
}

function pngFile(size = 32) {
	const bytes = new Uint8Array(size);
	bytes.set(IMAGE_BYTES);
	return new File([bytes], 'a.png', { type: 'image/png' });
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

const FA_EXACT = {
	site: 'FurAffinity' as const,
	siteId: '12345',
	handles: ['kuttoya'],
	distance: 0,
	band: 'exact' as const,
	postedAt: null,
	rating: 'general' as const,
	postUrl: 'https://www.furaffinity.net/view/12345/'
};

beforeEach(() => {
	searchImage.mockReset();
	searchImage.mockResolvedValue({ ok: true, matches: [] });
});

describe('artist-lookup — configuration', () => {
	it('answers enabled:false with no key, and never calls out', async () => {
		const { platform } = makeEnv();
		const res = await POST(multipartEvent(platform, pngFile()));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enabled: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('prefers the deploy secret over the saved setting', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'from-env' });
		await setRawSetting(db, FUZZYSEARCH_API_KEY_SETTING, 'from-settings');

		await POST(multipartEvent(platform, pngFile()));

		expect(searchImage.mock.calls[0][1]).toBe('from-env');
	});

	it('falls back to the saved setting when no secret is deployed', async () => {
		const { db, platform } = makeEnv();
		await setRawSetting(db, FUZZYSEARCH_API_KEY_SETTING, 'from-settings');

		await POST(multipartEvent(platform, pngFile()));

		expect(searchImage.mock.calls[0][1]).toBe('from-settings');
	});
});

describe('artist-lookup — uploaded file', () => {
	it('forwards the file and returns normalized matches with local artists', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (name, furaffinity_url, created_at)
			 VALUES ('Kuttoya', 'https://www.furaffinity.net/user/KUTTOYA/', '2026-01-01');
			 INSERT INTO artists (name, created_at) VALUES ('kuttoya', '2026-01-01');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(platform, pngFile()));
		const body = (await res.json()) as {
			enabled: boolean;
			matches: unknown[];
			localArtists: Array<{ matchIndex: number; artists: Array<{ id: number; name: string }> }>;
			nameMatches: Array<{ matchIndex: number; artists: Array<{ id: number }> }>;
			sourceClash: unknown;
		};

		expect(res.status).toBe(200);
		expect(body.enabled).toBe(true);
		expect(body.matches).toEqual([FA_EXACT]);
		expect(body.localArtists).toEqual([{ matchIndex: 0, artists: [{ id: 1, name: 'Kuttoya' }] }]);
		// Both rows are named for the handle; the name-only one is the weak hit.
		expect(body.nameMatches[0].artists.map((a) => a.id)).toEqual([1, 2]);
		expect(body.sourceClash).toBeNull();
		expect(searchImage.mock.calls[0][0]).toBeInstanceOf(File);
	});

	it('refuses a file over the remote-body cap on its exact size', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const res = await POST(multipartEvent(platform, pngFile(FUZZYSEARCH_MAX_BYTES + 1)));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ enabled: true, error: 'too_large' });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('refuses a declared-oversized body before reading it', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = new Request('http://localhost/api/admin/artist-lookup', {
			method: 'POST',
			headers: {
				'content-type': 'multipart/form-data; boundary=x',
				'content-length': String(FUZZYSEARCH_MAX_BYTES + 1024 * 1024)
			},
			body: '--x--'
		});
		const res = await POST({ request, platform, fetch: imageFetch().fn } as never);
		expect(res.status).toBe(413);
		expect(searchImage).not.toHaveBeenCalled();
	});

	// SVG and PDF are not the raster types storage accepts, and neither is the
	// operator's artwork to hand a third party. Refused on the declared type
	// alone, before anything leaves this app.
	it('refuses a non-raster upload without contacting FuzzySearch', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const cases = [
			new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }),
			new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })
		];
		for (const file of cases) {
			const res = await POST(multipartEvent(platform, file));
			expect(res.status, file.type).toBe(422);
			expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image' });
		}
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The declared type is the browser's word for it. A PDF renamed to .png is
	// caught by the leading bytes, the same check /api/upload applies.
	it('refuses an upload whose bytes are not the type it declares', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const spoofed = new File(['%PDF-1.7 not a png'], 'a.png', { type: 'image/png' });

		const res = await POST(multipartEvent(platform, spoofed));

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image' });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('rejects a multipart body with no file', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = new Request('http://localhost/api/admin/artist-lookup', {
			method: 'POST',
			body: new FormData()
		});
		expect(await statusOf(() => POST({ request, platform, fetch: imageFetch().fn } as never))).toBe(
			400
		);
	});
});

describe('artist-lookup — stored image by id', () => {
	it('fetches the URL the server looked up, not one the caller sent', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		const fetcher = imageFetch();

		const res = await POST(
			jsonEvent(platform, { imageId: 1, imageUrl: 'http://169.254.169.254/latest' }, fetcher.fn)
		);

		expect(res.status).toBe(200);
		// The attacker-supplied URL is never contacted; the stored one is.
		expect(fetcher.calls).toEqual(['https://cdn.example.com/stored.png']);
		expect(searchImage.mock.calls[0][0]).toBeInstanceOf(Blob);
	});

	it('rejects a body that carries only a URL', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const fetcher = imageFetch();
		expect(
			await statusOf(() =>
				POST(jsonEvent(platform, { imageUrl: 'https://evil.example/x.png' }, fetcher.fn))
			)
		).toBe(400);
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('404s an unknown id', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		expect(await statusOf(() => POST(jsonEvent(platform, { imageId: 404 })))).toBe(404);
	});

	it('sends the stored image with the content type the proxy validated', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.jpg', '2026-01-01');`
		);
		const jpeg = new Response(IMAGE_BYTES, {
			status: 200,
			headers: { 'content-type': 'image/jpeg; charset=binary' }
		});

		await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(jpeg).fn));

		// The upload page forwards a File, which carries its own type; the edit
		// page has to attach one or FuzzySearch sees an untyped part.
		expect((searchImage.mock.calls[0][0] as Blob).type).toBe('image/jpeg');
	});

	// Media types are case-insensitive. An upstream spelling it `Image/JPEG` was
	// demoted to a download by the proxy and then refused here as a non-image.
	it('accepts a stored content type whatever its case', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.jpg', '2026-01-01');`
		);
		const jpeg = new Response(IMAGE_BYTES, {
			status: 200,
			headers: { 'content-type': 'Image/JPEG; charset=binary' }
		});

		await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(jpeg).fn));

		expect((searchImage.mock.calls[0][0] as Blob).type).toBe('image/jpeg');
	});

	it('reports unavailable when the proxy refuses the stored URL', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/gone.png', '2026-01-01'),
				(2, 'Internal', 'int', 'http://169.254.169.254/latest/meta-data', '2026-01-01');`
		);

		// Upstream 404: proxyStoredImage answers null, so there are no bytes.
		const missing = imageFetch(new Response('nope', { status: 404 }));
		const gone = await POST(jsonEvent(platform, { imageId: 1 }, missing.fn));
		expect(gone.status).toBe(502);
		expect(await gone.json()).toEqual({ enabled: true, error: 'unavailable' });

		// A link-local host stored in the row is refused before any fetch.
		const internal = imageFetch();
		const blocked = await POST(jsonEvent(platform, { imageId: 2 }, internal.fn));
		expect(blocked.status).toBe(502);
		expect(internal.calls).toEqual([]);

		expect(searchImage).not.toHaveBeenCalled();
	});

	// A fetch that REJECTS rather than answering — DNS failure, reset connection,
	// TLS error. Unwrapped it escapes as a 500 with a stack, instead of the same
	// answer the null branch gives.
	it('reports unavailable when the stored fetch rejects', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		const rejecting = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;

		const res = await POST(jsonEvent(platform, { imageId: 1 }, rejecting));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable' });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('refuses a stored image whose body runs past the cap', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Huge', 'huge', 'https://cdn.example.com/huge.png', '2026-01-01');`
		);
		// Streamed in 1 MiB chunks rather than allocated whole: bufferStream aborts
		// mid-stream, which is the behaviour being pinned.
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > FUZZYSEARCH_MAX_BYTES) return controller.close();
				sent += chunk.length;
				controller.enqueue(chunk);
			}
		});
		const huge = new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });

		const res = await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(huge).fn));

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ enabled: true, error: 'too_large' });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('reports unavailable when the stored image is not an image', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		const html = new Response('<html>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});

		const res = await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(html).fn));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable' });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// Nothing reads the body of a refused type, and an unread subrequest stream
	// holds its connection open for the rest of the invocation.
	it('cancels the proxied body when the stored type is refused', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.svg', '2026-01-01');`
		);
		const canceled = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel: canceled
		});
		const svg = new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } });

		const res = await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(svg).fn));

		expect(res.status).toBe(502);
		expect(canceled).toHaveBeenCalled();
	});

	// SVG is an image type, so an `image/*` check would have sent it on. It is
	// not one of the raster types storage accepts, the proxy demotes it to a
	// download, and nothing is uploaded to FuzzySearch.
	it('reports unavailable when the stored image is an svg', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.svg', '2026-01-01');`
		);
		const svg = new Response('<svg/>', {
			status: 200,
			headers: { 'content-type': 'image/svg+xml' }
		});

		const res = await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(svg).fn));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable' });
		expect(searchImage).not.toHaveBeenCalled();
	});
});

describe('artist-lookup — failure mapping and the refused marker', () => {
	// 502, not 401: the admin gate answers an expired session with its own 401
	// and a plain-text body, so a 401 here would be indistinguishable from a
	// logged-out admin and the caller's res.json() would throw.
	it('records the refusal on a 502 and clears it on the next success', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });

		const refused = await POST(multipartEvent(platform, pngFile()));
		expect(refused.status).toBe(502);
		expect(await refused.json()).toEqual({ enabled: true, error: 'key_refused' });
		// The source rides along with the date: this refusal was the deploy
		// secret's, and the settings card must not blame a stored key for it.
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*\|env$/
		);

		searchImage.mockResolvedValue({ ok: true, matches: [] });
		const ok = await POST(multipartEvent(platform, pngFile()));
		expect(ok.status).toBe(200);
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBe('');
	});

	it('records a refusal of the saved key against that key, not the secret', async () => {
		const { db, platform } = makeEnv();
		await setRawSetting(db, FUZZYSEARCH_API_KEY_SETTING, 'from-settings');
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });

		await POST(multipartEvent(platform, pngFile()));

		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*\|stored$/
		);
	});

	// A success by the deploy secret says nothing about the stored key
	// FuzzySearch refused: clearing that marker would show "Connected" for a key
	// still being refused once the secret is dropped again.
	it('leaves a marker for the other key source standing on success', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '2026-09-01T00:00:00.000Z|stored');
		searchImage.mockResolvedValue({ ok: true, matches: [] });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBe(
			'2026-09-01T00:00:00.000Z|stored'
		);
	});

	it('clears the marker when the key that succeeded is the refused one', async () => {
		const { db, platform } = makeEnv();
		await setRawSetting(db, FUZZYSEARCH_API_KEY_SETTING, 'from-settings');
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '2026-09-01T00:00:00.000Z|stored');
		searchImage.mockResolvedValue({ ok: true, matches: [] });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBe('');
	});

	// A marker written before the source was recorded reads as 'stored', so a
	// stored-key success still clears it.
	it('clears a legacy bare-date marker on a stored-key success', async () => {
		const { db, platform } = makeEnv();
		await setRawSetting(db, FUZZYSEARCH_API_KEY_SETTING, 'from-settings');
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '2026-09-01T00:00:00.000Z');
		searchImage.mockResolvedValue({ ok: true, matches: [] });

		await POST(multipartEvent(platform, pngFile()));

		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBe('');
	});

	it('writes nothing on a clean success with no marker standing', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		// Null, not '': the happy path costs one read, and never a write that
		// would put a row in site_settings for every lookup.
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBeNull();
	});

	it('maps each remaining failure to its status without echoing a body', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const cases = [
			['rate_limited', 429],
			['too_large', 413],
			['invalid_image', 422],
			['unavailable', 502]
		] as const;
		for (const [reason, status] of cases) {
			searchImage.mockResolvedValue({ ok: false, reason });
			const res = await POST(multipartEvent(platform, pngFile()));
			expect(res.status, reason).toBe(status);
			expect(await res.json()).toEqual({ enabled: true, error: reason });
		}
	});
});

describe('artist-lookup — source-post clash', () => {
	const clashSetup = (extra = '') => {
		const env = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		env.sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, source_post_url, parent_image_id, created_at)
			 VALUES (1, 'Sparky at the beach', 'beach', 'https://cdn/1.png',
				 'http://FurAffinity.net/view/12345?full=1', NULL, '2026-01-01'),
				(2, 'Beach variant', 'beach-v', 'https://cdn/2.png',
				 'https://www.furaffinity.net/view/12345/', 1, '2026-01-02'),
				(3, 'Unrelated', 'other', 'https://cdn/3.png',
				 'https://www.furaffinity.net/view/999/', NULL, '2026-01-03');
			 ${extra}`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		return env;
	};

	it('reports the parent of the set that already carries the source URL', async () => {
		const { platform } = clashSetup();
		const res = await POST(multipartEvent(platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };

		expect(body.sourceClash).toEqual({
			imageId: 1,
			title: 'Sparky at the beach',
			isVariant: false,
			parentImageId: null,
			variantCount: 1
		});
	});

	// The URL can sit on a VARIANT only — a set whose parent row carries no
	// source URL. The clash is still the whole set, so the operator is pointed at
	// the parent they can actually open, titled from the parent's own row.
	it('reports the parent when only a variant carries the source URL', async () => {
		const env = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		env.sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, source_post_url, parent_image_id, created_at)
			 VALUES (10, 'Sparky at the beach', 'beach', 'https://cdn/10.png', NULL, NULL, '2026-01-01'),
				(11, 'Beach variant', 'beach-v', 'https://cdn/11.png',
				 'https://www.furaffinity.net/view/12345/', 10, '2026-01-02');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(env.platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };

		expect(body.sourceClash).toEqual({
			imageId: 10,
			title: 'Sparky at the beach',
			isVariant: true,
			parentImageId: 10,
			// One row in the set carries the URL, and it is the row being reported.
			variantCount: 0
		});
	});

	// Two unrelated images can carry the same source post (a two-piece
	// commission, say). They are separate clashes, not variants of the one
	// reported — counting them would claim variants this image does not have.
	it('counts only the reported set when unrelated images share the URL', async () => {
		const env = clashSetup(
			`INSERT INTO images (id, title, slug, image_url, source_post_url, parent_image_id, created_at)
			 VALUES (4, 'Same post, different piece', 'other-piece', 'https://cdn/4.png',
				 'https://www.furaffinity.net/view/12345/', NULL, '2026-01-04');`
		);

		const res = await POST(multipartEvent(env.platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };

		expect(body.sourceClash).toMatchObject({ imageId: 1, variantCount: 1 });
	});

	it('does not report an image clashing with its own variant set', async () => {
		const { platform } = clashSetup();
		const res = await POST(jsonEvent(platform, { imageId: 2 }));
		const body = (await res.json()) as { sourceClash: unknown };
		expect(body.sourceClash).toBeNull();
	});

	it('is null when nothing shares the URL, or when no match is confident', async () => {
		const { platform } = clashSetup();
		searchImage.mockResolvedValue({
			ok: true,
			matches: [{ ...FA_EXACT, distance: 5, band: 'possible' }]
		});
		const loose = await POST(multipartEvent(platform, pngFile()));
		expect(((await loose.json()) as { sourceClash: unknown }).sourceClash).toBeNull();

		searchImage.mockResolvedValue({
			ok: true,
			matches: [{ ...FA_EXACT, siteId: '55555', postUrl: 'https://www.furaffinity.net/view/55555/' }]
		});
		const none = await POST(multipartEvent(platform, pngFile()));
		expect(((await none.json()) as { sourceClash: unknown }).sourceClash).toBeNull();
	});
});
