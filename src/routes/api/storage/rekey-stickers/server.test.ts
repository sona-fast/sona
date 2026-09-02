import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import {
	UnscrubbableImageError,
	UNSCRUBBABLE_MIGRATE_MESSAGE
} from '$lib/server/storage/scrub-metadata';
import { POST } from './+server';

// Stub only the provider resolution; `isOwnedUrl`/`deleteFile` stay real (they
// call the module's own getStorage, not this mock) so the route's ownership
// check still runs against a real R2 provider over the stub bucket below.
const put = vi.hoisted(() => vi.fn(async (_input?: unknown) => ({ url: '/img/rekeyed.png' })));
vi.mock('$lib/server/storage', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage')>();
	return { ...original, getStorage: vi.fn(() => ({ put })) };
});

const ORIGIN = 'https://site.example';

// The parser's own wording. The route must NOT surface this to the operator:
// the counterfactual for this suite is reverting `error:` to `e.message`.
const PARSER_MESSAGE = 'jpeg: segment 0xE1 runs past the end of the file';

function seed() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
		CREATE TABLE stickers (id INTEGER PRIMARY KEY, pack_id INTEGER NOT NULL, image_url TEXT NOT NULL);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY, image_url TEXT NOT NULL, photographer TEXT NOT NULL);
	`);
	sqlite.prepare('INSERT INTO sticker_packs (id, slug) VALUES (?, ?)').run(1, 'pack');
	sqlite
		.prepare('INSERT INTO stickers (id, pack_id, image_url) VALUES (?, ?, ?)')
		.run(1, 1, '/img/old-sticker.png');
	sqlite
		.prepare('INSERT INTO fursuit_photos (id, image_url, photographer) VALUES (?, ?, ?)')
		.run(1, '/img/old-photo.jpg', 'Some Photographer');
	return sqlite;
}

function makeEvent(sqlite: ReturnType<typeof seed>) {
	// r2PublicUrl is unset, so owned URLs are the root-relative '/img/…' ones seeded above.
	const bucket = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
	return {
		url: new URL(`${ORIGIN}/api/storage/rekey-stickers`),
		platform: { env: { DB: makeD1(sqlite), IMAGES: bucket } },
		fetch: vi.fn(
			async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
		)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
	put.mockReset();
	put.mockResolvedValue({ url: '/img/rekeyed.png' });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('POST /api/storage/rekey-stickers refusal mapping', () => {
	it('reports the operator-facing migrate wording on both halves when the re-store is refused', async () => {
		const sqlite = seed();
		put.mockRejectedValue(new UnscrubbableImageError(PARSER_MESSAGE));

		const body = await (await POST(makeEvent(sqlite))).json();

		expect(body).toMatchObject({ stickersReKeyed: 0, fursuitReKeyed: 0, failed: 2 });
		expect(body.items).toEqual([
			{
				table: 'stickers',
				id: 1,
				status: 'failed',
				oldUrl: '/img/old-sticker.png',
				error: UNSCRUBBABLE_MIGRATE_MESSAGE
			},
			{
				table: 'fursuit_photos',
				id: 1,
				status: 'failed',
				oldUrl: '/img/old-photo.jpg',
				error: UNSCRUBBABLE_MIGRATE_MESSAGE
			}
		]);
		// The parser's wording belongs in the log, not in the response: one
		// warning per refused row, each naming the row and carrying the error.
		expect(JSON.stringify(body)).not.toContain(PARSER_MESSAGE);
		const warnings = vi.mocked(console.warn).mock.calls;
		expect(warnings).toHaveLength(2);
		for (const args of warnings) {
			expect(args).toContain(1);
			expect(args.some((a) => a instanceof Error && a.message === PARSER_MESSAGE)).toBe(true);
		}

		// Rows keep their old URLs: nothing was re-keyed.
		const urls = sqlite.prepare('SELECT image_url FROM stickers').all() as Array<{ image_url: string }>;
		expect(urls).toEqual([{ image_url: '/img/old-sticker.png' }]);
	});

	it('still surfaces an ordinary failure with its own message', async () => {
		const sqlite = seed();
		put.mockRejectedValue(new Error('r2 put failed: 500'));

		const body = await (await POST(makeEvent(sqlite))).json();

		expect(body.failed).toBe(2);
		expect(body.items.map((i: { error: string }) => i.error)).toEqual([
			'r2 put failed: 500',
			'r2 put failed: 500'
		]);
	});
});
