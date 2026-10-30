import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { linkPiece, listLinkablePieces, PICKER_LIMIT, unlinkPiece } from './commission-link';
import { ledgerDb, rows, seedEntry, type Sqlite } from './test/ledger-db';

// Link a piece (SONA-236) against the shipped schema: the picker's list, the
// link's checks and guards, and the unlink.

const VERSION = '2026-10-01T00:00:00.000Z';
const NOW = new Date('2026-10-20T12:00:00.000Z');

/** A piece by `artistId`, created at `createdAt`; a variant when `parent` is set. */
function piece(
	sqlite: Sqlite,
	id: number,
	fields: Partial<{ title: string; artistId: number; parent: number; published: number; createdAt: string }> = {}
) {
	sqlite
		.prepare(
			`INSERT INTO images (id, slug, title, image_url, artist_id, parent_image_id, published, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			`piece-${id}`,
			fields.title ?? `Piece ${id}`,
			`/p${id}.png`,
			fields.artistId ?? 1,
			fields.parent ?? null,
			fields.published ?? 1,
			fields.createdAt ?? `2026-01-${String(id).padStart(2, '0')}`
		);
}

const linkOf = (sqlite: Sqlite, id: number) =>
	(rows(sqlite, 'SELECT image_id FROM commissions WHERE id = ?', id)[0] as { image_id: number | null }).image_id;
const entryRow = (sqlite: Sqlite, id: number) => rows(sqlite, 'SELECT * FROM commissions WHERE id = ?', id)[0];
const imageRows = (sqlite: Sqlite) => rows(sqlite, 'SELECT * FROM images ORDER BY id');

function setup() {
	const { sqlite, platform } = ledgerDb();
	return { sqlite, db: getDb(platform.env.DB) };
}

describe('listLinkablePieces', () => {
	it("lists the entry artist's top-level pieces, newest first, and none of another artist's", async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1, { createdAt: '2026-01-01' });
		piece(sqlite, 2, { createdAt: '2026-03-01' });
		piece(sqlite, 3, { createdAt: '2026-02-01', published: 0 });
		piece(sqlite, 4, { artistId: 2, createdAt: '2026-09-01' });
		piece(sqlite, 5, { parent: 2, createdAt: '2026-09-02' });
		const id = seedEntry(sqlite, { status: 'delivered' });

		const list = await listLinkablePieces(db, id, { scope: 'artist', query: '' });
		expect(list).toMatchObject({ scope: 'artist', query: '', artistName: 'Artist A', more: false });
		expect(list!.pieces.map((p) => p.id)).toEqual([2, 3, 1]);
		expect(list!.pieces.find((p) => p.id === 3)).toEqual({
			id: 3,
			title: 'Piece 3',
			thumb: '/p3.png',
			published: false,
			artistName: 'Artist A',
			taken: false
		});
	});

	it('every piece with scope all, still without variants', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		piece(sqlite, 4, { artistId: 2 });
		piece(sqlite, 5, { parent: 4 });
		const id = seedEntry(sqlite);
		const list = await listLinkablePieces(db, id, { scope: 'all', query: '' });
		expect(list!.pieces.map((p) => [p.id, p.artistName])).toEqual([
			[4, 'Artist B'],
			[1, 'Artist A']
		]);
	});

	it('marks a piece another entry links as taken, and not the entry’s own', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		piece(sqlite, 2);
		const other = seedEntry(sqlite, { title: 'Other' });
		const id = seedEntry(sqlite);
		sqlite.prepare('UPDATE commissions SET image_id = 1 WHERE id = ?').run(other);
		sqlite.prepare('UPDATE commissions SET image_id = 2 WHERE id = ?').run(id);
		const list = await listLinkablePieces(db, id, { scope: 'artist', query: '' });
		expect(list!.pieces.map((p) => [p.id, p.taken])).toEqual([
			[2, false],
			[1, true]
		]);
	});

	it('searches titles ignoring case, with % and _ as plain characters', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1, { title: 'Snowfall portrait' });
		piece(sqlite, 2, { title: 'Beach day' });
		piece(sqlite, 3, { title: '100% fluff' });
		piece(sqlite, 4, { title: 'snow_day' });
		const id = seedEntry(sqlite);
		const search = async (query: string) =>
			(await listLinkablePieces(db, id, { scope: 'artist', query }))!.pieces.map((p) => p.id);
		expect(await search('SNOW')).toEqual([4, 1]);
		expect(await search('%')).toEqual([3]);
		expect(await search('_')).toEqual([4]);
		expect(await search('  beach ')).toEqual([2]);
		expect(await search('nothing like it')).toEqual([]);
	});

	it(`shows the newest ${PICKER_LIMIT} and says there are more`, async () => {
		const { sqlite, db } = setup();
		for (let i = 1; i <= PICKER_LIMIT + 1; i++) piece(sqlite, i, { createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}` });
		const id = seedEntry(sqlite);
		const list = await listLinkablePieces(db, id, { scope: 'artist', query: '' });
		expect(list!.pieces).toHaveLength(PICKER_LIMIT);
		expect(list!.more).toBe(true);
		expect(list!.pieces[0].id).toBe(PICKER_LIMIT + 1);
	});

	it('is null for an entry that does not exist', async () => {
		const { db } = setup();
		expect(await listLinkablePieces(db, 42, { scope: 'artist', query: '' })).toBeNull();
	});
});

describe('linkPiece', () => {
	it('links the piece, marks the entry Delivered with the sent date, and leaves the piece as it was', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		piece(sqlite, 2);
		const id = seedEntry(sqlite, { status: 'in_progress' });
		const before = imageRows(sqlite);

		const result = await linkPiece(db, id, 2, { version: VERSION, deliveredOn: '2026-10-19', now: NOW });
		expect(result).toEqual({ ok: true, version: NOW.toISOString() });
		expect(entryRow(sqlite, id)).toMatchObject({
			image_id: 2,
			status: 'delivered',
			delivered_on: '2026-10-19',
			updated_at: NOW.toISOString()
		});
		expect(imageRows(sqlite)).toEqual(before);
	});

	it('keeps a Delivered date the owner set', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered', deliveredOn: '2025-12-24' });
		await linkPiece(db, id, 1, { version: VERSION, deliveredOn: '2026-10-19', now: NOW });
		expect(entryRow(sqlite, id)).toMatchObject({ image_id: 1, delivered_on: '2025-12-24' });
	});

	it('without a version (the ledger list), links against the entry as read', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered' });
		expect((await linkPiece(db, id, 1, { version: null, deliveredOn: null, now: NOW })).ok).toBe(true);
		expect(linkOf(sqlite, id)).toBe(1);
	});

	// A clock behind the one that wrote the version still moves it forward, so
	// an open form holding the old version can't save over the link.
	it('stamps a version later than the one it replaces', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered' });
		const result = await linkPiece(db, id, 1, { version: VERSION, deliveredOn: null, now: new Date('2020-01-01') });
		expect(result).toEqual({ ok: true, version: '2026-10-01T00:00:00.001Z' });
	});

	it('refuses an out-of-date form and writes nothing', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered', updatedAt: '2026-10-05T00:00:00.000Z' });
		const before = entryRow(sqlite, id);
		expect(await linkPiece(db, id, 1, { version: VERSION, deliveredOn: null, now: NOW })).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(entryRow(sqlite, id)).toEqual(before);
	});

	it('refuses a piece another entry links, a variant, and a piece that does not exist', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		piece(sqlite, 2, { parent: 1 });
		piece(sqlite, 3);
		const other = seedEntry(sqlite, { title: 'Other', status: 'delivered' });
		sqlite.prepare('UPDATE commissions SET image_id = 3 WHERE id = ?').run(other);
		const id = seedEntry(sqlite, { status: 'delivered' });
		const before = entryRow(sqlite, id);
		const link = (imageId: number) => linkPiece(db, id, imageId, { version: VERSION, deliveredOn: null, now: NOW });

		expect(await link(3)).toEqual({ ok: false, reason: 'taken' });
		expect(await link(2)).toEqual({ ok: false, reason: 'variant' });
		expect(await link(99)).toEqual({ ok: false, reason: 'no_piece' });
		expect(entryRow(sqlite, id)).toEqual(before);
		expect(linkOf(sqlite, other)).toBe(3);
	});

	it('refuses an entry that already has a piece, and keeps that piece', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		piece(sqlite, 2);
		const id = seedEntry(sqlite, { status: 'delivered' });
		sqlite.prepare('UPDATE commissions SET image_id = 1 WHERE id = ?').run(id);
		expect(await linkPiece(db, id, 2, { version: VERSION, deliveredOn: null, now: NOW })).toEqual({
			ok: false,
			reason: 'linked'
		});
		expect(linkOf(sqlite, id)).toBe(1);
	});

	it('refuses an entry marked Not picked or Canceled, and one that does not exist', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		for (const status of ['not_picked', 'cancelled']) {
			const id = seedEntry(sqlite, { status });
			expect(await linkPiece(db, id, 1, { version: VERSION, deliveredOn: null, now: NOW })).toEqual({
				ok: false,
				reason: 'closed'
			});
			expect(linkOf(sqlite, id)).toBeNull();
		}
		expect(await linkPiece(db, 99, 1, { version: null, deliveredOn: null, now: NOW })).toEqual({
			ok: false,
			reason: 'missing'
		});
	});

	// Another entry takes the piece between the checks and the write: the
	// unique index refuses it, and that comes back as 'taken', not an error.
	it('answers taken when another entry links the piece after the checks', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const other = seedEntry(sqlite, { title: 'Other', status: 'delivered' });
		const id = seedEntry(sqlite, { status: 'delivered' });
		const batch = db.batch.bind(db);
		db.batch = (async (queries: Parameters<typeof batch>[0]) => {
			const result = await batch(queries);
			sqlite.prepare('UPDATE commissions SET image_id = 1 WHERE id = ?').run(other);
			return result;
		}) as unknown as typeof db.batch;

		expect(await linkPiece(db, id, 1, { version: VERSION, deliveredOn: null, now: NOW })).toEqual({
			ok: false,
			reason: 'taken'
		});
		expect(linkOf(sqlite, id)).toBeNull();
		expect(linkOf(sqlite, other)).toBe(1);
	});

	// Keep private (SONA-236) holds what the site shows. Linking writes only the
	// entry, so a private artist's piece stays private and the box stays ticked.
	it("changes nothing a visitor sees: the piece and its Keep private artist stay as they were", async () => {
		const { sqlite, db } = setup();
		sqlite.exec('UPDATE artists SET ledger_private = 1 WHERE id = 1');
		piece(sqlite, 1, { published: 0 });
		const id = seedEntry(sqlite, { status: 'delivered' });
		const artistsBefore = rows(sqlite, 'SELECT * FROM artists ORDER BY id');
		const imagesBefore = imageRows(sqlite);
		expect((await linkPiece(db, id, 1, { version: VERSION, deliveredOn: null, now: NOW })).ok).toBe(true);
		expect(rows(sqlite, 'SELECT * FROM artists ORDER BY id')).toEqual(artistsBefore);
		expect(imageRows(sqlite)).toEqual(imagesBefore);
	});
});

describe('unlinkPiece', () => {
	it('clears the link and keeps the piece', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered', deliveredOn: '2026-10-08' });
		sqlite.prepare('UPDATE commissions SET image_id = 1 WHERE id = ?').run(id);
		const before = imageRows(sqlite);

		expect(await unlinkPiece(db, id, VERSION, NOW)).toEqual({ ok: true, version: NOW.toISOString() });
		expect(entryRow(sqlite, id)).toMatchObject({ image_id: null, status: 'delivered', delivered_on: '2026-10-08' });
		expect(imageRows(sqlite)).toEqual(before);
	});

	it('counts an entry with no piece as already unlinked, without a write', async () => {
		const { sqlite, db } = setup();
		const id = seedEntry(sqlite, { status: 'delivered' });
		const before = entryRow(sqlite, id);

		expect(await unlinkPiece(db, id, VERSION, NOW)).toEqual({ ok: true, version: VERSION });
		expect(entryRow(sqlite, id)).toEqual(before);
	});

	it('refuses an out-of-date form and keeps the link; a missing entry says so', async () => {
		const { sqlite, db } = setup();
		piece(sqlite, 1);
		const id = seedEntry(sqlite, { status: 'delivered', updatedAt: '2026-10-05T00:00:00.000Z' });
		sqlite.prepare('UPDATE commissions SET image_id = 1 WHERE id = ?').run(id);
		expect(await unlinkPiece(db, id, VERSION, NOW)).toEqual({ ok: false, reason: 'stale' });
		expect(linkOf(sqlite, id)).toBe(1);
		expect(await unlinkPiece(db, 99, VERSION, NOW)).toEqual({ ok: false, reason: 'missing' });
	});
});
