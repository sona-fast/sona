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
	blueskyPostUrl,
	type LookupResult
} from '$lib/server/fuzzysearch';
import {
	SKYSEEK_MAX_MATCHES,
	type SkyseekMatch,
	type SkyseekResult
} from '$lib/server/skyseek';
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

// The Bluesky half's two outbound calls, stubbed the same way and for the same
// reason: the mapping, the cap, the own-post filter and the local-artist match
// stay real. By default Skyseek answers with no posts and no handle resolves.
const searchSkyseek = vi.hoisted(() =>
	vi.fn(
		async (
			_bytes: Blob,
			_fetchFn?: typeof fetch,
			_userAgent?: string
		): Promise<SkyseekResult> => ({
			ok: true,
			matches: []
		})
	)
);
const resolveBlueskyHandles = vi.hoisted(() =>
	vi.fn(async (_dids: string[], _fetchFn?: typeof fetch) => new Map<string, string>())
);
// The real handle lookup, for the test that reads the request it makes.
const realResolveBlueskyHandles = vi.hoisted(() => ({
	fn: null as null | ((dids: string[], fetchFn?: typeof fetch) => Promise<Map<string, string>>)
}));
vi.mock('$lib/server/skyseek', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/skyseek')>();
	realResolveBlueskyHandles.fn = original.resolveBlueskyHandles;
	return { ...original, searchSkyseek, resolveBlueskyHandles };
});

// The real proxy by default. It swallows its own fetch, parse and cancel
// errors today, so the only way to ask "what if it threw" is to make it throw.
const proxyStoredImageSpy = vi.hoisted(() => vi.fn<(...args: never[]) => Promise<unknown>>());
const realProxyStoredImage = vi.hoisted(() => ({
	fn: null as null | ((...args: never[]) => Promise<unknown>)
}));
vi.mock('$lib/server/image-proxy', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/image-proxy')>();
	realProxyStoredImage.fn = original.proxyStoredImage as unknown as (
		...args: never[]
	) => Promise<unknown>;
	proxyStoredImageSpy.mockImplementation(realProxyStoredImage.fn);
	return { ...original, proxyStoredImage: proxyStoredImageSpy };
});

// The real write by default; a test that needs the settings row to fail makes
// this reject for that one call. The endpoint's answer must not depend on it.
const setRawSettingSpy = vi.hoisted(() =>
	vi.fn<(...args: never[]) => Promise<unknown>>()
);
// The real implementation, kept so beforeEach can re-arm the spy after a reset:
// a once-queued rejection a test failed to consume must not reject the next
// test's first write.
const realSetRawSetting = vi.hoisted(() => ({
	fn: null as null | ((...args: never[]) => Promise<unknown>)
}));
vi.mock('$lib/server/settings', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/settings')>();
	realSetRawSetting.fn = original.setRawSetting as unknown as (...args: never[]) => Promise<unknown>;
	setRawSettingSpy.mockImplementation(realSetRawSetting.fn);
	return { ...original, setRawSetting: setRawSettingSpy };
});

// The real buffering by default. bufferStream allocates an exact-size array, so
// a Blob built from the view and one built from its backing buffer carry the
// same bytes and no assertion can tell them apart. The byte-for-byte test makes
// this hand back a view into a larger allocation for one call, which is what
// gives that test something to fail on.
const bufferStreamSpy = vi.hoisted(() => vi.fn<(...args: never[]) => Promise<Uint8Array>>());
const realBufferStream = vi.hoisted(() => ({
	fn: null as null | ((...args: never[]) => Promise<Uint8Array>)
}));
vi.mock('$lib/server/storage/buffer', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage/buffer')>();
	realBufferStream.fn = original.bufferStream as unknown as (
		...args: never[]
	) => Promise<Uint8Array>;
	bufferStreamSpy.mockImplementation(realBufferStream.fn);
	return { ...original, bufferStream: bufferStreamSpy };
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
		avatar_resolved_at TEXT, created_at TEXT NOT NULL);
	CREATE TABLE commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER UNIQUE);`;

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

/** The status AND the body of an exit that answers by throwing. The body is
 * asserted too because the client dates a failure by its `forwarded` field, and
 * a throw above the FuzzySearch call that omits it reads as sent. */
async function errorOf(fn: () => unknown): Promise<{ status: number; body: unknown }> {
	try {
		await fn();
		return { status: 200, body: null };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body };
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
	searchSkyseek.mockReset();
	searchSkyseek.mockResolvedValue({ ok: true, matches: [] });
	resolveBlueskyHandles.mockReset();
	resolveBlueskyHandles.mockResolvedValue(new Map());
	setRawSettingSpy.mockReset();
	if (realSetRawSetting.fn) setRawSettingSpy.mockImplementation(realSetRawSetting.fn);
	proxyStoredImageSpy.mockReset();
	if (realProxyStoredImage.fn) proxyStoredImageSpy.mockImplementation(realProxyStoredImage.fn);
	bufferStreamSpy.mockReset();
	if (realBufferStream.fn) bufferStreamSpy.mockImplementation(realBufferStream.fn);
});

describe('artist-lookup — configuration', () => {
	it('answers enabled:false with no key, and never calls out', async () => {
		const { platform } = makeEnv();
		const res = await POST(multipartEvent(platform, pngFile()));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enabled: false, forwarded: false });
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

	// The FIRST await in the handler, and on a fork whose key lives in settings
	// it reads D1 — where getRawSetting lets an error propagate. Unguarded it
	// answers a 500 with no `forwarded`, which the client reads as "the bytes
	// were sent" and the edit page turns into the private-image disclosure for
	// bytes that never left the worker. Deliberately no env key: with one, the
	// resolution never touches D1 and this fires nothing.
	it('answers a key lookup that throws with a dated failure, not a 500', async () => {
		const { platform } = makeEnv();
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string) => {
			if (/from "site_settings"/i.test(sql)) throw new Error('D1_ERROR: database is locked');
			return realPrepare(sql);
		};

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
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
			localArtists: Array<{
				matchIndex: number;
				artists: Array<{ id: number; name: string; pieces: number }>;
			}>;
			nameMatches: Array<{ matchIndex: number; artists: Array<{ id: number }> }>;
			sourceClash: unknown;
		};

		expect(res.status).toBe(200);
		expect(body.enabled).toBe(true);
		expect(body.matches).toEqual([FA_EXACT]);
		// `pieces` rides along so the ambiguous picker can tell two same-named
		// artists apart; this gallery has no images, so the count is 0.
		expect(body.localArtists).toEqual([
			{ matchIndex: 0, artists: [{ id: 1, name: 'Kuttoya', pieces: 0 }] }
		]);
		// Both rows are named for the handle; the name-only one is the weak hit.
		expect(body.nameMatches[0].artists.map((a) => a.id)).toEqual([1, 2]);
		expect(body.sourceClash).toBeNull();
		expect(searchImage.mock.calls[0][0]).toBeInstanceOf(File);
	});

	// Two artists can share a display name, so the picker needs something else to
	// tell them apart. One grouped count, not a query per hit.
	it('counts how many pieces each matched artist already has', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (id, name, furaffinity_url, created_at)
			 VALUES (1, 'Kuttoya', 'https://www.furaffinity.net/user/KUTTOYA/', '2026-01-01');
			 INSERT INTO images (id, title, slug, image_url, artist_id, created_at)
			 VALUES (1, 'One', 'one', 'https://cdn/1.png', 1, '2026-01-01'),
				(2, 'Two', 'two', 'https://cdn/2.png', 1, '2026-01-02');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(platform, pngFile()));
		const body = (await res.json()) as {
			localArtists: Array<{ artists: Array<{ pieces: number }> }>;
		};
		expect(body.localArtists[0].artists[0].pieces).toBe(2);
	});

	// /admin/artists shows a plain COUNT(*) over images.artist_id in its Artworks
	// column, so this count is the same one: a variant and an unpublished piece
	// both count there, and two different numbers for one artist on two admin
	// screens is the worse answer. An image with no artist is nobody's count.
	it('counts pieces the way /admin/artists does, and skips the unattributed', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (id, name, furaffinity_url, created_at)
			 VALUES (1, 'Kuttoya', 'https://www.furaffinity.net/user/KUTTOYA/', '2026-01-01');
			 INSERT INTO images (id, title, slug, image_url, artist_id, published, parent_image_id, created_at)
			 VALUES (1, 'One', 'one', 'https://cdn/1.png', 1, 1, NULL, '2026-01-01'),
				(2, 'Draft', 'two', 'https://cdn/2.png', 1, 0, NULL, '2026-01-02'),
				(3, 'Variant', 'three', 'https://cdn/3.png', 1, 1, 1, '2026-01-03'),
				(4, 'Nobody', 'four', 'https://cdn/4.png', NULL, 1, NULL, '2026-01-04');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(platform, pngFile()));
		const body = (await res.json()) as {
			localArtists: Array<{ artists: Array<{ pieces: number }> }>;
		};
		// The same expression /admin/artists selects for its Artworks column.
		const asAdminArtists = sqlite
			.prepare('SELECT COUNT(*) AS n FROM images WHERE images.artist_id = 1')
			.get() as { n: number };
		expect(asAdminArtists.n).toBe(3);
		expect(body.localArtists[0].artists[0].pieces).toBe(3);
	});

	// Nothing matched, so there is nobody to match against: neither the artist
	// table nor the piece counts are read. The gallery's whole artist list is the
	// bigger of the two queries, and it used to run on every no-match answer.
	it('reads no artists when nothing matched', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (id, name, created_at) VALUES (1, 'Kuttoya', '2026-01-01');`
		);
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		const statements: string[] = [];
		d1.prepare = (sql: string) => {
			statements.push(sql);
			return realPrepare(sql);
		};
		searchImage.mockResolvedValue({ ok: true, matches: [] });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		expect(statements.some((sql) => /from "artists"/i.test(sql))).toBe(false);
		expect(statements.some((sql) => /count\(\*\)/i.test(sql))).toBe(false);
	});

	it('refuses a file over the remote-body cap on its exact size', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const res = await POST(multipartEvent(platform, pngFile(FUZZYSEARCH_MAX_BYTES + 1)));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ enabled: true, error: 'too_large', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The adapter enforces its own body cap while parsing, and rejects with a 413
	// HttpError. A chunked body carries no content-length, so the declared-length
	// check above never sees it and this is where it lands: the operator gets
	// "too large", not an outage, and it stays out of the 5xx rollup.
	it('keeps the 413 when the adapter refuses an oversized body', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = {
			headers: new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
			formData: async () => {
				throw Object.assign(new Error('Content-length exceeds limit'), { status: 413 });
			}
		};

		const res = await POST({ request, platform, fetch: imageFetch().fn } as never);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ enabled: true, error: 'too_large', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// Any other formData rejection is still an outage, not a size refusal.
	it('reports unavailable when the body parse fails for any other reason', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = {
			headers: new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
			formData: async () => {
				throw new Error('connection reset');
			}
		};

		const res = await POST({ request, platform, fetch: imageFetch().fn } as never);

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
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
			expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image', forwarded: false });
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
		expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// Every typed exit above searchImage carries `forwarded`. An UNGUARDED throw
	// carries none: SvelteKit answers 500 with a body the client cannot date, the
	// client's "err toward sent" default then shows the private-image disclosure
	// for bytes that never left the endpoint, and the 500 lands in the operator's
	// error rollup as a server fault. The three awaits below can all reject on a
	// connection that drops mid-POST or a database that will not answer.
	it('answers a rejected formData() with a dated failure, not a 500', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = {
			headers: new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
			formData: async () => {
				throw new TypeError('connection reset');
			}
		} as unknown as Request;

		const res = await POST({ request, platform, fetch: imageFetch().fn } as never);

		// 502, the status this file gives unavailable everywhere: the point of the
		// guard is the dated body, not the number.
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('answers a file whose leading bytes will not read the same way', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const file = pngFile();
		// The part arrived, the body behind it stopped: slice() hands back a blob
		// whose arrayBuffer() never resolves with bytes.
		Object.defineProperty(file, 'slice', {
			value: () => ({
				arrayBuffer: async () => {
					throw new TypeError('stalled');
				}
			})
		});
		const form = new FormData();
		form.append('file', file);
		const request = {
			headers: new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
			formData: async () => form
		} as unknown as Request;

		const res = await POST({ request, platform, fetch: imageFetch().fn } as never);

		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('rejects a multipart body with no file', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const request = new Request('http://localhost/api/admin/artist-lookup', {
			method: 'POST',
			body: new FormData()
		});
		expect(await errorOf(() => POST({ request, platform, fetch: imageFetch().fn } as never))).toEqual(
			{ status: 400, body: { message: 'No file provided', forwarded: false } }
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
			await errorOf(() =>
				POST(jsonEvent(platform, { imageUrl: 'https://evil.example/x.png' }, fetcher.fn))
			)
		).toEqual({ status: 400, body: { message: 'Invalid image id', forwarded: false } });
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('404s an unknown id', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		expect(await errorOf(() => POST(jsonEvent(platform, { imageId: 404 })))).toEqual({
			status: 404,
			body: { message: 'Image not found', forwarded: false }
		});
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

	// The Blob is built from the buffered view, not from its backing ArrayBuffer.
	// Reading the buffer only matches the payload while bufferStream allocates an
	// exact-size array; a view into a larger allocation would send trailing zero
	// bytes FuzzySearch would then be matching against.
	it('forwards a stored image byte for byte', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);

		// The payload as a view into a larger, 0xff-padded allocation. Against the
		// exact-size array bufferStream really returns, reading the view and
		// reading its buffer give the same bytes, so this test passed either way;
		// with the padding in place a Blob built from `.buffer` sends the padding
		// too and the assertion below fails.
		bufferStreamSpy.mockImplementationOnce(async (...args) => {
			const real = await realBufferStream.fn!(...args);
			const padded = new Uint8Array(real.byteLength + 8).fill(0xff);
			padded.set(real, 4);
			return padded.subarray(4, 4 + real.byteLength);
		});

		await POST(jsonEvent(platform, { imageId: 1 }));

		const sent = new Uint8Array(await (searchImage.mock.calls[0][0] as Blob).arrayBuffer());
		expect(Array.from(sent)).toEqual(Array.from(IMAGE_BYTES));
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
		expect(await gone.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });

		// A link-local host stored in the row is refused before any fetch.
		const internal = imageFetch();
		const blocked = await POST(jsonEvent(platform, { imageId: 2 }, internal.fn));
		expect(blocked.status).toBe(502);
		expect(internal.calls).toEqual([]);

		expect(searchImage).not.toHaveBeenCalled();
	});

	// Every other await before the search is guarded. This one was left to the
	// callee's own discipline, and the callee has one thread it cannot catch: a
	// `cancel()` that throws synchronously never gets its `.catch` attached. A
	// throw here answers 500 with no `forwarded` field for bytes that never left
	// the worker, and the edit page then shows the private-image notice.
	it('answers a stored-image read that throws with a dated failure, not a 500', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		proxyStoredImageSpy.mockRejectedValueOnce(new Error('cancel threw'));

		const res = await POST(jsonEvent(platform, { imageId: 1 }));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The same rule as the multipart guards: a database that throws must not
	// become a 500 whose body the client cannot date.
	it('answers a select that throws with a dated failure, not a 500', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string) => {
			if (/from "images"/i.test(sql)) throw new Error('D1_ERROR: database is locked');
			return realPrepare(sql);
		};
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The proxy's timeout bounds the wait for HEADERS only. A host that answers
	// and then trickles nothing leaves the panel spinning until the platform
	// kills the request, so the buffering carries a deadline of its own.
	// Explicit timeout: the body advances a simulated 20 s deadline in two
	// steps, and the awaits between them have run past vitest's 5 s default on a
	// loaded machine.
	it('gives up on a stored body that stops arriving', { timeout: 15_000 }, async () => {
		vi.useFakeTimers();
		try {
			const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			sqlite.exec(
				`INSERT INTO images (id, title, slug, image_url, created_at)
				 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
			);
			let cancelled = false;
			// Headers, then nothing: the stream never enqueues and never closes.
			const trickle = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				}
			});
			const stalling = imageFetch(
				new Response(trickle, { status: 200, headers: { 'content-type': 'image/png' } })
			);

			// Mirrors the endpoint's BODY_BUFFER_TIMEOUT_MS. Held here rather than
			// imported (a +server.ts exports handlers), and pinned by advancing to
			// just short of it first: a shorter deadline settles early, a longer one
			// leaves the second advance with nothing to fire.
			const deadlineMs = 20_000;
			let settled = false;
			const pending = Promise.resolve(
				POST(jsonEvent(platform, { imageId: 1 }, stalling.fn))
			).then((r) => {
				settled = true;
				return r;
			});
			await vi.advanceTimersByTimeAsync(deadlineMs - 1_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_001);
			const res = await pending;

			expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
			// The bytes are not left flowing into an isolate nobody is reading.
			expect(cancelled).toBe(true);
			expect(searchImage).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// An upstream that RESETS mid-body rather than stalling. The deadline stream
	// errors, and an errored stream never calls cancel — the other place the timer
	// is cleared — so an unguarded version leaves a 20 s timer armed on a request
	// that has already been answered, firing reader.cancel() into a request
	// context workerd has closed.
	it('clears the body deadline when the stored read rejects', { timeout: 15_000 }, async () => {
		vi.useFakeTimers();
		try {
			const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			sqlite.exec(
				`INSERT INTO images (id, title, slug, image_url, created_at)
				 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
			);
			const resetting = new ReadableStream<Uint8Array>({
				pull() {
					throw new Error('connection reset by peer');
				}
			});
			const failing = imageFetch(
				new Response(resetting, { status: 200, headers: { 'content-type': 'image/png' } })
			);

			const res = await POST(jsonEvent(platform, { imageId: 1 }, failing.fn));

			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
			// The point of the test: nothing is still armed once the answer is out.
			expect(vi.getTimerCount()).toBe(0);
			expect(searchImage).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
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
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
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
		expect(await res.json()).toEqual({ enabled: true, error: 'too_large', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('refuses a stored response whose bytes are not an image at all', async () => {
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

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The proxy hands anything off its allowlist back as application/octet-stream,
	// so a stored PNG whose origin serves it untyped used to be refused as an
	// outage. The bytes are what the gate reads, and the part carries the type
	// they sniff to.
	it('sends a stored image the upstream typed octet-stream, under its sniffed type', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		const untyped = new Response(IMAGE_BYTES, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' }
		});

		await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(untyped).fn));

		expect(searchImage).toHaveBeenCalled();
		expect((searchImage.mock.calls[0][0] as Blob).type).toBe('image/png');
	});

	// SVG is an image type, so an `image/*` check would have sent it on. It is
	// not one of the raster types storage accepts, and its bytes sniff to
	// nothing, so nothing is uploaded to FuzzySearch.
	it('refuses a stored image that is an svg', async () => {
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

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The upstream Content-Type is its own word for the bytes, so an origin (or
	// a stored URL pointed somewhere else) can label a PDF image/png. The bytes
	// get the same sniff an uploaded file gets, and nothing is sent.
	it('refuses a stored image whose bytes are not the type the upstream declares', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		const spoofed = new Response('%PDF-1.7 not a png', {
			status: 200,
			headers: { 'content-type': 'image/png' }
		});

		const res = await POST(jsonEvent(platform, { imageId: 1 }, imageFetch(spoofed).fn));

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ enabled: true, error: 'invalid_image', forwarded: false });
		expect(searchImage).not.toHaveBeenCalled();
	});

	// The other side of the sniff: real PNG bytes behind a valid header still go
	// out, so the check above can't be satisfied by refusing everything.
	it('sends a stored image whose bytes match the declared type', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);

		const res = await POST(jsonEvent(platform, { imageId: 1 }));

		expect(res.status).toBe(200);
		expect((searchImage.mock.calls[0][0] as Blob).type).toBe('image/png');
	});
});

// Art that came from a commission entry never goes to FuzzySearch (SONA-236).
// The edit page hides the button for it; this is the refusal behind that, for
// a page loaded before the piece was linked or a request made by hand.
describe('artist-lookup — art from a commission entry', () => {
	function seedStored(sqlite: { exec(sql: string): void }) {
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01'),
			        (2, 'Other', 'other', 'https://cdn.example.com/other.png', '2026-01-01');`
		);
	}

	it('refuses a piece an entry links to, before its bytes are fetched or sent', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		seedStored(sqlite);
		sqlite.exec(`INSERT INTO commissions (image_id) VALUES (1);`);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ enabled: true, error: 'from_commission', forwarded: false });
		// Not even the stored copy was read, so nothing existed to hand over.
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	// Checked before the key: a page loaded while a key was saved, on a piece
	// linked since, would otherwise say "no key" and send the owner to Settings
	// for a lookup that wouldn't run with one either.
	it('says from_commission rather than no key, with no key saved', async () => {
		const { sqlite, platform } = makeEnv();
		seedStored(sqlite);
		sqlite.exec(`INSERT INTO commissions (image_id) VALUES (1);`);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ enabled: true, error: 'from_commission', forwarded: false });
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('still answers enabled:false with no key for a piece no entry links to', async () => {
		const { sqlite, platform } = makeEnv();
		seedStored(sqlite);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enabled: false, forwarded: false });
		expect(fetcher.calls).toEqual([]);
	});

	// The entry check reads the row before the key; only its refusal may answer
	// there. A missing row or a bad id still gets the no-key answer.
	it.each([
		['a piece that is gone', 404],
		['an id that is not a number', 'x']
	])('still answers enabled:false with no key for %s', async (_label, imageId) => {
		const { sqlite, platform } = makeEnv();
		seedStored(sqlite);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId }, fetcher.fn));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enabled: false, forwarded: false });
		expect(fetcher.calls).toEqual([]);
	});

	it('still looks up a piece when the entry links a different one', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		seedStored(sqlite);
		// And an entry with no piece yet: image 1 has no parent, and that null must
		// not match the entry's null image_id.
		sqlite.exec(`INSERT INTO commissions (image_id) VALUES (2), (NULL);`);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(200);
		expect(fetcher.calls).toEqual(['https://cdn.example.com/stored.png']);
		expect(searchImage).toHaveBeenCalledTimes(1);
	});

	it('refuses a variant whose parent an entry links to, before anything is fetched', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		seedStored(sqlite);
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, parent_image_id, created_at)
			 VALUES (3, 'Alt', 'alt', 'https://cdn.example.com/alt.png', 1, '2026-01-01');
			 INSERT INTO commissions (image_id) VALUES (1);`
		);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 3 }, fetcher.fn));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ enabled: true, error: 'from_commission', forwarded: false });
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('still looks up a variant whose parent no entry links to', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		seedStored(sqlite);
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, parent_image_id, created_at)
			 VALUES (3, 'Alt', 'alt', 'https://cdn.example.com/alt.png', 1, '2026-01-01');
			 INSERT INTO commissions (image_id) VALUES (2);`
		);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 3 }, fetcher.fn));

		expect(res.status).toBe(200);
		expect(fetcher.calls).toEqual(['https://cdn.example.com/alt.png']);
		expect(searchImage).toHaveBeenCalledTimes(1);
	});

	it('answers a failed entry check as not sent, rather than looking the piece up anyway', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		seedStored(sqlite);
		sqlite.exec(`DROP TABLE commissions;`);
		const fetcher = imageFetch();

		const res = await POST(jsonEvent(platform, { imageId: 1 }, fetcher.fn));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: false });
		expect(fetcher.calls).toEqual([]);
		expect(searchImage).not.toHaveBeenCalled();
	});
});

describe('artist-lookup — after the search', () => {
	// These reads run AFTER the bytes reached FuzzySearch, so the failure is
	// dated `forwarded: true` — the private-image notice on the edit page is then
	// honest about a lookup that did leave the app. A typed answer rather than a
	// throw because only a typed body can carry `forwarded`.
	//
	// NOT degraded to the matches with an empty localArtists: the panel reads
	// that as "no local artist has this handle" and offers to add one that
	// already exists, which is a duplicate artist row to merge by hand.
	it('answers a post-search read that throws with a forwarded failure', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string) => {
			if (/from "artists"/i.test(sql)) throw new Error('D1_ERROR: database is locked');
			return realPrepare(sql);
		};

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: true });
		expect(searchImage).toHaveBeenCalled();
	});

	// The call itself is guarded too. searchImage catches its own failures, so a
	// throw out of it means something unforeseen, and the bytes are gone either
	// way — an unguarded throw would answer 500 with no `forwarded` field for a
	// file that already left the worker, and the edit page's private-image notice
	// reads that field.
	it('answers a search that throws with a forwarded failure, not a 500', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockRejectedValue(new Error('connection reset'));

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: true });
		expect(searchImage).toHaveBeenCalled();
	});

	// A rejection that is not an Error has no `.message` to log, and a fetch
	// failure can throw a value holding the request that carried the key
	// upstream. Logged whole, that key lands in the worker's log.
	it('keeps a non-Error thrown value out of the log', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		searchImage.mockRejectedValue({
			request: { headers: { 'X-Api-Key': 'fuzzysearch-key-in-the-request' } }
		});

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ enabled: true, error: 'unavailable', forwarded: true });
		const logged = warn.mock.calls
			.flat()
			.map((value) => JSON.stringify(value))
			.join(' ');
		expect(logged).not.toContain('fuzzysearch-key-in-the-request');
		expect(logged).not.toContain('X-Api-Key');
		warn.mockRestore();
	});

	// Only the reads are guarded. A fault in the mapping below them is a bug in
	// this file, not an upstream outage, and reporting it as one hides it: the
	// operator is told FuzzySearch is down and nothing is logged anywhere. A
	// match with no handles array is the cheapest way to make that code throw.
	//
	// That shape is synthetic: normalizeMatch in fuzzysearch.ts guards handles
	// with Array.isArray, so a real client response can never reach the mapping
	// without one. This test says what happens if the mapping throws, NOT that
	// the guard is redundant — do not relax it on the strength of this test.
	it('does not report a fault in its own mapping as an upstream outage', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({
			ok: true,
			matches: [{ ...FA_EXACT, handles: undefined as unknown as string[] }]
		});

		await expect(POST(multipartEvent(platform, pngFile()))).rejects.toThrow(TypeError);
	});
});

describe('artist-lookup — failure mapping and the refused marker', () => {
	// 424, not 401: the admin gate answers an expired session with its own 401
	// and a plain-text body, so a 401 here would be indistinguishable from a
	// logged-out admin and the caller's res.json() would throw. And not a 5xx,
	// which hooks.server.ts counts into the operator's error rollup — see the
	// status-floor test below.
	it('records the refusal on a 424 and clears it on the next success', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });

		const refused = await POST(multipartEvent(platform, pngFile()));
		expect(refused.status).toBe(424);
		expect(await refused.json()).toEqual({ enabled: true, error: 'key_refused', forwarded: true });
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

	// The marker is a convenience for the settings card, not the answer. A D1
	// write that fails must not turn the typed 424 into a 500 whose body the
	// caller's res.json() can't read, nor cost a successful lookup its matches.
	it('still answers key_refused when the marker cannot be written', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });
		setRawSettingSpy.mockRejectedValueOnce(new Error('D1_ERROR: no such table'));

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(424);
		expect(await res.json()).toEqual({ enabled: true, error: 'key_refused', forwarded: true });
	});

	it('still answers the matches when the marker cannot be cleared', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '2026-09-01T00:00:00.000Z|env');
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		setRawSettingSpy.mockRejectedValueOnce(new Error('D1_ERROR: no such table'));

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		expect((await res.json()).matches).toHaveLength(1);
	});

	// Same rule as the search catch above: a rejected value that is not an Error
	// can be an object holding the request that carried the key, so both marker
	// catches log a constant in that arm rather than the value itself.
	it('keeps a non-Error marker failure out of the log, writing and clearing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const thrown = { request: { headers: { 'X-Api-Key': 'fuzzysearch-key-in-the-request' } } };

		const refused = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });
		setRawSettingSpy.mockRejectedValueOnce(thrown);
		expect((await POST(multipartEvent(refused.platform, pngFile()))).status).toBe(424);

		const cleared = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(
			cleared.db,
			FUZZYSEARCH_KEY_REFUSED_SETTING,
			'2026-09-01T00:00:00.000Z|env'
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		setRawSettingSpy.mockRejectedValueOnce(thrown);
		expect((await POST(multipartEvent(cleared.platform, pngFile()))).status).toBe(200);

		const logged = warn.mock.calls
			.flat()
			.map((value) => JSON.stringify(value))
			.join(' ');
		expect(logged).toContain('marker not written');
		expect(logged).toContain('marker not cleared');
		expect(logged).not.toContain('fuzzysearch-key-in-the-request');
		expect(logged).not.toContain('X-Api-Key');
		warn.mockRestore();
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
			expect(await res.json()).toEqual({ enabled: true, error: reason, forwarded: true });
		}
	});

	// hooks.server.ts counts EVERY response with status >= 500 into the
	// operator's error rollup, so a misconfigured key must not answer 5xx: it
	// would fill the observability panel with server errors on every click.
	it('keeps a refused key out of the error rollup', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBeLessThan(500);
		// Still distinguishable from the admin gate's own 401 and 400.
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(400);
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
			// No thumbnail column on the seeded row, so the full image stands in.
			thumbnailUrl: 'https://cdn/1.png',
			artistName: null,
			uploadedAt: '2026-01-01',
			// The seeded row has no size columns, so the meta line drops that part.
			width: null,
			height: null,
			isVariant: false,
			parentImageId: null,
			variantCount: 1
		});
	});

	// The warning shows the operator the piece itself, so the row carries what it
	// takes to recognize one: its thumbnail, who drew it, and when it landed.
	it('carries the clashing piece thumbnail, artist, upload date and size', async () => {
		const env = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		env.sqlite.exec(
			`INSERT INTO artists (id, name, created_at) VALUES (7, 'Kuttoya', '2026-01-01');
			 INSERT INTO images (id, title, slug, image_url, thumbnail_url, source_post_url,
				 artist_id, parent_image_id, width, height, created_at)
			 VALUES (1, 'Sparky at the beach', 'beach', 'https://cdn/1.png', 'https://cdn/1-thumb.png',
				 'https://www.furaffinity.net/view/12345/', 7, NULL, 1600, 900, '2026-02-09');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(env.platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };

		expect(body.sourceClash).toMatchObject({
			imageId: 1,
			thumbnailUrl: 'https://cdn/1-thumb.png',
			artistName: 'Kuttoya',
			uploadedAt: '2026-02-09',
			width: 1600,
			height: 900
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
			thumbnailUrl: 'https://cdn/10.png',
			artistName: null,
			uploadedAt: '2026-01-01',
			width: null,
			height: null,
			isVariant: true,
			parentImageId: 10,
			// The variant is the row that carries the URL, and the parent named
			// above is not in the set — so it is one variant, not none.
			variantCount: 1
		});
	});

	// Same shape, more than one variant: the count is what the set holds, not the
	// set minus a root row that never matched.
	it('counts every variant when the parent carries no source URL', async () => {
		const env = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		env.sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, source_post_url, parent_image_id, created_at)
			 VALUES (10, 'Sparky at the beach', 'beach', 'https://cdn/10.png', NULL, NULL, '2026-01-01'),
				(11, 'Beach variant', 'beach-v', 'https://cdn/11.png',
				 'https://www.furaffinity.net/view/12345/', 10, '2026-01-02'),
				(12, 'Beach variant 2', 'beach-v2', 'https://cdn/12.png',
				 'https://www.furaffinity.net/view/12345/', 10, '2026-01-03');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const res = await POST(multipartEvent(env.platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };

		expect(body.sourceClash).toMatchObject({ imageId: 10, variantCount: 2 });
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

	// The saved link carries Weasyl's title slug while this client builds the bare
	// submission URL. One post either way, so the warning still has to fire.
	it('reports a clash when the stored Weasyl URL carries a title slug', async () => {
		const env = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		env.sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, source_post_url, parent_image_id, created_at)
			 VALUES (20, 'Sparky at the beach', 'beach', 'https://cdn/20.png',
				 'https://www.weasyl.com/submission/5150/sparky-at-the-beach', NULL, '2026-01-01');`
		);
		searchImage.mockResolvedValue({
			ok: true,
			matches: [
				{
					...FA_EXACT,
					site: 'Weasyl' as const,
					siteId: '5150',
					postUrl: 'https://www.weasyl.com/submission/5150'
				}
			]
		});

		const res = await POST(multipartEvent(env.platform, pngFile()));
		const body = (await res.json()) as { sourceClash: Record<string, unknown> };
		expect(body.sourceClash).toMatchObject({ imageId: 20, title: 'Sparky at the beach' });
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

// SONA-243: the same click searches Skyseek for Bluesky posts of the picture.
// FuzzySearch keeps deciding the answer's status; Skyseek only ever adds rows.
describe('artist-lookup — Bluesky posts from Skyseek', () => {
	// Made-up accounts in the real DID shape.
	const ARTIST_DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
	const REPOSTER_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
	const OPERATOR_DID = 'did:plc:cccccccccccccccccccccccc';

	/** A Skyseek match with no distance unless one is given: the unbanded lead. */
	function post(
		did: string,
		rkey: string,
		postedAt: string | null = null,
		distance: number | null = null
	): SkyseekMatch {
		return { did, rkey, distance, postedAt, postUrl: blueskyPostUrl(did, rkey) };
	}

	type Body = {
		enabled: boolean;
		matches: Array<{
			site: string;
			siteId: string;
			handles: string[];
			band: string | null;
			distance: number | null;
			rating: string | null;
			postUrl: string;
		}>;
		localArtists: Array<{ matchIndex: number; artists: Array<{ id: number; name: string }> }>;
		nameMatches: Array<{ matchIndex: number; artists: Array<{ id: number; name: string }> }>;
		sourceClash: { imageId: number; title: string } | null;
		blueskySearched: boolean;
	};

	it('puts Bluesky posts with no distance after every FuzzySearch match', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (name, bluesky_url, created_at)
			 VALUES ('Sky Artist', 'https://bsky.app/profile/Artist.Example', '2026-01-01');`
		);
		// A FuzzySearch row with no distance sorts last among its own; the Bluesky
		// rows still come after it.
		const twitterUnknown = {
			...FA_EXACT,
			site: 'Twitter' as const,
			siteId: '99',
			distance: null,
			band: null,
			postUrl: 'https://twitter.com/kuttoya/status/99'
		};
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT, twitterUnknown] });
		searchSkyseek.mockResolvedValue({
			ok: true,
			matches: [
				post(ARTIST_DID, 'first', '2026-10-03T02:15:28.000Z'),
				post(REPOSTER_DID, 'later', '2026-10-04T02:15:28.000Z')
			]
		});
		resolveBlueskyHandles.mockResolvedValue(new Map([[ARTIST_DID, 'artist.example']]));
		const file = pngFile();

		const res = await POST(multipartEvent(platform, file));
		const body = (await res.json()) as Body;

		expect(res.status).toBe(200);
		expect(body.blueskySearched).toBe(true);
		expect(body.matches.map((x) => `${x.site}:${x.siteId}`)).toEqual([
			'FurAffinity:12345',
			'Twitter:99',
			`Bluesky:${ARTIST_DID}/first`,
			`Bluesky:${REPOSTER_DID}/later`
		]);
		expect(body.matches[2]).toMatchObject({
			handles: ['artist.example'],
			distance: null,
			band: null,
			rating: null,
			postUrl: blueskyPostUrl(ARTIST_DID, 'first')
		});
		// The account the AppView named nobody for stays, linked by its DID.
		expect(body.matches[3]).toMatchObject({
			handles: [],
			postUrl: blueskyPostUrl(REPOSTER_DID, 'later')
		});
		// The artist's stored Bluesky link is what ties the row to them.
		expect(body.localArtists).toEqual([
			{ matchIndex: 2, artists: [{ id: 1, name: 'Sky Artist', pieces: 0 }] }
		]);
		// Both services got the same file, and the AppView only the DIDs.
		expect(searchSkyseek.mock.calls[0][0]).toBe(searchImage.mock.calls[0][0]);
		expect(resolveBlueskyHandles.mock.calls[0][0]).toEqual([ARTIST_DID, REPOSTER_DID]);
	});

	it('starts the two searches side by side, not one after the other', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		let releaseFuzzy: (value: LookupResult) => void = () => {};
		let releaseSkyseek: (value: SkyseekResult) => void = () => {};
		searchImage.mockReturnValue(new Promise<LookupResult>((resolve) => (releaseFuzzy = resolve)));
		searchSkyseek.mockReturnValue(
			new Promise<SkyseekResult>((resolve) => (releaseSkyseek = resolve))
		);

		const pending = POST(multipartEvent(platform, pngFile()));
		// Neither has answered, and both have been asked: an endpoint that waited
		// on either one before asking the other would stall here.
		await vi.waitFor(() => {
			expect(searchImage).toHaveBeenCalledTimes(1);
			expect(searchSkyseek).toHaveBeenCalledTimes(1);
		});

		releaseSkyseek({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });
		releaseFuzzy({ ok: true, matches: [FA_EXACT] });
		const body = (await (await pending).json()) as Body;
		expect(body.blueskySearched).toBe(true);
		expect(body.matches.map((x) => x.site)).toEqual(['FurAffinity', 'Bluesky']);
	});

	it('leaves a Bluesky post with no distance as a lead: no prefill, so no source clash', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		// A piece already credited to that very post. Only a confident match is
		// the prefill, and only the prefill is checked for a clash.
		sqlite.exec(
			`INSERT INTO images (title, slug, image_url, source_post_url, created_at)
			 VALUES ('Held', 'held', 'https://cdn.example.com/held.png',
			         '${blueskyPostUrl(ARTIST_DID, 'first')}', '2026-01-01');`
		);
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches.map((x) => x.site)).toEqual(['Bluesky']);
		expect(body.matches[0].band).toBeNull();
		expect(body.sourceClash).toBeNull();
	});

	// Round 2: Skyseek reports a distance on FuzzySearch's scale, so an exact or
	// strong Bluesky post is a confident match like any other.
	it('bands a Bluesky post by its distance and ties it to a local artist', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (name, bluesky_url, created_at)
			 VALUES ('Sky Artist', 'https://bsky.app/profile/Artist.Example', '2026-01-01'),
			        ('artist.example', NULL, '2026-01-01');`
		);
		searchSkyseek.mockResolvedValue({
			ok: true,
			matches: [post(ARTIST_DID, 'first', '2026-10-03T02:15:28.000Z', 0)]
		});
		resolveBlueskyHandles.mockResolvedValue(new Map([[ARTIST_DID, 'artist.example']]));

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches).toEqual([
			{
				site: 'Bluesky',
				siteId: `${ARTIST_DID}/first`,
				handles: ['artist.example'],
				distance: 0,
				band: 'exact',
				postedAt: '2026-10-03T02:15:28.000Z',
				rating: null,
				postUrl: blueskyPostUrl(ARTIST_DID, 'first')
			}
		]);
		expect(body.localArtists).toEqual([
			{ matchIndex: 0, artists: [{ id: 1, name: 'Sky Artist', pieces: 0 }] }
		]);
		// The weaker, by-name hit is reported the way it is for any other site.
		expect(body.nameMatches).toEqual([
			{ matchIndex: 0, artists: [{ id: 2, name: 'artist.example', pieces: 0 }] }
		]);
	});

	it('orders the combined list by distance, and lets FuzzySearch win a tie', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		// One local artist per site, so the index each hit carries can be checked
		// against the row it must point at AFTER the two lists are merged.
		sqlite.exec(
			`INSERT INTO artists (name, bluesky_url, furaffinity_url, twitter_url, created_at)
			 VALUES ('Sky Artist', 'https://bsky.app/profile/artist.example', NULL, NULL, '2026-01-01'),
			        ('Fur Artist', NULL, 'https://www.furaffinity.net/user/kuttoya/', NULL, '2026-01-01'),
			        ('Bird Artist', NULL, NULL, 'https://twitter.com/birdartist', '2026-01-01');`
		);
		const faStrong = { ...FA_EXACT, distance: 2, band: 'strong' as const };
		const twitterPossible = {
			...FA_EXACT,
			site: 'Twitter' as const,
			siteId: '99',
			handles: ['birdartist'],
			distance: 5,
			band: 'possible' as const,
			postUrl: 'https://twitter.com/birdartist/status/99'
		};
		const e621Unknown = {
			...FA_EXACT,
			site: 'e621' as const,
			siteId: '7',
			handles: [],
			distance: null,
			band: null,
			postUrl: 'https://e621.net/posts/7'
		};
		searchImage.mockResolvedValue({ ok: true, matches: [faStrong, twitterPossible, e621Unknown] });
		searchSkyseek.mockResolvedValue({
			ok: true,
			matches: [
				post(ARTIST_DID, 'exact', '2026-10-03T02:15:28.000Z', 0),
				post(REPOSTER_DID, 'tied-earlier', '2026-10-04T02:15:28.000Z', 2),
				post(OPERATOR_DID, 'tied-later', '2026-10-05T02:15:28.000Z', 2),
				post(REPOSTER_DID, 'loose', null, 5),
				post(REPOSTER_DID, 'unknown')
			]
		});
		resolveBlueskyHandles.mockResolvedValue(new Map([[ARTIST_DID, 'artist.example']]));

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches.map((x) => `${x.site}:${x.siteId.split('/').pop()}:${x.distance}`)).toEqual([
			// Closer than anything FuzzySearch found, so it leads.
			'Bluesky:exact:0',
			// A tie at 2: the FuzzySearch row first, then Bluesky earliest first.
			'FurAffinity:12345:2',
			'Bluesky:tied-earlier:2',
			'Bluesky:tied-later:2',
			'Twitter:99:5',
			'Bluesky:loose:5',
			'e621:7:null',
			'Bluesky:unknown:null'
		]);
		// Each hit addresses its row in the merged order, not in either search's own.
		const named = body.localArtists.map((hit) => [
			body.matches[hit.matchIndex].site,
			hit.artists.map((a) => a.name)
		]);
		expect(named).toEqual([
			['Bluesky', ['Sky Artist']],
			['FurAffinity', ['Fur Artist']],
			['Twitter', ['Bird Artist']]
		]);
		expect(body.localArtists.map((hit) => hit.matchIndex)).toEqual([0, 1, 4]);
	});

	it('fills from the FuzzySearch match when a Bluesky post is exactly as close', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		// The Bluesky post is already a piece's source; the FurAffinity one is not.
		// The clash follows the prefill match, so there is none.
		sqlite.exec(
			`INSERT INTO images (title, slug, image_url, source_post_url, created_at)
			 VALUES ('Held', 'held', 'https://cdn.example.com/held.png',
			         '${blueskyPostUrl(ARTIST_DID, 'first')}', '2026-01-01');`
		);
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches.map((x) => x.site)).toEqual(['FurAffinity', 'Bluesky']);
		expect(body.sourceClash).toBeNull();
	});

	// A closer Bluesky row is often a repost, so the confident FuzzySearch row
	// stays the prefill, and the clash check follows it, not the Bluesky post.
	it('checks the clash on a confident FuzzySearch match over a closer Bluesky post', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (title, slug, image_url, source_post_url, created_at)
			 VALUES ('Reposted', 'reposted', 'https://cdn.example.com/reposted.png',
			         '${blueskyPostUrl(REPOSTER_DID, 'closer')}', '2026-01-01'),
			        ('Held', 'held', 'https://cdn.example.com/held.png',
			         '${FA_EXACT.postUrl}', '2026-01-02');`
		);
		searchImage.mockResolvedValue({
			ok: true,
			matches: [{ ...FA_EXACT, distance: 1, band: 'strong' as const }]
		});
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(REPOSTER_DID, 'closer', null, 0)] });

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches.map((x) => x.site)).toEqual(['Bluesky', 'FurAffinity']);
		expect(body.sourceClash).toMatchObject({ title: 'Held' });
	});

	describe('a source clash on a Bluesky post', () => {
		const HANDLE_URL = 'https://bsky.app/profile/artist.example/post/3mwwswjznmk25';
		const DID_URL = blueskyPostUrl(ARTIST_DID, '3mwwswjznmk25');

		async function lookupWith(storedUrl: string, handle: string | null, distance: number | null = 0) {
			const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			sqlite
				.prepare(
					`INSERT INTO images (title, slug, image_url, source_post_url, created_at)
					 VALUES ('Held', 'held', 'https://cdn.example.com/held.png', ?, '2026-01-01')`
				)
				.run(storedUrl);
			searchSkyseek.mockResolvedValue({
				ok: true,
				matches: [post(ARTIST_DID, '3mwwswjznmk25', null, distance)]
			});
			resolveBlueskyHandles.mockResolvedValue(
				new Map(handle ? [[ARTIST_DID, handle]] : [])
			);
			return (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;
		}

		it.each([
			['the DID link this endpoint builds', DID_URL],
			['the same link with a trailing slash and a query', `${DID_URL}/?ref=share`],
			['the DID link with its colons percent-encoded', DID_URL.replace(/did:plc:/, 'did%3Aplc%3A')],
			['a view under the post', `${DID_URL}/liked-by`],
			['the host in another letter case', DID_URL.replace('bsky.app', 'BSKY.App')],
			['the handle link bsky.app shows', HANDLE_URL],
			['the handle link in another letter case', HANDLE_URL.replace('artist.example', 'Artist.Example')],
			['the handle link with a view under it', `${HANDLE_URL}/quotes`]
		])('reports a piece saved under %s', async (_name, stored) => {
			const body = await lookupWith(stored, 'artist.example');
			expect(body.sourceClash).toMatchObject({ imageId: 1, title: 'Held' });
		});

		it.each([
			['another post by the same account', HANDLE_URL.replace('3mwwswjznmk25', '3mwwswjznmk26')],
			['the same record key under another account', HANDLE_URL.replace('artist.example', 'other.example')],
			// Record keys are case-sensitive: this is a different post.
			['a record key in another letter case', DID_URL.replace('3mwwswjznmk25', '3MWWSWJZNMK25')],
			['the account profile, with no post', 'https://bsky.app/profile/artist.example']
		])('does not report a piece saved under %s', async (_name, stored) => {
			const body = await lookupWith(stored, 'artist.example');
			expect(body.sourceClash).toBeNull();
		});

		// The accepted miss: with no handle resolved nothing says whose handle the
		// stored link names. The DID spelling is still caught.
		it('misses the handle spelling when no handle resolved, and still catches the DID one', async () => {
			expect((await lookupWith(HANDLE_URL, null)).sourceClash).toBeNull();
			expect((await lookupWith(DID_URL, null)).sourceClash).toMatchObject({ imageId: 1 });
		});

		it('reports nothing for a Bluesky post too loose to fill from', async () => {
			expect((await lookupWith(DID_URL, 'artist.example', 4)).sourceClash).toBeNull();
		});
	});

	it('identifies this site to Skyseek by its hostname and to the AppView without it', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });
		// The real handle lookup, so the header read below is the one it sends.
		resolveBlueskyHandles.mockImplementation(realResolveBlueskyHandles.fn!);
		const appViewHeaders: Record<string, string>[] = [];
		const fetchFn = (async (url: string, init?: RequestInit) => {
			if (String(url).startsWith('https://public.api.bsky.app/')) {
				appViewHeaders.push(init?.headers as Record<string, string>);
				return new Response(JSON.stringify({ profiles: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return imageFetch().fn(url);
		}) as unknown as typeof fetch;
		const form = new FormData();
		form.append('file', pngFile());
		const request = new Request('https://Gallery.Example/api/admin/artist-lookup', {
			method: 'POST',
			body: form
		});

		await POST({ request, platform, fetch: fetchFn } as never);

		expect(searchSkyseek.mock.calls[0][2]).toBe('Sona/1.0 (+https://sona.fast; gallery.example)');
		// Skyseek's owner asked for the hostname; Bluesky did not.
		expect(appViewHeaders).toHaveLength(1);
		expect(appViewHeaders[0]['user-agent']).toBe('Sona/1.0 (+https://sona.fast)');
		// FuzzySearch's call is as it was: the key, and no say in the header.
		expect(searchImage.mock.calls[0]).toHaveLength(3);
	});

	it.each([
		['is rate limited', { ok: false, reason: 'rate_limited' }],
		['finds the file too large', { ok: false, reason: 'too_large' }],
		['cannot read the file', { ok: false, reason: 'invalid_image' }],
		['does not answer', { ok: false, reason: 'unavailable' }]
	] as Array<[string, SkyseekResult]>)(
		'still answers the FuzzySearch matches when Skyseek %s',
		async (_name, failed) => {
			const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
			searchSkyseek.mockResolvedValue(failed);

			const res = await POST(multipartEvent(platform, pngFile()));
			const body = (await res.json()) as Body & { error?: string; forwarded?: boolean };
			warn.mockRestore();

			expect(res.status).toBe(200);
			expect(body.matches).toEqual([FA_EXACT]);
			// Not "no Bluesky posts": nobody looked, and the panel must not say so.
			expect(body.blueskySearched).toBe(false);
			// And why, so the panel offers Try again only where a second send can
			// come back different: a refused file is refused again.
			expect((body as Body & { skyseekFailure?: unknown }).skyseekFailure).toBe(
				failed.ok ? null : failed.reason
			);
			expect(body.error).toBeUndefined();
			expect(resolveBlueskyHandles).not.toHaveBeenCalled();
		}
	);

	it('still answers when the Skyseek call or the handle lookup throws', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });
		searchSkyseek.mockRejectedValue(new Error('connection reset'));

		const thrown = await POST(multipartEvent(platform, pngFile()));
		expect(thrown.status).toBe(200);
		const thrownBody = (await thrown.json()) as Body & { skyseekFailure?: unknown };
		expect(thrownBody.blueskySearched).toBe(false);
		expect(thrownBody.skyseekFailure).toBe('unavailable');

		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });
		resolveBlueskyHandles.mockRejectedValue(new Error('connection reset'));
		const unresolved = await POST(multipartEvent(platform, pngFile()));
		warn.mockRestore();

		expect(unresolved.status).toBe(200);
		const unresolvedBody = (await unresolved.json()) as Body & { skyseekFailure?: unknown };
		expect(unresolvedBody.matches).toEqual([FA_EXACT]);
		// A handle lookup that threw is answered as it always was: Bluesky not
		// searched, and nothing that says Skyseek refused the file.
		expect(unresolvedBody.blueskySearched).toBe(false);
		expect(unresolvedBody.skyseekFailure).toBe('unavailable');
	});

	it('says Bluesky was searched when it was and nothing matched anywhere', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.matches).toEqual([]);
		expect(body.blueskySearched).toBe(true);
		// Nobody to ask the AppView about.
		expect(resolveBlueskyHandles.mock.calls.every(([dids]) => dids.length === 0)).toBe(true);
	});

	const FUZZY_FAILURES = [
		['key_refused', 424],
		['rate_limited', 429],
		['too_large', 413],
		['invalid_image', 422],
		['unavailable', 502]
	] as const;

	// One service down is not a failed lookup. The rows of the one that answered
	// are the answer, and `fuzzysearchFailure` says why the others are missing.
	it.each(FUZZY_FAILURES)(
		'answers the Bluesky posts with the reason when FuzzySearch fails with %s',
		async (reason) => {
			const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			searchImage.mockResolvedValue({ ok: false, reason });
			searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });
			resolveBlueskyHandles.mockResolvedValue(new Map([[ARTIST_DID, 'artist.example']]));

			const res = await POST(multipartEvent(platform, pngFile()));

			expect(res.status).toBe(200);
			const body = (await res.json()) as Body & { fuzzysearchFailure: string | null; error?: string };
			expect(body.fuzzysearchFailure).toBe(reason);
			expect(body.error).toBeUndefined();
			expect(body.blueskySearched).toBe(true);
			expect(body.matches.map((x) => [x.site, x.handles, x.band])).toEqual([
				['Bluesky', ['artist.example'], 'exact']
			]);
		}
	);

	it('says FuzzySearch answered on an ordinary result, with or without Bluesky posts', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: true, matches: [FA_EXACT] });

		const alone = (await (await POST(multipartEvent(platform, pngFile()))).json()) as {
			fuzzysearchFailure: unknown;
			skyseekFailure: unknown;
		};
		expect(alone.fuzzysearchFailure).toBeNull();
		expect(alone.skyseekFailure).toBeNull();

		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });
		const both = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body & {
			fuzzysearchFailure: unknown;
			skyseekFailure: unknown;
		};
		expect(both.fuzzysearchFailure).toBeNull();
		expect(both.skyseekFailure).toBeNull();
		expect(both.matches.map((x) => x.site)).toEqual(['FurAffinity', 'Bluesky']);
	});

	// The rows of a partial answer get every read a whole one gets: the local
	// artist behind the poster, the by-name prompt, and the duplicate-source
	// check, which here runs on the Bluesky post because it is the prefill.
	it('still matches local artists, names and the source clash on a partial answer', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (id, name, bluesky_url, created_at)
			 VALUES (1, 'Sky Artist', 'https://bsky.app/profile/artist.example', '2026-01-01'),
			        (2, 'artist.example', NULL, '2026-01-01');
			 INSERT INTO images (id, title, slug, image_url, source_post_url, created_at)
			 VALUES (5, 'Held', 'held', 'https://cdn.example.com/held.png',
			         '${blueskyPostUrl('artist.example', 'first')}', '2026-01-01');`
		);
		searchImage.mockResolvedValue({ ok: false, reason: 'unavailable' });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });
		resolveBlueskyHandles.mockResolvedValue(new Map([[ARTIST_DID, 'artist.example']]));

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.localArtists).toEqual([
			{ matchIndex: 0, artists: [{ id: 1, name: 'Sky Artist', pieces: 0 }] }
		]);
		expect(body.nameMatches).toEqual([
			{ matchIndex: 0, artists: [{ id: 2, name: 'artist.example', pieces: 0 }] }
		]);
		expect(body.sourceClash).toMatchObject({ imageId: 5, title: 'Held' });
	});

	// An artist whose Bluesky link was saved by DID is the poster of a Skyseek
	// row from that DID, whether or not the AppView gave the row a handle.
	it.each([
		['with a resolved handle', new Map([[ARTIST_DID, 'artist.example']])],
		['with no handle resolved', new Map<string, string>()]
	])('matches a local artist saved by DID to the post %s', async (_name, handles) => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO artists (id, name, bluesky_url, created_at)
			 VALUES (1, 'Sky Artist', 'https://bsky.app/profile/${ARTIST_DID}', '2026-01-01'),
			        (2, 'Someone Else', 'https://bsky.app/profile/${REPOSTER_DID}', '2026-01-01');`
		);
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first', null, 0)] });
		resolveBlueskyHandles.mockResolvedValue(handles);

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		expect(body.localArtists).toEqual([
			{ matchIndex: 0, artists: [{ id: 1, name: 'Sky Artist', pieces: 0 }] }
		]);
	});

	// The settings page's "your key stopped working" does not depend on whether
	// Bluesky happened to have the picture.
	it('records a refused key on a partial answer too, and does not clear it', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'key_refused' });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(200);
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*\|env$/
		);
	});

	it('leaves a standing refusal marker alone when FuzzySearch fails another way', async () => {
		const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '2026-09-01T00:00:00.000Z|env');
		searchImage.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });

		expect((await POST(multipartEvent(platform, pngFile()))).status).toBe(200);
		// Only a FuzzySearch success clears it, and this was not one.
		expect(await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)).toBe(
			'2026-09-01T00:00:00.000Z|env'
		);
	});

	// A throw out of searchImage is a FuzzySearch failure like a typed one: the
	// Bluesky rows are not thrown away with it.
	it('answers the Bluesky posts when the FuzzySearch call throws', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		searchImage.mockRejectedValue(new Error('connection reset'));
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });

		const res = await POST(multipartEvent(platform, pngFile()));
		warn.mockRestore();

		expect(res.status).toBe(200);
		const body = (await res.json()) as Body & { fuzzysearchFailure: string | null };
		expect(body.fuzzysearchFailure).toBe('unavailable');
		expect(body.matches.map((x) => x.site)).toEqual(['Bluesky']);
	});

	// With no Bluesky row to show, the failure is the whole answer, exactly as
	// it was before the two were aggregated: same status, same body.
	describe.each(FUZZY_FAILURES)('a FuzzySearch %s with nothing from Bluesky', (reason, status) => {
		const expectFailure = async (res: Response) => {
			expect(res.status).toBe(status);
			expect(await res.json()).toEqual({ enabled: true, error: reason, forwarded: true });
		};

		it('keeps its answer when Skyseek fails too', async () => {
			const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			searchImage.mockResolvedValue({ ok: false, reason });
			searchSkyseek.mockResolvedValue({ ok: false, reason: 'unavailable' });

			const res = await POST(multipartEvent(platform, pngFile()));
			warn.mockRestore();

			await expectFailure(res);
		});

		it('keeps its answer when Skyseek finds no post', async () => {
			const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			searchImage.mockResolvedValue({ ok: false, reason });

			await expectFailure(await POST(multipartEvent(platform, pngFile())));
		});

		// Decided after the own-post filter. Before it, this would be a 200 with
		// an empty list, which the panel reads as "nothing matched".
		it("keeps its answer when the only post is the operator's own", async () => {
			const { db, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
			await setRawSetting(db, 'blueskyUrl', 'https://bsky.app/profile/me.example');
			searchImage.mockResolvedValue({ ok: false, reason });
			searchSkyseek.mockResolvedValue({ ok: true, matches: [post(OPERATOR_DID, 'mine', null, 0)] });
			resolveBlueskyHandles.mockResolvedValue(new Map([[OPERATOR_DID, 'me.example']]));

			await expectFailure(await POST(multipartEvent(platform, pngFile())));
		});
	});

	// The cost of aggregating, stated in the handler: a FuzzySearch failure is
	// no longer answered the moment it arrives, because the Bluesky rows that
	// may replace it are not in yet.
	it('waits for Skyseek before answering a FuzzySearch failure', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		let answerSkyseek: (result: SkyseekResult) => void = () => {};
		searchSkyseek.mockReturnValue(
			new Promise<SkyseekResult>((resolve) => {
				answerSkyseek = resolve;
			})
		);

		let settled = false;
		const pending = Promise.resolve(POST(multipartEvent(platform, pngFile()))).then((res) => {
			settled = true;
			return res;
		});
		// Long enough for the FuzzySearch failure and every await behind it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(settled).toBe(false);

		answerSkyseek({ ok: true, matches: [post(ARTIST_DID, 'first')] });
		const res = await pending;
		expect(res.status).toBe(200);
		expect(((await res.json()) as { fuzzysearchFailure: string }).fuzzysearchFailure).toBe(
			'rate_limited'
		);
	});

	// The reads behind a partial answer can fail like the ones behind a whole
	// one. The answer is then FuzzySearch's own failure: it is the one with a
	// remedy the operator can act on.
	it('answers the FuzzySearch failure when a read behind a partial answer throws', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		searchImage.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string) => {
			if (/from "artists"/i.test(sql)) throw new Error('D1_ERROR: database is locked');
			return realPrepare(sql);
		};

		const res = await POST(multipartEvent(platform, pngFile()));

		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ enabled: true, error: 'rate_limited', forwarded: true });
	});

	it('asks neither service with no key, a commission piece, or a file it refuses', async () => {
		const noKey = makeEnv();
		expect(await (await POST(multipartEvent(noKey.platform, pngFile()))).json()).toEqual({
			enabled: false,
			forwarded: false
		});

		const fromEntry = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		fromEntry.sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');
			 INSERT INTO commissions (image_id) VALUES (1);`
		);
		const refused = await POST(jsonEvent(fromEntry.platform, { imageId: 1 }));
		expect(await refused.json()).toEqual({
			enabled: true,
			error: 'from_commission',
			forwarded: false
		});

		const notAnImage = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'a.svg', {
			type: 'image/svg+xml'
		});
		expect(await (await POST(multipartEvent(notAnImage.platform, svg))).json()).toEqual({
			enabled: true,
			error: 'invalid_image',
			forwarded: false
		});

		expect(searchSkyseek).not.toHaveBeenCalled();
		expect(resolveBlueskyHandles).not.toHaveBeenCalled();
		expect(searchImage).not.toHaveBeenCalled();
	});

	it('searches Bluesky for a stored image too, with the bytes FuzzySearch gets', async () => {
		const { sqlite, platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		sqlite.exec(
			`INSERT INTO images (id, title, slug, image_url, created_at)
			 VALUES (1, 'Ref', 'ref', 'https://cdn.example.com/stored.png', '2026-01-01');`
		);
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(ARTIST_DID, 'first')] });

		const body = (await (await POST(jsonEvent(platform, { imageId: 1 }))).json()) as Body;

		expect(body.matches.map((x) => x.site)).toEqual(['Bluesky']);
		const sent = searchSkyseek.mock.calls[0][0];
		expect(sent).toBe(searchImage.mock.calls[0][0]);
		expect(new Uint8Array(await sent.arrayBuffer())).toEqual(IMAGE_BYTES);
	});

	it("leaves out the operator's own post of the piece, by handle or by DID", async () => {
		const posts = [
			post(OPERATOR_DID, 'mine', '2026-10-03T02:15:28.000Z'),
			post(ARTIST_DID, 'theirs', '2026-10-04T02:15:28.000Z')
		];
		const handles = new Map([
			[OPERATOR_DID, 'operator.example'],
			[ARTIST_DID, 'artist.example']
		]);

		const byHandle = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(byHandle.db, 'blueskyUrl', 'https://bsky.app/profile/Operator.Example');
		searchSkyseek.mockResolvedValue({ ok: true, matches: posts });
		resolveBlueskyHandles.mockResolvedValue(handles);
		const first = (await (await POST(multipartEvent(byHandle.platform, pngFile()))).json()) as Body;
		expect(first.matches.map((x) => x.siteId)).toEqual([`${ARTIST_DID}/theirs`]);
		// Searched, and the only post found was the operator's own: still searched.
		expect(first.blueskySearched).toBe(true);

		// No handle resolved, and the link was saved in its DID form.
		const byDid = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(byDid.db, 'blueskyUrl', `https://bsky.app/profile/${OPERATOR_DID}`);
		resolveBlueskyHandles.mockResolvedValue(new Map());
		const second = (await (await POST(multipartEvent(byDid.platform, pngFile()))).json()) as Body;
		expect(second.matches.map((x) => x.siteId)).toEqual([`${ARTIST_DID}/theirs`]);

		// No Bluesky link saved: nothing to recognise, so nothing is left out.
		const unset = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		resolveBlueskyHandles.mockResolvedValue(handles);
		const third = (await (await POST(multipartEvent(unset.platform, pngFile()))).json()) as Body;
		expect(third.matches.map((x) => x.siteId)).toEqual([
			`${OPERATOR_DID}/mine`,
			`${ARTIST_DID}/theirs`
		]);
	});

	// The operator posting their own piece over and over must not push other
	// accounts' posts past the cap: their posts go before the cap is applied.
	it("leaves out the operator's own posts before the cap, by DID or by handle", async () => {
		const mine = Array.from({ length: SKYSEEK_MAX_MATCHES + 5 }, (_, i) =>
			post(OPERATOR_DID, `mine${i}`, null, 0)
		);
		const theirs = post(ARTIST_DID, 'theirs', null, 1);

		const byDid = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(byDid.db, 'blueskyUrl', `https://bsky.app/profile/${OPERATOR_DID}`);
		searchSkyseek.mockResolvedValue({ ok: true, matches: [...mine, theirs] });
		const first = (await (await POST(multipartEvent(byDid.platform, pngFile()))).json()) as Body;
		expect(first.matches.map((x) => x.siteId)).toEqual([`${ARTIST_DID}/theirs`]);
		// Known by DID, so the operator's account is not even asked about.
		expect(resolveBlueskyHandles.mock.calls[0][0]).toEqual([ARTIST_DID]);

		resolveBlueskyHandles.mockClear();
		const byHandle = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(byHandle.db, 'blueskyUrl', 'https://bsky.app/profile/operator.example');
		resolveBlueskyHandles.mockResolvedValue(
			new Map([
				[OPERATOR_DID, 'operator.example'],
				[ARTIST_DID, 'artist.example']
			])
		);
		const second = (await (await POST(multipartEvent(byHandle.platform, pngFile()))).json()) as Body;
		expect(second.matches.map((x) => x.siteId)).toEqual([`${ARTIST_DID}/theirs`]);
		// One handle request, one entry per account however many posts it made.
		expect(resolveBlueskyHandles).toHaveBeenCalledTimes(1);
		expect(resolveBlueskyHandles.mock.calls[0][0]).toEqual([OPERATOR_DID, ARTIST_DID]);
	});

	it('asks the AppView about no more accounts than the cap, however many posted', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
		const many = Array.from({ length: SKYSEEK_MAX_MATCHES + 15 }, (_, i) =>
			post(`did:plc:${alphabet[i % 32].repeat(23)}${alphabet[Math.floor(i / 32)]}`, `post${i}`)
		);
		// Each account posted twice, so the distinct accounts run past the cap
		// long after the posts do.
		searchSkyseek.mockResolvedValue({
			ok: true,
			matches: many.flatMap((p) => [p, { ...p, rkey: `${p.rkey}b` }])
		});

		await POST(multipartEvent(platform, pngFile()));

		expect(resolveBlueskyHandles).toHaveBeenCalledTimes(1);
		expect(resolveBlueskyHandles.mock.calls[0][0]).toEqual(
			many.slice(0, 25).map((x) => x.did)
		);
	});

	// The site's link names a handle, and the AppView named nobody for this
	// account: it may be the operator's own post. It stays in the list, as a lead
	// that fills nothing and offers nobody, the way a post with no distance does.
	it("keeps an unresolved poster as a lead when the site's link names a handle", async () => {
		const held = `INSERT INTO images (title, slug, image_url, source_post_url, created_at)
			 VALUES ('Held', 'held', 'https://cdn.example.com/held.png',
			         '${blueskyPostUrl(OPERATOR_DID, 'mine')}', '2026-01-01');`;
		searchSkyseek.mockResolvedValue({ ok: true, matches: [post(OPERATOR_DID, 'mine', null, 0)] });

		const byHandle = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		byHandle.sqlite.exec(held);
		await setRawSetting(byHandle.db, 'blueskyUrl', 'https://bsky.app/profile/operator.example');
		const first = (await (await POST(multipartEvent(byHandle.platform, pngFile()))).json()) as Body;
		expect(first.matches.map((x) => x.siteId)).toEqual([`${OPERATOR_DID}/mine`]);
		expect(first.matches[0]).toMatchObject({ handles: [], distance: 0, band: null });
		// Not the prefill, so nothing is checked against it.
		expect(first.sourceClash).toBeNull();

		// Saved by DID, the account is known without a handle, and every other
		// unresolved poster keeps its band.
		const byDid = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		await setRawSetting(byDid.db, 'blueskyUrl', `https://bsky.app/profile/${ARTIST_DID}`);
		const second = (await (await POST(multipartEvent(byDid.platform, pngFile()))).json()) as Body;
		expect(second.matches[0]).toMatchObject({ handles: [], band: 'exact' });

		// No link saved: there is nobody to mistake the poster for.
		const unset = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const third = (await (await POST(multipartEvent(unset.platform, pngFile()))).json()) as Body;
		expect(third.matches[0]).toMatchObject({ handles: [], band: 'exact' });
	});

	// Unread, the link cannot say which posts are the operator's own, so every
	// post stays a lead that fills nothing and offers nobody. A site with no link
	// saved is not that case: there is nobody to mistake a poster for.
	it("keeps the matches when the site's Bluesky link cannot be read, as leads only", async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const posts = [post(OPERATOR_DID, 'mine', null, 0), post(ARTIST_DID, 'theirs', null, 1)];
		const handles = new Map([
			[OPERATOR_DID, 'operator.example'],
			[ARTIST_DID, 'artist.example']
		]);
		searchSkyseek.mockResolvedValue({ ok: true, matches: posts });
		resolveBlueskyHandles.mockResolvedValue(handles);
		const d1 = platform.env.DB as unknown as { prepare: (sql: string) => unknown };
		const realPrepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string) => {
			if (/from "site_settings"/i.test(sql)) throw new Error('D1_ERROR: database is locked');
			return realPrepare(sql);
		};

		const res = await POST(multipartEvent(platform, pngFile()));
		warn.mockRestore();

		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		expect(body.matches.map((x) => x.siteId)).toEqual([`${OPERATOR_DID}/mine`, `${ARTIST_DID}/theirs`]);
		expect(body.matches.map((x) => x.band)).toEqual([null, null]);

		const unset = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const saved = (await (await POST(multipartEvent(unset.platform, pngFile()))).json()) as Body;
		expect(saved.matches.map((x) => x.band)).toEqual(['exact', 'strong']);
	});

	it('shows the earliest posts of a picture that went round, and resolves only those', async () => {
		const { platform } = makeEnv({ FUZZYSEARCH_API_KEY: 'k' });
		const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
		const many = Array.from({ length: SKYSEEK_MAX_MATCHES + 15 }, (_, i) =>
			post(`did:plc:${alphabet[i % 32].repeat(23)}${alphabet[Math.floor(i / 32)]}`, `post${i}`)
		);
		searchSkyseek.mockResolvedValue({ ok: true, matches: many });

		const body = (await (await POST(multipartEvent(platform, pngFile()))).json()) as Body;

		// 25 as a literal: it is the AppView's own limit on one request, and a
		// test that read the constant would follow it past that limit.
		expect(body.matches).toHaveLength(25);
		expect(body.matches.map((x) => x.siteId)).toEqual(
			many.slice(0, 25).map((x) => `${x.did}/${x.rkey}`)
		);
		expect(body.matches.map((x) => x.siteId)).not.toContain(`${many[25].did}/${many[25].rkey}`);
		const asked = resolveBlueskyHandles.mock.calls[0][0];
		expect(asked).toEqual(many.slice(0, 25).map((x) => x.did));
		expect(asked).not.toContain(many[25].did);
	});
});
