import { describe, it, expect, vi, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here, so
// it's used untyped (the shim below only touches prepare/exec/pragma/transaction).
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { stickerPacks, stickers, stickerEmojis, characters, artists } from '$lib/server/db/schema';
import type { SiteSettings } from '$lib/server/settings';
import {
	gunzip,
	sanitizeLottie,
	parseStickerFormInputs,
	MAX_LOTTIE_BYTES,
	saveManualPack,
	updateManualPack,
	importTelegramPack,
	importStickerBatch,
	resyncTelegramPacks,
	CRON_MAX_NEW
} from './sticker-import';
import { getStickerSet, downloadFile } from '$lib/server/telegram';

// Telegram is mocked so the import path is exercisable offline. getStickerSet
// returns a one-sticker set and downloadFile always throws — i.e. the "every
// download failed" case that BUG C's empty-pack cleanup is about.
vi.mock('$lib/server/telegram', () => ({
	getStickerSet: vi.fn(async () => ({
		name: 'failset',
		title: 'Fail Set',
		stickers: [
			{ fileId: 'f1', fileUniqueId: 'u1', emoji: '😀', format: 'webp', width: 512, height: 512 }
		]
	})),
	downloadFile: vi.fn(async () => {
		throw new Error('download boom');
	}),
	stickerSetUrl: (name: string) => `https://t.me/addstickers/${name}`,
	parseStickerSetName: (s: string) => s,
	stickerMediaType: () => 'image/webp'
}));

const enc = new TextEncoder();
const dec = new TextDecoder();

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('gunzip', () => {
	it('round-trips gzipped data', async () => {
		const original = enc.encode(JSON.stringify({ v: '5.7.0', layers: [] }));
		const out = await gunzip(toArrayBuffer(gzipSync(Buffer.from(original))));
		expect(dec.decode(out)).toBe(dec.decode(original));
	});

	it('aborts a decompression bomb that exceeds the cap', async () => {
		// A tiny gzip of many zero bytes decompresses to > MAX_LOTTIE_BYTES. This is
		// the exact self-DoS the cap exists to stop (gzip ratios reach ~1000x).
		const huge = Buffer.alloc(MAX_LOTTIE_BYTES + 1024 * 1024); // all zeros, ~highly compressible
		const compressed = gzipSync(huge);
		expect(compressed.length).toBeLessThan(MAX_LOTTIE_BYTES); // genuinely a bomb
		await expect(gunzip(toArrayBuffer(compressed))).rejects.toThrow(/size limit/);
	});

	it('rejects non-gzip bytes', async () => {
		await expect(gunzip(enc.encode('not gzip at all').buffer as ArrayBuffer)).rejects.toThrow();
	});
});

describe('sanitizeLottie', () => {
	it('accepts a minimal valid Lottie and returns canonical JSON', () => {
		const out = sanitizeLottie(enc.encode(JSON.stringify({ v: '5.7.0', fr: 30, layers: [] })));
		const parsed = JSON.parse(dec.decode(out));
		expect(parsed.v).toBe('5.7.0');
		expect(parsed.layers).toEqual([]);
	});

	it('blanks embedded asset URLs so the player cannot fetch off-origin', () => {
		const malicious = {
			v: '5.7.0',
			layers: [],
			assets: [{ id: 'img_0', u: 'https://evil.example/', p: 'steal.png' }]
		};
		const out = JSON.parse(dec.decode(sanitizeLottie(enc.encode(JSON.stringify(malicious)))));
		expect(out.assets[0].u).toBe('');
		expect(out.assets[0].p).toBe('');
	});

	it('rejects JSON that is not Lottie-shaped (no version / layers)', () => {
		expect(() => sanitizeLottie(enc.encode(JSON.stringify({ hello: 'world' })))).toThrow(/Lottie/);
		expect(() => sanitizeLottie(enc.encode(JSON.stringify([1, 2, 3])))).toThrow(/Lottie/);
		expect(() => sanitizeLottie(enc.encode(JSON.stringify({ v: '5', layers: 'nope' })))).toThrow(/Lottie/);
	});

	it('rejects non-JSON bytes', () => {
		expect(() => sanitizeLottie(enc.encode('<svg onload=alert(1)>'))).toThrow();
	});
});

describe('parseStickerFormInputs', () => {
	function fd(entries: Record<string, string>): FormData {
		const f = new FormData();
		for (const [k, v] of Object.entries(entries)) f.append(k, v);
		return f;
	}

	it('parses indexed sticker fields in order with compacted positions', () => {
		const out = parseStickerFormInputs(
			fd({
				'sticker[0][imageUrl]': 'https://cdn.example.com/stickers/a.webp',
				'sticker[0][emojis]': '😀, 🔥',
				'sticker[0][artistId]': '3',
				'sticker[0][format]': 'webp',
				'sticker[1][imageUrl]': 'https://cdn.example.com/stickers/b.json',
				'sticker[1][format]': 'animated',
				'sticker[1][nsfw]': '1'
			}),
			99
		);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ imageUrl: 'https://cdn.example.com/stickers/a.webp', artistId: 3, emojis: ['😀', '🔥'], position: 0, format: 'webp' });
		expect(out[1]).toMatchObject({ artistId: 99, nsfw: true, position: 1, format: 'animated' });
	});

	it('skips rows with no imageUrl and defaults the artist', () => {
		const out = parseStickerFormInputs(
			fd({
				'sticker[0][imageUrl]': '',
				'sticker[1][imageUrl]': 'https://cdn.example.com/stickers/b.webp'
			}),
			7
		);
		expect(out).toHaveLength(1);
		expect(out[0].artistId).toBe(7);
		expect(out[0].position).toBe(0);
	});

	it('falls back to webp for an unknown format', () => {
		const out = parseStickerFormInputs(
			fd({ 'sticker[0][imageUrl]': 'https://cdn.example.com/x.webp', 'sticker[0][format]': 'exe' }),
			1
		);
		expect(out[0].format).toBe('webp');
	});
});

// --- DB-backed tests (manual save/edit + Telegram import) -------------------
//
// drizzle's d1 driver only touches client.prepare()/client.batch(), so a thin
// shim over better-sqlite3 stands in for a D1Database (mirroring getReadDb's note
// in db/index.ts). batch() runs inside a better-sqlite3 transaction so it is
// all-or-nothing exactly like a real D1 batch — which is what the atomicity test
// below relies on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) {
			return { results: stmt.all(...params), success: true, meta: {} };
		}
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind(...params: unknown[]) {
				return {
					run: () => exec(sql, params, 'run'),
					all: () => exec(sql, params, 'all'),
					raw: () => exec(sql, params, 'raw'),
					_run: () => exec(sql, params, 'run')
				};
			}
		};
	}
	async function batch(statements: Array<{ _run: () => unknown }>) {
		return sqlite.transaction((stmts: Array<{ _run: () => unknown }>) => stmts.map((s) => s._run()))(statements);
	}
	return { prepare, batch } as unknown as D1Database;
}

const DDL = `
CREATE TABLE characters (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
	twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
	deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
	bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
	patreon_url TEXT, instagram_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sticker_packs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	description TEXT,
	cover_image_url TEXT,
	character_id INTEGER NOT NULL REFERENCES characters(id),
	manager_artist_id INTEGER REFERENCES artists(id),
	telegram_url TEXT,
	source TEXT NOT NULL,
	published INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL
);
CREATE TABLE stickers (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
	artist_id INTEGER REFERENCES artists(id),
	image_url TEXT NOT NULL,
	thumbnail_url TEXT,
	width INTEGER,
	height INTEGER,
	format TEXT NOT NULL DEFAULT 'webp',
	position INTEGER NOT NULL DEFAULT 0,
	nsfw INTEGER NOT NULL DEFAULT 0,
	telegram_file_unique_id TEXT,
	created_at TEXT NOT NULL
);
CREATE TABLE sticker_emojis (
	sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
	emoji TEXT NOT NULL
);
`;

/** A self-hosted-looking URL — isOwnedUrl recognises UploadThing's *.ufs.sh/f/ path. */
function ufs(key: string): string {
	return `https://testapp.ufs.sh/f/${key}`;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	sqlite.exec(DDL);
	const db = drizzle(makeD1(sqlite), { schema });
	return { db, sqlite };
}

// A token that UTApi accepts so getStorage('uploadthing') constructs without
// throwing (no network is made — owns()/isOwnedUrl are pure regex checks).
const utToken = Buffer.from(
	JSON.stringify({ apiKey: 'sk_test_x', appId: 'testapp', regions: ['sea1'] })
).toString('base64');
type SaveOpts = Parameters<typeof saveManualPack>[0];
const testEnv = { UPLOADTHING_TOKEN: utToken } as unknown as SaveOpts['env'];
const testSettings = { primaryCharacter: '', storageProvider: 'uploadthing' } as unknown as SiteSettings;

async function seedCharacterAndArtist(db: ReturnType<typeof makeDb>['db']) {
	await db.insert(characters).values({ name: 'Sparky', createdAt: new Date().toISOString() });
	await db.insert(artists).values({ name: 'Artist A', createdAt: new Date().toISOString() });
}

describe('updateManualPack', () => {
	it('preserves width/height/telegramFileUniqueId the edit form does not carry', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);

		// Seed a Telegram-sourced pack with a sticker that has dimensions + a dedupe id.
		const url = ufs('keep1');
		const [pack] = await db
			.insert(stickerPacks)
			.values({
				name: 'TG Pack',
				slug: 'tg-pack',
				characterId: 1,
				source: 'telegram',
				telegramUrl: 'https://t.me/addstickers/tg',
				managerArtistId: null,
				published: false,
				createdAt: new Date().toISOString()
			})
			.returning({ id: stickerPacks.id });
		await db.insert(stickers).values({
			packId: pack.id,
			artistId: null,
			imageUrl: url,
			width: 512,
			height: 480,
			format: 'webp',
			position: 0,
			nsfw: false,
			telegramFileUniqueId: 'uid-1',
			createdAt: new Date().toISOString()
		});

		// Edit the pack the way the form does — imageUrl/format/emojis/artist/nsfw only.
		await updateManualPack({
			env: testEnv,
			settings: testSettings,
			db,
			packId: pack.id,
			input: {
				name: 'TG Pack (edited)',
				managerArtistId: null,
				stickerInputs: [
					{ imageUrl: url, artistId: null, emojis: ['🔥'], nsfw: false, position: 0, format: 'webp' }
				]
			}
		});

		const row = await db.select().from(stickers).where(eq(stickers.packId, pack.id)).get();
		expect(row?.width).toBe(512);
		expect(row?.height).toBe(480);
		expect(row?.telegramFileUniqueId).toBe('uid-1');
		// The fields the form DOES carry still update.
		const emojiRows = await db.select().from(stickerEmojis).where(eq(stickerEmojis.stickerId, row!.id));
		expect(emojiRows.map((e) => e.emoji)).toEqual(['🔥']);
	});

	it('is atomic: a failed re-insert leaves the existing rows intact', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);

		// Start from a valid two-sticker pack.
		const { packId } = await saveManualPack({
			env: testEnv,
			settings: testSettings,
			db,
			input: {
				name: 'Atomic Pack',
				managerArtistId: null,
				stickerInputs: [
					{ imageUrl: ufs('a'), artistId: null, emojis: ['😀'], nsfw: false, position: 0, format: 'webp' },
					{ imageUrl: ufs('b'), artistId: null, emojis: ['🔥'], nsfw: false, position: 1, format: 'webp' }
				]
			}
		});

		// An edit whose re-insert violates the artist FK (artist 9999 doesn't exist)
		// must roll back the whole batch — including the delete of the old rows.
		await expect(
			updateManualPack({
				env: testEnv,
				settings: testSettings,
				db,
				packId,
				input: {
					name: 'Atomic Pack (broken edit)',
					managerArtistId: null,
					stickerInputs: [
						{ imageUrl: ufs('c'), artistId: 9999, emojis: [], nsfw: false, position: 0, format: 'webp' }
					]
				}
			})
		).rejects.toThrow();

		// Old rows survive; the pack name was not changed either (same batch).
		const rows = await db.select().from(stickers).where(eq(stickers.packId, packId));
		expect(rows.map((r) => r.imageUrl).sort()).toEqual([ufs('a'), ufs('b')]);
		const pack = await db.select().from(stickerPacks).where(eq(stickerPacks.id, packId)).get();
		expect(pack?.name).toBe('Atomic Pack');
	});
});

describe('importTelegramPack', () => {
	it('leaves no empty pack when every download fails', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);

		const result = await importTelegramPack({
			env: testEnv,
			settings: testSettings,
			db,
			nameOrUrl: 'failset',
			managerArtistId: null,
			defaultArtistId: null
		});

		expect(result.imported).toBe(0);
		expect(result.failed).toBe(1);
		const packs = await db.select().from(stickerPacks);
		expect(packs).toHaveLength(0);
	});
});

// --- Batched import (importStickerBatch) ------------------------------------
//
// The batched importer downloads + stores per request, so it needs a working
// storage.put + downloadFile (unlike the all-fail importTelegramPack test above).
// We use the R2 provider backed by a fake in-memory bucket (put just succeeds, no
// network), and override the module-level Telegram mocks to a multi-sticker set
// whose downloads succeed. afterEach restores the failing defaults so this block is
// order-independent w.r.t. the importTelegramPack test.
describe('importStickerBatch', () => {
	const multiSet = {
		name: 'megapack',
		title: 'Mega Pack',
		stickers: [
			{ fileId: 'a', fileUniqueId: 'ua', emoji: '😀', format: 'webp' as const, width: 512, height: 512 },
			{ fileId: 'b', fileUniqueId: 'ub', emoji: '🔥', format: 'webp' as const, width: 512, height: 512 },
			{ fileId: 'c', fileUniqueId: 'uc', emoji: '🎉', format: 'webp' as const, width: 512, height: 512 }
		]
	};

	const fakeBucket = {
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ objects: [], truncated: false }))
	};
	const r2Env = { IMAGES: fakeBucket, TELEGRAM_BOT_TOKEN: 'x' } as unknown as SaveOpts['env'];
	const r2Settings = {
		primaryCharacter: '',
		storageProvider: 'r2',
		r2PublicUrl: 'https://cdn.test'
	} as unknown as SiteSettings;

	function mockDownloadOk() {
		vi.mocked(getStickerSet).mockResolvedValue(multiSet);
		vi.mocked(downloadFile).mockResolvedValue({
			bytes: new ArrayBuffer(8),
			contentType: 'application/octet-stream',
			filePath: 'stickers/file_0.webp'
		});
	}

	afterEach(() => {
		// Restore the module-level defaults (one-sticker failset + throwing download).
		vi.mocked(getStickerSet).mockResolvedValue({
			name: 'failset',
			title: 'Fail Set',
			stickers: [{ fileId: 'f1', fileUniqueId: 'u1', emoji: '😀', format: 'webp', width: 512, height: 512 }]
		});
		vi.mocked(downloadFile).mockReset();
		vi.mocked(downloadFile).mockImplementation(async () => {
			throw new Error('download boom');
		});
	});

	function item(fileId: string, over: { emojis?: string[]; artistId?: number | null; nsfw?: boolean } = {}) {
		return { fileId, emojis: over.emojis ?? [], artistId: over.artistId ?? null, nsfw: over.nsfw ?? false };
	}

	it('imports only the items in the batch', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		const r = await importStickerBatch({
			env: r2Env,
			settings: r2Settings,
			db,
			nameOrUrl: 'megapack',
			managerArtistId: null,
			items: [item('a'), item('b')] // 'c' deliberately left out of this batch
		});

		expect(r).toMatchObject({ created: true, imported: 2, skipped: 0 });
		expect(r.failed).toHaveLength(0);
		const rows = await db.select().from(stickers);
		expect(rows).toHaveLength(2);
		expect(rows.map((s) => s.telegramFileUniqueId).sort()).toEqual(['ua', 'ub']);
		expect(rows.map((s) => s.position).sort()).toEqual([0, 1]);
	});

	it('is idempotent: re-sending a batch skips already-stored items', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		const first = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});
		expect(first.imported).toBe(2);

		const second = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});
		expect(second).toMatchObject({ created: false, imported: 0, skipped: 2 });
		expect(second.failed).toHaveLength(0);
		// No duplicate rows from the re-send.
		expect(await db.select().from(stickers)).toHaveLength(2);
		expect(await db.select().from(stickerPacks)).toHaveLength(1);
	});

	it('appends successive batches to a single pack with continuing positions', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		const b1 = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a')]
		});
		expect(b1.created).toBe(true);
		const b2 = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('b'), item('c')]
		});
		expect(b2.created).toBe(false);

		const packs = await db.select().from(stickerPacks);
		expect(packs).toHaveLength(1);
		const rows = await db.select().from(stickers).where(eq(stickers.packId, packs[0].id));
		expect(rows).toHaveLength(3);
		expect(rows.map((s) => s.position).sort((x, y) => x - y)).toEqual([0, 1, 2]);
	});

	it('leaves no empty pack when every download in the batch fails', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		// getStickerSet resolves, but downloadFile throws for the whole batch.
		vi.mocked(getStickerSet).mockResolvedValue(multiSet);
		vi.mocked(downloadFile).mockRejectedValue(new Error('download boom'));

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});

		expect(r).toMatchObject({ created: false, imported: 0, skipped: 0 });
		expect(r.failed).toHaveLength(2);
		expect(await db.select().from(stickerPacks)).toHaveLength(0);
	});

	it('dedupes by telegram_file_unique_id across packs', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		// Pre-seed an unrelated pack already holding sticker 'a' (fileUniqueId 'ua').
		const [other] = await db
			.insert(stickerPacks)
			.values({ name: 'Other', slug: 'other', characterId: 1, source: 'telegram', managerArtistId: null, published: false, createdAt: new Date().toISOString() })
			.returning({ id: stickerPacks.id });
		await db.insert(stickers).values({
			packId: other.id, artistId: null, imageUrl: 'https://cdn.test/x.webp', format: 'webp',
			position: 0, nsfw: false, telegramFileUniqueId: 'ua', createdAt: new Date().toISOString()
		});

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});

		// 'a' already exists (skipped), only 'b' is newly imported.
		expect(r).toMatchObject({ imported: 1, skipped: 1 });
		const megapack = await db
			.select()
			.from(stickerPacks)
			.where(eq(stickerPacks.telegramUrl, 'https://t.me/addstickers/megapack'))
			.get();
		const rows = await db.select().from(stickers).where(eq(stickers.packId, megapack!.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].telegramFileUniqueId).toBe('ub');
	});

	it('updates an already-imported sticker in place (no re-download, no duplicate)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db); // artist id 1
		mockDownloadOk();

		// Initial import of 'a' (artist unattributed, telegram emoji 😀, sfw).
		await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a')]
		});
		const downloadsAfterImport = vi.mocked(downloadFile).mock.calls.length;

		// Re-sync the SAME sticker with changed metadata.
		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a', { nsfw: true, artistId: 1, emojis: ['🎉', '✨'] })]
		});

		expect(r).toMatchObject({ created: false, imported: 0, updated: 1, skipped: 0 });
		expect(r.failed).toHaveLength(0);
		// No re-download happened for the update.
		expect(vi.mocked(downloadFile).mock.calls.length).toBe(downloadsAfterImport);

		// Still exactly one sticker row, with the new metadata + emoji.
		const rows = await db.select().from(stickers);
		expect(rows).toHaveLength(1);
		expect(rows[0].nsfw).toBe(true);
		expect(rows[0].artistId).toBe(1);
		const emojiRows = await db.select().from(stickerEmojis).where(eq(stickerEmojis.stickerId, rows[0].id));
		expect(emojiRows.map((e) => e.emoji).sort()).toEqual(['✨', '🎉']);
	});

	it('skips an already-imported sticker whose metadata is unchanged', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a', { nsfw: true, artistId: 1, emojis: ['🎉'] })]
		});
		const downloadsAfterImport = vi.mocked(downloadFile).mock.calls.length;

		// Re-send the identical metadata → no-op.
		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a', { nsfw: true, artistId: 1, emojis: ['🎉'] })]
		});

		expect(r).toMatchObject({ created: false, imported: 0, updated: 0, skipped: 1 });
		expect(vi.mocked(downloadFile).mock.calls.length).toBe(downloadsAfterImport);
		expect(await db.select().from(stickers)).toHaveLength(1);
	});
});

// --- Cron re-sync (resyncTelegramPacks) -------------------------------------
//
// The cron re-sync pulls stickers ADDED to a Telegram set since import into the
// existing pack, capped at CRON_MAX_NEW per run. Same storage/download mocking as
// importStickerBatch (R2 fake bucket + a succeeding downloadFile), with getStickerSet
// returning a 3-sticker set. afterEach restores the module-level failing defaults so
// this block is order-independent.
describe('resyncTelegramPacks', () => {
	const TG_URL = 'https://t.me/addstickers/megapack';
	const multiSet = {
		name: 'megapack',
		title: 'Mega Pack',
		stickers: [
			{ fileId: 'a', fileUniqueId: 'ua', emoji: '😀', format: 'webp' as const, width: 512, height: 512 },
			{ fileId: 'b', fileUniqueId: 'ub', emoji: '🔥', format: 'webp' as const, width: 512, height: 512 },
			{ fileId: 'c', fileUniqueId: 'uc', emoji: '🎉', format: 'webp' as const, width: 512, height: 512 }
		]
	};

	const fakeBucket = {
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ objects: [], truncated: false }))
	};
	const r2Env = { IMAGES: fakeBucket, TELEGRAM_BOT_TOKEN: 'x' } as unknown as SaveOpts['env'];
	const r2Settings = {
		primaryCharacter: '',
		storageProvider: 'r2',
		r2PublicUrl: 'https://cdn.test'
	} as unknown as SiteSettings;

	function mockDownloadOk() {
		vi.mocked(getStickerSet).mockResolvedValue(multiSet);
		vi.mocked(downloadFile).mockResolvedValue({
			bytes: new ArrayBuffer(8),
			contentType: 'application/octet-stream',
			filePath: 'stickers/file_0.webp'
		});
	}

	afterEach(() => {
		vi.mocked(getStickerSet).mockResolvedValue({
			name: 'failset',
			title: 'Fail Set',
			stickers: [{ fileId: 'f1', fileUniqueId: 'u1', emoji: '😀', format: 'webp', width: 512, height: 512 }]
		});
		vi.mocked(downloadFile).mockReset();
		vi.mocked(downloadFile).mockImplementation(async () => {
			throw new Error('download boom');
		});
	});

	/** Seed a telegram-sourced pack already holding sticker 'a' (fileUniqueId 'ua'). */
	async function seedTelegramPack(db: ReturnType<typeof makeDb>['db'], managerArtistId: number | null = null) {
		const [pack] = await db
			.insert(stickerPacks)
			.values({
				name: 'Mega Pack',
				slug: 'mega-pack',
				characterId: 1,
				source: 'telegram',
				telegramUrl: TG_URL,
				managerArtistId,
				published: true,
				createdAt: new Date().toISOString()
			})
			.returning({ id: stickerPacks.id });
		await db.insert(stickers).values({
			packId: pack.id,
			artistId: managerArtistId,
			imageUrl: 'https://cdn.test/seed.webp',
			width: 512,
			height: 512,
			format: 'webp',
			position: 0,
			nsfw: false,
			telegramFileUniqueId: 'ua',
			createdAt: new Date().toISOString()
		});
		return pack.id;
	}

	it('appends only the genuinely-new stickers, after the current max position', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db); // artist id 1
		const packId = await seedTelegramPack(db, 1); // managed pack
		mockDownloadOk();

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });

		expect(r).toMatchObject({ packsChecked: 1, imported: 2, capReached: false });
		expect(r.perPack).toEqual([{ slug: 'mega-pack', imported: 2 }]);

		const rows = await db.select().from(stickers).where(eq(stickers.packId, packId));
		expect(rows).toHaveLength(3);
		// 'ua' was already there at position 0; new ones continue at 1 and 2.
		expect(rows.map((s) => s.position).sort((x, y) => x - y)).toEqual([0, 1, 2]);
		expect(rows.map((s) => s.telegramFileUniqueId).sort()).toEqual(['ua', 'ub', 'uc']);
		// New rows inherit the pack's manager artist and are sfw.
		const fresh = rows.filter((s) => s.telegramFileUniqueId !== 'ua');
		expect(fresh.every((s) => s.artistId === 1)).toBe(true);
		expect(fresh.every((s) => s.nsfw === false)).toBe(true);
		// Emojis came from Telegram.
		const ub = rows.find((s) => s.telegramFileUniqueId === 'ub')!;
		const ubEmojis = await db.select().from(stickerEmojis).where(eq(stickerEmojis.stickerId, ub.id));
		expect(ubEmojis.map((e) => e.emoji)).toEqual(['🔥']);
	});

	it('honors the CRON_MAX_NEW cap and reports capReached', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const packId = await seedTelegramPack(db);
		mockDownloadOk();

		// Budget of 1 with two new stickers (ub, uc) available → import one, flag cap.
		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db, maxNew: 1 });

		expect(r).toMatchObject({ imported: 1, capReached: true });
		expect(await db.select().from(stickers).where(eq(stickers.packId, packId))).toHaveLength(2);

		// A follow-up run drains the rest and clears the cap (no dupes).
		const r2 = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db, maxNew: CRON_MAX_NEW });
		expect(r2).toMatchObject({ imported: 1, capReached: false });
		expect(await db.select().from(stickers).where(eq(stickers.packId, packId))).toHaveLength(3);
	});

	it('is a no-op when nothing is new (no writes, no duplicates)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const packId = await seedTelegramPack(db);
		mockDownloadOk();

		// First run imports ub + uc.
		await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });
		const downloadsAfterFirst = vi.mocked(downloadFile).mock.calls.length;
		expect(await db.select().from(stickers).where(eq(stickers.packId, packId))).toHaveLength(3);

		// Second run: the set is unchanged, so it writes nothing and downloads nothing.
		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });
		expect(r).toMatchObject({ packsChecked: 1, imported: 0, capReached: false });
		expect(r.perPack).toEqual([{ slug: 'mega-pack', imported: 0 }]);
		expect(vi.mocked(downloadFile).mock.calls.length).toBe(downloadsAfterFirst);
		expect(await db.select().from(stickers).where(eq(stickers.packId, packId))).toHaveLength(3);
	});

	it('skips a pack whose set fetch fails without aborting the run', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		await seedTelegramPack(db);
		vi.mocked(getStickerSet).mockRejectedValue(new Error('telegram down'));

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });
		expect(r).toMatchObject({ packsChecked: 1, imported: 0, capReached: false });
		expect(r.perPack).toEqual([{ slug: 'mega-pack', imported: 0 }]);
	});
});
