import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
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
	resolveSiteCharacterId,
	CRON_MAX_NEW
} from './sticker-import';
import { listPublicCharacterNames } from '$lib/server/characters';
import { stickerTabEnabled, clearStickerTabCache } from '$lib/server/stickers';
import { slugify } from '$lib/server/slugify';
import { getStickerSet, downloadFile } from '$lib/server/telegram';
import { UNSCRUBBABLE_STICKER_MESSAGE } from '$lib/server/storage/scrub-metadata';
import { readFileSync } from 'node:fs';

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
	stickerMediaType: (filePath: string) => (filePath.endsWith('.webm') ? 'video/webm' : 'image/webp')
}));

import { animatedWebp, staticWebp } from './test/raster-fixtures';

// The manual save paths animation-sniff raster URLs by fetch. Nothing in this
// suite may hit the real network, so pin global fetch to a static-WebP
// responder; tests that care about sniff results inject their own fetchFn.
beforeAll(() => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(staticWebp().buffer as ArrayBuffer)));
});
afterAll(() => {
	vi.unstubAllGlobals();
});

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

	it('keeps root-relative /img URLs intact (empty-CDN storage fallback)', () => {
		// Packs stored while r2PublicUrl is unset carry /img/<key> URLs; mangling
		// them into https:///img/... made every edit of such a pack fail the
		// self-hosted check even when no image changed.
		const out = parseStickerFormInputs(
			fd({ 'sticker[0][imageUrl]': '/img/stickers/pack-a/a.webp' }),
			null
		);
		expect(out[0].imageUrl).toBe('/img/stickers/pack-a/a.webp');
	});

	it("does not pass through protocol-relative lookalikes ('//' or '/\\')", () => {
		// Browsers treat '/\\host' like '//host' — both must NOT survive as-is.
		for (const raw of ['//evil.com/x.webp', '/\\evil.com/x.webp']) {
			const out = parseStickerFormInputs(fd({ 'sticker[0][imageUrl]': raw }), null);
			expect(out[0].imageUrl).not.toBe(raw);
		}
	});

	it('reads a checked NSFW box even though the hidden 0 fallback posts first', () => {
		// The form emits BOTH the hidden `0` and the checked box's `1` under the same
		// name, in that order — exactly what the real pack-edit form submits.
		const f = new FormData();
		f.append('sticker[0][imageUrl]', 'https://cdn.example.com/stickers/a.webp');
		f.append('sticker[0][format]', 'webp');
		f.append('sticker[0][nsfw]', '0');
		f.append('sticker[0][nsfw]', '1');
		const out = parseStickerFormInputs(f, null);
		expect(out[0].nsfw).toBe(true);
	});

	it('leaves NSFW off when only the hidden 0 is posted (unchecked)', () => {
		const f = new FormData();
		f.append('sticker[0][imageUrl]', 'https://cdn.example.com/stickers/b.webp');
		f.append('sticker[0][format]', 'webp');
		f.append('sticker[0][nsfw]', '0');
		const out = parseStickerFormInputs(f, null);
		expect(out[0].nsfw).toBe(false);
	});
});

import { makeD1 } from '$lib/server/test/d1';

const DDL = `
CREATE TABLE characters (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
	twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
	deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
	is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
	bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
	patreon_url TEXT, instagram_url TEXT, global_id TEXT, registry_version INTEGER,
	registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
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
	is_animated INTEGER NOT NULL DEFAULT 0,
	position INTEGER NOT NULL DEFAULT 0,
	nsfw INTEGER NOT NULL DEFAULT 0,
	telegram_file_unique_id TEXT,
	created_at TEXT NOT NULL
);
CREATE TABLE sticker_emojis (
	sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
	emoji TEXT NOT NULL
);
CREATE UNIQUE INDEX stickers_telegram_file_unique_id_unique ON stickers (telegram_file_unique_id);
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

/**
 * A DB whose first statement matching `trigger.match` runs `trigger.inject` right
 * BEFORE it executes — simulating a concurrent import that committed between this
 * flow's SELECT and its INSERT. Used to test the onConflictDoNothing race branches
 * (pack get-or-create losing the race; a duplicate telegram_file_unique_id insert
 * being skipped) deterministically, without real threads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRacingDb(trigger: { match: RegExp; inject: (sqlite: any) => void }) {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	sqlite.exec(DDL);
	const base = makeD1(sqlite);
	let fired = false;
	const racing = {
		prepare(sql: string) {
			const stmt = base.prepare(sql);
			if (fired || !trigger.match.test(sql)) return stmt;
			return {
				bind(...params: unknown[]) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const bound = (stmt as any).bind(...params);
					const fire = () => {
						if (!fired) {
							fired = true;
							trigger.inject(sqlite);
						}
					};
					return {
						run: () => (fire(), bound.run()),
						all: () => (fire(), bound.all()),
						raw: () => (fire(), bound.raw()),
						_run: () => (fire(), bound._run())
					};
				}
			};
		},
		batch: base.batch
	} as unknown as D1Database;
	const db = drizzle(racing, { schema });
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

	it('saves a pack whose existing sticker URLs predate the current storage config', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);

		// Seed a pack whose stored sticker URL no configured provider recognises —
		// e.g. imported under an old public domain or a since-removed provider.
		const legacyUrl = 'https://old-cdn.example.com/stickers/legacy.webp';
		const [pack] = await db
			.insert(stickerPacks)
			.values({
				name: 'Legacy Pack',
				slug: 'legacy-pack',
				characterId: 1,
				source: 'telegram',
				managerArtistId: null,
				published: false,
				createdAt: new Date().toISOString()
			})
			.returning({ id: stickerPacks.id });
		await db.insert(stickers).values({
			packId: pack.id,
			artistId: null,
			imageUrl: legacyUrl,
			format: 'webp',
			position: 0,
			nsfw: false,
			createdAt: new Date().toISOString()
		});

		const legacyInput = { imageUrl: legacyUrl, artistId: null, emojis: [], nsfw: false, position: 0, format: 'webp' as const };

		// Editing only the description must not reject the already-stored URL.
		await updateManualPack({
			env: testEnv,
			settings: testSettings,
			db,
			packId: pack.id,
			input: {
				name: 'Legacy Pack',
				description: 'edited',
				managerArtistId: null,
				stickerInputs: [legacyInput]
			}
		});
		const packRow = await db.select().from(stickerPacks).where(eq(stickerPacks.id, pack.id)).get();
		expect(packRow?.description).toBe('edited');
		const row = await db.select().from(stickers).where(eq(stickers.packId, pack.id)).get();
		expect(row?.imageUrl).toBe(legacyUrl);

		// A NEW external URL is still rejected — only pre-existing rows are exempt.
		await expect(
			updateManualPack({
				env: testEnv,
				settings: testSettings,
				db,
				packId: pack.id,
				input: {
					name: 'Legacy Pack',
					managerArtistId: null,
					stickerInputs: [
						legacyInput,
						{ imageUrl: 'https://evil.example.com/x.webp', artistId: null, emojis: [], nsfw: false, position: 1, format: 'webp' }
					]
				}
			})
		).rejects.toThrow(/uploaded here/);
	});

	it('preserves a kept sticker’s is_animated flag across an edit without re-sniffing it', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const url = ufs('anim-kept');
		const [pack] = await db
			.insert(stickerPacks)
			.values({ name: 'Anim Pack', slug: 'anim-pack', characterId: 1, source: 'self-hosted', managerArtistId: null, published: false, createdAt: new Date().toISOString() })
			.returning({ id: stickerPacks.id });
		await db.insert(stickers).values({
			packId: pack.id, artistId: null, imageUrl: url, format: 'webp', isAnimated: true,
			position: 0, nsfw: false, createdAt: new Date().toISOString()
		});

		const fetchFn = vi.fn(async () => new Response(staticWebp().buffer as ArrayBuffer));
		await updateManualPack({
			env: testEnv, settings: testSettings, db, packId: pack.id, fetchFn: fetchFn as typeof fetch,
			input: {
				name: 'Anim Pack',
				managerArtistId: null,
				stickerInputs: [{ imageUrl: url, artistId: null, emojis: [], nsfw: false, position: 0, format: 'webp' }]
			}
		});

		const row = await db.select().from(stickers).where(eq(stickers.packId, pack.id)).get();
		// The prior flag wins — a re-sniff (which here would say static) must not run.
		expect(row?.isAnimated).toBe(true);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('sniffs a newly added raster during an edit (animated WebP → is_animated=1)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const keptUrl = ufs('kept-static');
		const { packId } = await saveManualPack({
			env: testEnv, settings: testSettings, db,
			fetchFn: vi.fn(async () => new Response(staticWebp().buffer as ArrayBuffer)) as typeof fetch,
			input: {
				name: 'Grow Pack',
				managerArtistId: null,
				stickerInputs: [{ imageUrl: keptUrl, artistId: null, emojis: [], nsfw: false, position: 0, format: 'webp' }]
			}
		});

		const addedUrl = ufs('new-animated');
		const fetchFn = vi.fn(async () => new Response(animatedWebp().buffer as ArrayBuffer));
		await updateManualPack({
			env: testEnv, settings: testSettings, db, packId, fetchFn: fetchFn as typeof fetch,
			input: {
				name: 'Grow Pack',
				managerArtistId: null,
				stickerInputs: [
					{ imageUrl: keptUrl, artistId: null, emojis: [], nsfw: false, position: 0, format: 'webp' },
					{ imageUrl: addedUrl, artistId: null, emojis: [], nsfw: false, position: 1, format: 'webp' }
				]
			}
		});

		// Only the NEW raster was fetched, and its sniffed flag was stored.
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const rows = await db.select().from(stickers).where(eq(stickers.packId, packId));
		expect(rows.find((r) => r.imageUrl === keptUrl)?.isAnimated).toBe(false);
		expect(rows.find((r) => r.imageUrl === addedUrl)?.isAnimated).toBe(true);
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

describe('saveManualPack', () => {
	it('suffixes the slug when a manual pack name derives an existing slug (both persist)', async () => {
		// Two manual packs with the same name slugify to the same base. The second must
		// get a deterministic -2 suffix rather than failing the atomic batch on the
		// UNIQUE slug constraint. (Slug pinned via Math.random for determinism.)
		const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const input = (imageKey: string) => ({
			name: 'Dupe Name',
			managerArtistId: null,
			stickerInputs: [
				{ imageUrl: ufs(imageKey), artistId: null, emojis: ['😀'], nsfw: false, position: 0, format: 'webp' as const }
			]
		});

		const first = await saveManualPack({ env: testEnv, settings: testSettings, db, input: input('a') });
		const second = await saveManualPack({ env: testEnv, settings: testSettings, db, input: input('b') });

		expect(second.slug).not.toBe(first.slug);
		expect(second.slug).toBe(`${first.slug}-2`);
		expect(await db.select().from(stickerPacks)).toHaveLength(2);
		rnd.mockRestore();
	});

	it('clears the sticker tab probe cache so the pill can flip in this isolate', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		// Prime the cached probe with "no published pack exists".
		clearStickerTabCache();
		expect(await stickerTabEnabled(db)).toBe(false);

		await saveManualPack({
			env: testEnv,
			settings: testSettings,
			db,
			input: {
				name: 'Fresh Pack',
				managerArtistId: null,
				published: true,
				stickerInputs: [
					{ imageUrl: ufs('c'), artistId: null, emojis: ['😀'], nsfw: false, position: 0, format: 'webp' as const }
				]
			}
		});

		// No manual clear here — the save path itself must have invalidated the
		// cache, or this still reads the primed `false` for up to the TTL.
		expect(await stickerTabEnabled(db)).toBe(true);
	});
});

describe('importTelegramPack', () => {
	afterEach(() => {
		// Restore the module-level default (throwing download) for the suites that
		// follow, whichever test in here overrode it.
		vi.mocked(downloadFile).mockReset();
		vi.mocked(downloadFile).mockImplementation(async () => {
			throw new Error('download boom');
		});
	});

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

	it('tells the operator what to do when a sticker cannot be scrubbed', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		// A WebP head over bytes the scrubber cannot walk: the storage layer
		// refuses it (SONA-170), and this page renders the per-item error, so the
		// row must say how to fix it rather than repeat the parser's wording.
		const broken = new Uint8Array([...staticWebp().subarray(0, 12), 0, 0, 0]);
		vi.mocked(downloadFile).mockReset();
		vi.mocked(downloadFile).mockResolvedValue({
			bytes: broken.buffer as ArrayBuffer,
			contentType: 'application/octet-stream',
			filePath: 'stickers/file_0.webp'
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({ objects: [], truncated: false }))
		};

		const result = await importTelegramPack({
			env: { IMAGES: bucket, TELEGRAM_BOT_TOKEN: 'x' } as unknown as SaveOpts['env'],
			settings: {
				primaryCharacter: '',
				storageProvider: 'r2',
				r2PublicUrl: 'https://cdn.test'
			} as unknown as SiteSettings,
			db,
			nameOrUrl: 'failset',
			managerArtistId: null,
			defaultArtistId: null
		});

		expect(result.failed).toBe(1);
		expect(result.items[0].error).toBe(UNSCRUBBABLE_STICKER_MESSAGE);
		expect(bucket.put).not.toHaveBeenCalled();
		// The parser's own wording is still available, in the log.
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
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
			bytes: staticWebp().buffer as ArrayBuffer,
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

	it('records is_animated per media: video and animated WebP true, static WebP false', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		vi.mocked(getStickerSet).mockResolvedValue({
			name: 'megapack',
			title: 'Mega Pack',
			stickers: [
				{ fileId: 's', fileUniqueId: 'us', emoji: '😀', format: 'webp' as const, width: 512, height: 512 },
				{ fileId: 'aw', fileUniqueId: 'uaw', emoji: '🔥', format: 'webp' as const, width: 512, height: 512 },
				{ fileId: 'v', fileUniqueId: 'uv', emoji: '🎉', format: 'video' as const, width: 512, height: 512 }
			]
		});
		// Real container bytes per file: the animated-WebP flag comes from the
		// actual VP8X ANIM bit, not the set metadata.
		vi.mocked(downloadFile).mockImplementation(async (_env, fileId) => {
			if (fileId === 'v') {
				return { bytes: new ArrayBuffer(8), contentType: 'application/octet-stream', filePath: 'stickers/file_v.webm' };
			}
			const bytes = fileId === 'aw' ? animatedWebp() : staticWebp();
			return { bytes: bytes.buffer as ArrayBuffer, contentType: 'application/octet-stream', filePath: `stickers/file_${fileId}.webp` };
		});

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('s'), item('aw'), item('v')]
		});

		expect(r).toMatchObject({ imported: 3 });
		expect(r.failed).toHaveLength(0);
		const byFuid = new Map((await db.select().from(stickers)).map((s) => [s.telegramFileUniqueId, s]));
		expect(byFuid.get('us')?.isAnimated).toBe(false);
		expect(byFuid.get('uaw')?.isAnimated).toBe(true);
		expect(byFuid.get('uv')?.isAnimated).toBe(true);
		expect(byFuid.get('uv')?.format).toBe('video');
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

	it('skips a sticker whose telegram_file_unique_id was inserted concurrently (no double-insert)', async () => {
		// A concurrent import stores sticker 'a' (fileUniqueId 'ua') AFTER this batch
		// snapshots existingFileUniqueIds but BEFORE it inserts. The UNIQUE index makes
		// our insert a no-op, so 'a' is reported skipped (not imported) and never doubled.
		const { db, sqlite } = makeRacingDb({
			match: /insert into "stickers"/i,
			inject: (s) => {
				s.prepare('INSERT INTO sticker_packs (name, slug, character_id, source, published, created_at) VALUES (?,?,?,?,?,?)')
					.run('Other', 'other-pack', 1, 'telegram', 0, new Date().toISOString());
				s.prepare('INSERT INTO stickers (pack_id, artist_id, image_url, format, position, nsfw, telegram_file_unique_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
					.run(2, null, 'https://cdn.test/race.webp', 'webp', 0, 0, 'ua', new Date().toISOString());
			}
		});
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});

		// 'a' lost the race → skipped; only 'b' newly imported.
		expect(r).toMatchObject({ imported: 1, skipped: 1 });
		expect(r.failed).toHaveLength(0);
		// 'ua' exists exactly once (the injected row) — our conflicting insert no-op'd.
		const fuids = (sqlite.prepare('SELECT telegram_file_unique_id AS f FROM stickers').all() as { f: string }[]).map((x) => x.f).sort();
		expect(fuids).toEqual(['ua', 'ub']);
		// No emoji rows written for the skipped 'a' — only 'b' (🔥) got one.
		const emojiCount = sqlite.prepare('SELECT COUNT(*) AS c FROM sticker_emojis').get() as { c: number };
		expect(emojiCount.c).toBe(1);
	});

	it('appends to the winner pack when a concurrent import created it first (no duplicate pack, no throw)', async () => {
		// getOrCreatePack's SELECT misses, but a concurrent import inserts the pack (same
		// slug + telegramUrl) before our INSERT. onConflictDoNothing no-ops and we
		// re-select + append to the winner instead of throwing the raw UNIQUE error.
		// slugify appends a random suffix, so pin Math.random to make the slug the flow
		// computes predictable — and inject a pack carrying that exact slug.
		const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const winnerSlug = slugify('Mega Pack');
		const { db, sqlite } = makeRacingDb({
			match: /insert into "sticker_packs"/i,
			inject: (s) => {
				s.prepare('INSERT INTO sticker_packs (name, slug, character_id, telegram_url, source, published, created_at) VALUES (?,?,?,?,?,?,?)')
					.run('Mega Pack', winnerSlug, 1, 'https://t.me/addstickers/megapack', 'telegram', 0, new Date().toISOString());
			}
		});
		await seedCharacterAndArtist(db);
		mockDownloadOk();

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a'), item('b')]
		});

		// The loser reports created=false and still imports both stickers into the winner.
		expect(r).toMatchObject({ created: false, imported: 2, skipped: 0 });
		expect(r.failed).toHaveLength(0);
		// Exactly one pack row — no duplicate.
		expect(await db.select().from(stickerPacks)).toHaveLength(1);
		const packRow = sqlite.prepare('SELECT id, slug FROM sticker_packs').get() as { id: number; slug: string };
		expect(packRow.slug).toBe(winnerSlug);
		const rows = await db.select().from(stickers);
		expect(rows).toHaveLength(2);
		expect(rows.map((x) => x.telegramFileUniqueId).sort()).toEqual(['ua', 'ub']);
		expect(rows.every((x) => x.packId === packRow.id)).toBe(true);
		rnd.mockRestore();
	});

	it('suffixes the slug when it derives the same value as a DIFFERENT set (both packs persist)', async () => {
		// A pre-existing pack with the SAME base slug but a DIFFERENT telegramUrl (two sets
		// whose titles slugify identically). getOrCreatePack derives a deterministic -2
		// suffix instead of failing, so the import succeeds and both packs coexist with
		// distinct slugs. (Slug pinned via Math.random for determinism.)
		const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const baseSlug = slugify('Mega Pack');
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		await db.insert(stickerPacks).values({
			name: 'Mega Pack', slug: baseSlug, characterId: 1, source: 'telegram',
			telegramUrl: 'https://t.me/addstickers/someotherset', managerArtistId: null,
			published: false, createdAt: new Date().toISOString()
		});
		mockDownloadOk();

		const r = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: 'megapack', managerArtistId: null,
			items: [item('a')]
		});
		expect(r).toMatchObject({ created: true, imported: 1 });
		expect(r.failed).toHaveLength(0);

		// Both packs persist; the newly-imported one carries the -2 suffix + megapack's URL.
		const packs = await db.select().from(stickerPacks);
		expect(packs).toHaveLength(2);
		const imported = packs.find((p) => p.telegramUrl === 'https://t.me/addstickers/megapack')!;
		expect(imported.slug).toBe(`${baseSlug}-2`);
		expect(imported.slug).not.toBe(baseSlug);
		rnd.mockRestore();
	});
});

// --- Cross-pack shared-file safety (importStickerBatch) ---------------------
//
// Two DIFFERENT Telegram packs (distinct names → distinct telegramUrls) can share
// source art. Telegram's dedupe key is file_unique_id, and cross-pack dedupe is
// GLOBAL (existingFileUniqueIds selects the whole column, sticker-import.ts). These
// tests pin that importing/re-syncing one pack never loses stickers from the other:
//  - a file_unique_id already stored in pack A is SKIPPED in pack B (not moved,
//    not re-downloaded, not duplicated) — sticker-import.ts skip branch ~L759;
//  - re-importing pack A never deletes or mutates pack B's rows (and the drop-empty
//    cleanup at ~L799 only fires for a pack THIS call created), and vice versa;
//  - the realistic case where the SAME art carries DIFFERENT file_unique_ids in the
//    two sets — both import fully and each pack keeps its own copy.
// Two example packs used purely as distinct identifiers for the cross-pack safety tests.
describe('importStickerBatch cross-pack shared-file safety', () => {
	const PACK_A = 'examplefox';
	const PACK_B = 'examplepack99';
	const A_URL = 'https://t.me/addstickers/examplefox';
	const B_URL = 'https://t.me/addstickers/examplepack99';

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

	// getStickerSet returns a different set per pack name; downloadFile always succeeds.
	// Keyed by the raw nameOrUrl the batch importer passes through.
	function mockSets(sets: Record<string, Awaited<ReturnType<typeof getStickerSet>>>) {
		vi.mocked(getStickerSet).mockImplementation(async (_env, nameOrUrl) => {
			const s = sets[nameOrUrl as string];
			if (!s) throw new Error(`unexpected set: ${String(nameOrUrl)}`);
			return s;
		});
		vi.mocked(downloadFile).mockResolvedValue({
			bytes: staticWebp().buffer as ArrayBuffer,
			contentType: 'application/octet-stream',
			filePath: 'stickers/file_0.webp'
		});
	}

	afterEach(() => {
		vi.mocked(getStickerSet).mockReset();
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

	async function packByUrl(db: ReturnType<typeof makeDb>['db'], url: string) {
		return db.select().from(stickerPacks).where(eq(stickerPacks.telegramUrl, url)).get();
	}
	async function stickersOfPack(db: ReturnType<typeof makeDb>['db'], packId: number) {
		return db.select().from(stickers).where(eq(stickers.packId, packId));
	}

	it('skips a shared file_unique_id in pack B, keeping the row in pack A untouched', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		// Pack A owns 'shared-1'. Pack B's set re-uses that exact file_unique_id (a sticker
		// whose fileId is B's own, but Telegram issued the same unique id) plus a B-only one.
		mockSets({
			[PACK_A]: {
				name: PACK_A,
				title: 'ExampleFox',
				stickers: [{ fileId: 'a-shared', fileUniqueId: 'shared-1', emoji: '😀', format: 'webp' as const, width: 512, height: 512 }]
			},
			[PACK_B]: {
				name: PACK_B,
				title: 'ExamplePack99',
				stickers: [
					{ fileId: 'b-shared', fileUniqueId: 'shared-1', emoji: '😀', format: 'webp' as const, width: 512, height: 512 },
					{ fileId: 'b-only', fileUniqueId: 'b-only-1', emoji: '🔥', format: 'webp' as const, width: 512, height: 512 }
				]
			}
		});

		const a = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_A, managerArtistId: null,
			items: [item('a-shared')]
		});
		expect(a).toMatchObject({ created: true, imported: 1, skipped: 0 });

		const packA = (await packByUrl(db, A_URL))!;
		const aRowBefore = (await stickersOfPack(db, packA.id))[0];
		expect(aRowBefore.telegramFileUniqueId).toBe('shared-1');

		const b = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_B, managerArtistId: null,
			items: [item('b-shared'), item('b-only')]
		});
		// 'shared-1' already lives in pack A → skipped in B; only 'b-only-1' imported.
		expect(b).toMatchObject({ created: true, imported: 1, updated: 0, skipped: 1 });
		expect(b.failed).toHaveLength(0);

		// Pack A's row is byte-for-byte the same row (same id, same packId) — not moved.
		const aRowAfter = (await stickersOfPack(db, packA.id))[0];
		expect(aRowAfter.id).toBe(aRowBefore.id);
		expect(aRowAfter.packId).toBe(packA.id);
		expect(aRowAfter.telegramFileUniqueId).toBe('shared-1');

		// Pack B holds ONLY its exclusive sticker — the shared id was never copied in.
		const packB = (await packByUrl(db, B_URL))!;
		const bRows = await stickersOfPack(db, packB.id);
		expect(bRows.map((r) => r.telegramFileUniqueId)).toEqual(['b-only-1']);

		// 'shared-1' exists exactly once across the whole DB, and it belongs to pack A.
		const shared = await db.select().from(stickers).where(eq(stickers.telegramFileUniqueId, 'shared-1'));
		expect(shared).toHaveLength(1);
		expect(shared[0].packId).toBe(packA.id);
	});

	it('re-importing either pack never deletes or mutates the other pack (no cross-pack deletion)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		mockSets({
			[PACK_A]: {
				name: PACK_A,
				title: 'ExampleFox',
				stickers: [{ fileId: 'a-shared', fileUniqueId: 'shared-1', emoji: '😀', format: 'webp' as const, width: 512, height: 512 }]
			},
			[PACK_B]: {
				name: PACK_B,
				title: 'ExamplePack99',
				stickers: [
					{ fileId: 'b-shared', fileUniqueId: 'shared-1', emoji: '😀', format: 'webp' as const, width: 512, height: 512 },
					{ fileId: 'b-only', fileUniqueId: 'b-only-1', emoji: '🔥', format: 'webp' as const, width: 512, height: 512 }
				]
			}
		});

		await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_A, managerArtistId: null,
			items: [item('a-shared')]
		});
		await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_B, managerArtistId: null,
			items: [item('b-shared'), item('b-only')]
		});
		const packA = (await packByUrl(db, A_URL))!;
		const packB = (await packByUrl(db, B_URL))!;
		const bRowBefore = (await stickersOfPack(db, packB.id))[0];

		// Re-import pack A with its original item. 'shared-1' is already in THIS pack →
		// unchanged → skipped. Nothing about pack B may change, and B (with a real sticker)
		// must NOT be dropped by the empty-pack cleanup (that only fires for created packs).
		const aResync = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_A, managerArtistId: null,
			items: [item('a-shared')]
		});
		expect(aResync).toMatchObject({ created: false, imported: 0, updated: 0, skipped: 1 });

		const packBStillThere = await packByUrl(db, B_URL);
		expect(packBStillThere?.id).toBe(packB.id);
		const bRowsAfterA = await stickersOfPack(db, packB.id);
		expect(bRowsAfterA).toHaveLength(1);
		expect(bRowsAfterA[0].id).toBe(bRowBefore.id);
		expect(bRowsAfterA[0].telegramFileUniqueId).toBe('b-only-1');

		// Re-import pack B with its original items. 'shared-1' → skipped (in A), 'b-only-1'
		// → unchanged in B → skipped. Pack A must be untouched.
		const bResync = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_B, managerArtistId: null,
			items: [item('b-shared'), item('b-only')]
		});
		expect(bResync).toMatchObject({ created: false, imported: 0, updated: 0, skipped: 2 });

		const aRows = await stickersOfPack(db, packA.id);
		expect(aRows).toHaveLength(1);
		expect(aRows[0].telegramFileUniqueId).toBe('shared-1');
		// Two packs, two stickers total — nothing gained, nothing lost across the re-syncs.
		expect(await db.select().from(stickerPacks)).toHaveLength(2);
		expect(await db.select().from(stickers)).toHaveLength(2);
	});

	it('keeps both copies when the same art carries DIFFERENT file_unique_ids in each set', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		// The realistic Telegram case: uploading one PNG to two sets makes each set's
		// sticker its own file object, so the unique ids differ. Nothing is shared, so
		// both packs import fully and each keeps its own copy.
		mockSets({
			[PACK_A]: {
				name: PACK_A,
				title: 'ExampleFox',
				stickers: [{ fileId: 'a-png', fileUniqueId: 'png-copy-a', emoji: '😀', format: 'webp' as const, width: 512, height: 512 }]
			},
			[PACK_B]: {
				name: PACK_B,
				title: 'ExamplePack99',
				stickers: [{ fileId: 'b-png', fileUniqueId: 'png-copy-b', emoji: '😀', format: 'webp' as const, width: 512, height: 512 }]
			}
		});

		const a = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_A, managerArtistId: null,
			items: [item('a-png')]
		});
		const b = await importStickerBatch({
			env: r2Env, settings: r2Settings, db, nameOrUrl: PACK_B, managerArtistId: null,
			items: [item('b-png')]
		});
		expect(a).toMatchObject({ created: true, imported: 1, skipped: 0 });
		expect(b).toMatchObject({ created: true, imported: 1, skipped: 0 });

		const packA = (await packByUrl(db, A_URL))!;
		const packB = (await packByUrl(db, B_URL))!;
		expect((await stickersOfPack(db, packA.id)).map((r) => r.telegramFileUniqueId)).toEqual(['png-copy-a']);
		expect((await stickersOfPack(db, packB.id)).map((r) => r.telegramFileUniqueId)).toEqual(['png-copy-b']);
		// Identical artwork in two packs is fine — Telegram's distinct ids are the only
		// sharing constraint, and neither is a duplicate of the other.
		expect(await db.select().from(stickers)).toHaveLength(2);
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
			bytes: staticWebp().buffer as ArrayBuffer,
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

	/**
	 * Seed a telegram-sourced pack already holding sticker 'a' (fileUniqueId 'ua').
	 * seedArtistId sets that existing sticker's credit independently of the
	 * manager (defaults to the manager, matching the pre-#184 seeds).
	 */
	async function seedTelegramPack(
		db: ReturnType<typeof makeDb>['db'],
		managerArtistId: number | null = null,
		seedArtistId: number | null = managerArtistId
	) {
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
			artistId: seedArtistId,
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

	it('unmanaged single-artist pack: appends inherit the one attributed artist (#184)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db); // artist id 1
		const packId = await seedTelegramPack(db, null, 1); // no manager; existing sticker credited to 1
		mockDownloadOk();

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });

		expect(r).toMatchObject({ imported: 2 });
		const fresh = (await db.select().from(stickers).where(eq(stickers.packId, packId))).filter(
			(s) => s.telegramFileUniqueId !== 'ua'
		);
		expect(fresh).toHaveLength(2);
		expect(fresh.every((s) => s.artistId === 1)).toBe(true);
	});

	it('unmanaged pack mixing one credited and one unattributed sticker: appends stay unattributed (strict, PR #195 review)', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db); // artist id 1
		const packId = await seedTelegramPack(db, null, 1); // no manager; existing sticker credited to 1
		// An unattributed pre-existing sibling means the pack could be a collab
		// where only the first sticker has been credited so far — inferring here
		// would publicly misattribute the new stickers, so strict inference
		// refuses (revised 2026-07-17 from #184's original relaxation).
		await db.insert(stickers).values({
			packId,
			artistId: null,
			imageUrl: 'https://cdn.test/seed2.webp',
			width: 512,
			height: 512,
			format: 'webp',
			position: 1,
			nsfw: false,
			telegramFileUniqueId: 'uy',
			createdAt: new Date().toISOString()
		});
		mockDownloadOk();

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });

		expect(r).toMatchObject({ imported: 2 });
		const fresh = (await db.select().from(stickers).where(eq(stickers.packId, packId))).filter(
			(s) => s.telegramFileUniqueId === 'ub' || s.telegramFileUniqueId === 'uc'
		);
		expect(fresh).toHaveLength(2);
		expect(fresh.every((s) => s.artistId === null)).toBe(true);
	});

	it('unmanaged mixed-artist pack: appends stay unattributed', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db); // artist id 1
		await db.insert(artists).values({ name: 'Artist B', createdAt: new Date().toISOString() }); // artist id 2
		const packId = await seedTelegramPack(db, null, 1);
		// A second pre-existing sticker credited to a different artist → 2 distinct
		// non-null artists, so inference must not pick either.
		await db.insert(stickers).values({
			packId,
			artistId: 2,
			imageUrl: 'https://cdn.test/seed2.webp',
			width: 512,
			height: 512,
			format: 'webp',
			position: 1,
			nsfw: false,
			telegramFileUniqueId: 'ux',
			createdAt: new Date().toISOString()
		});
		mockDownloadOk();

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });

		expect(r).toMatchObject({ imported: 2 });
		const fresh = (await db.select().from(stickers).where(eq(stickers.packId, packId))).filter(
			(s) => s.telegramFileUniqueId === 'ub' || s.telegramFileUniqueId === 'uc'
		);
		expect(fresh).toHaveLength(2);
		expect(fresh.every((s) => s.artistId === null)).toBe(true);
	});

	it('unmanaged pack with zero attributed stickers: appends stay unattributed', async () => {
		const { db } = makeDb();
		await seedCharacterAndArtist(db);
		const packId = await seedTelegramPack(db); // no manager; existing sticker unattributed
		mockDownloadOk();

		const r = await resyncTelegramPacks({ env: r2Env, settings: r2Settings, db });

		expect(r).toMatchObject({ imported: 2 });
		const fresh = (await db.select().from(stickers).where(eq(stickers.packId, packId))).filter(
			(s) => s.telegramFileUniqueId !== 'ua'
		);
		expect(fresh).toHaveLength(2);
		expect(fresh.every((s) => s.artistId === null)).toBe(true);
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

describe('resolveSiteCharacterId', () => {
	// The auto-create branch (fresh fork, no characters) manufactures a placeholder
	// solely to satisfy the stickers character FK. It must be flagged is_owner so it
	// stays out of public character listings; a pre-existing character we merely
	// resolve must NOT be flagged (it's a real, publicly-featured character).
	function settings(overrides: Partial<SiteSettings>): SiteSettings {
		return { primaryCharacter: '', ownerName: '', siteName: '', ...overrides } as unknown as SiteSettings;
	}

	it('auto-creates an is_owner character named after the owner when none exist', async () => {
		const { db } = makeDb();
		const id = await resolveSiteCharacterId(db, settings({ ownerName: 'Taro', siteName: 'taro.surf' }));
		const row = await db.select({ name: characters.name, isOwner: characters.isOwner }).from(characters).where(eq(characters.id, id)).get();
		expect(row).toEqual({ name: 'Taro', isOwner: true });
	});

	it('reuses the configured primaryCharacter WITHOUT flagging it is_owner', async () => {
		const { db } = makeDb();
		await db.insert(characters).values({ name: 'Rex', createdAt: new Date().toISOString() });
		const id = await resolveSiteCharacterId(db, settings({ primaryCharacter: 'Rex' }));
		const row = await db.select({ name: characters.name, isOwner: characters.isOwner }).from(characters).where(eq(characters.id, id)).get();
		expect(row).toEqual({ name: 'Rex', isOwner: false });
	});

	it('falls back to the first existing character WITHOUT flagging it is_owner', async () => {
		const { db } = makeDb();
		await db.insert(characters).values({ name: 'Rex', createdAt: new Date().toISOString() });
		const id = await resolveSiteCharacterId(db, settings({}));
		const row = await db.select({ isOwner: characters.isOwner }).from(characters).where(eq(characters.id, id)).get();
		expect(row).toEqual({ isOwner: false });
	});
});

describe('listPublicCharacterNames', () => {
	it('excludes is_owner characters and returns the rest ordered by name', async () => {
		const { db } = makeDb();
		await db.insert(characters).values([
			{ name: 'Zephyr', createdAt: new Date().toISOString() },
			{ name: 'taro.surf', isOwner: true, createdAt: new Date().toISOString() },
			{ name: 'Aria', createdAt: new Date().toISOString() }
		]);
		const rows = await listPublicCharacterNames(db);
		expect(rows).toEqual([{ name: 'Aria' }, { name: 'Zephyr' }]);
	});
});

describe('migration 0018 owner_character_flag backfill', () => {
	// Runs the REAL migration SQL against a pre-migration schema so the backfill
	// signal is verified end-to-end (not a re-implementation that could drift).
	it('flags a pack-owning imageless character but never a featured one', () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
			CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL);
			CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
			-- id 1: auto-created owner (owns a pack, in no art). id 2: featured (in art,
			-- also owns a pack — proves owning a pack alone doesn't flag a featured char).
			INSERT INTO characters (id, name) VALUES (1, 'taro.surf'), (2, 'Rex');
			INSERT INTO sticker_packs (id, character_id) VALUES (1, 1), (2, 2);
			INSERT INTO image_characters (image_id, character_id) VALUES (5, 2);
		`);
		const migration = readFileSync(new URL('../../../drizzle/0018_owner_character_flag.sql', import.meta.url), 'utf8');
		for (const stmt of migration.split('--> statement-breakpoint')) sqlite.exec(stmt);
		const rows = sqlite.prepare('SELECT id, is_owner FROM characters ORDER BY id').all();
		expect(rows).toEqual([{ id: 1, is_owner: 1 }, { id: 2, is_owner: 0 }]);
	});
});

describe('migration 0019 stickers_dedupe_unique_id', () => {
	// Runs the REAL migration SQL: it must delete only genuine duplicate
	// telegram_file_unique_id rows (keep MIN id) + their emoji rows before adding the
	// UNIQUE index, and leave NULL (self-hosted) stickers untouched.
	it('drops duplicate telegram ids (keeping the lowest) + their emojis, then enforces uniqueness', () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
			CREATE TABLE stickers (id INTEGER PRIMARY KEY, telegram_file_unique_id TEXT);
			CREATE TABLE sticker_emojis (sticker_id INTEGER NOT NULL, emoji TEXT NOT NULL);
			-- ids 1 & 3 share 'dup' (keep 1, drop 3). id 2 is unique 'a'. ids 4 & 5 are
			-- self-hosted (NULL) — SQLite allows many NULLs, so both must survive.
			INSERT INTO stickers (id, telegram_file_unique_id) VALUES (1,'dup'), (2,'a'), (3,'dup'), (4,NULL), (5,NULL);
			INSERT INTO sticker_emojis (sticker_id, emoji) VALUES (1,'😀'), (3,'🔥'), (2,'🎉');
		`);
		const migration = readFileSync(new URL('../../../drizzle/0019_stickers_dedupe_unique_id.sql', import.meta.url), 'utf8');
		for (const stmt of migration.split('--> statement-breakpoint')) sqlite.exec(stmt);

		const ids = (sqlite.prepare('SELECT id FROM stickers ORDER BY id').all() as { id: number }[]).map((r) => r.id);
		expect(ids).toEqual([1, 2, 4, 5]); // duplicate id 3 removed; the two NULLs kept
		const emojiOwners = (sqlite.prepare('SELECT sticker_id FROM sticker_emojis ORDER BY sticker_id').all() as { sticker_id: number }[]).map((r) => r.sticker_id);
		expect(emojiOwners).toEqual([1, 2]); // id 3's emoji went with it

		// The index now rejects a new duplicate but still allows another NULL.
		expect(() => sqlite.prepare("INSERT INTO stickers (id, telegram_file_unique_id) VALUES (6,'a')").run()).toThrow();
		expect(() => sqlite.prepare('INSERT INTO stickers (id, telegram_file_unique_id) VALUES (7,NULL)').run()).not.toThrow();
	});
});
