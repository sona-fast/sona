import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { getTableColumns } from 'drizzle-orm';
import { images } from '$lib/server/db/schema';
import { insertLinkedPiece } from '$lib/server/commission-gallery';
import { ledgerDb, restoreRegistry, rows, seedEntry, setLedgerGa, type Sqlite } from '$lib/server/test/ledger-db';
import { actions, load } from './+page.server';

// Add to gallery (SONA-236 PR 3): the upload page's prefill from an entry and
// the save that inserts the piece and links the entry. Every migration applies
// with foreign keys on, so the writes run against the shipped schema.

beforeEach(() => {
	restoreRegistry();
	setLedgerGa('past');
	clearSettingsCache();
	clearSupporterKeyStatusCache();
});
afterEach(restoreRegistry);

/** An entry with every private field set, so a leak of any of them shows. */
function privateEntry(sqlite: Sqlite, fields: Parameters<typeof seedEntry>[1] = {}) {
	const id = seedEntry(sqlite, {
		title: 'Headshot icon',
		notes: 'PRIVATE-NOTE asked to wait before sharing',
		priceMinor: 4500,
		currency: 'USD',
		requestedOn: '2026-09-03',
		acceptedOn: '2026-09-05',
		characterIds: [2, 1],
		...fields
	});
	sqlite.prepare("UPDATE commissions SET source_url = 'https://t.me/private_chat/412' WHERE id = ?").run(id);
	return id;
}

function seedImage(sqlite: Sqlite, id: number, fields: { commissionedAt?: string | null; parentId?: number | null } = {}) {
	sqlite
		.prepare(
			`INSERT INTO images (id, slug, title, image_url, artist_id, commissioned_at, parent_image_id, published, created_at)
			 VALUES (?, ?, ?, '/img/piece.png', 1, ?, ?, 1, '2026-10-01')`
		)
		.run(id, `piece-${id}`, `Piece ${id}`, fields.commissionedAt ?? null, fields.parentId ?? null);
}

const link = (sqlite: Sqlite, entryId: number, imageId: number) =>
	sqlite.prepare("UPDATE commissions SET image_id = ?, status = 'delivered' WHERE id = ?").run(imageId, entryId);

async function loadPrefill(platform: App.Platform, query: string) {
	const url = new URL(`http://localhost/admin/upload${query}`);
	try {
		return (await load({ platform, url } as never)) as unknown as {
			prefill: Record<string, unknown> | null;
			lookupEnabled: boolean;
			commissionGate: { open: boolean; gaDate: string | null } | null;
		};
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

function uploadForm(fields: Record<string, string>): Request {
	const values: Record<string, string> = {
		title: 'Snowfall',
		artistId: '1',
		count: '1',
		imageUrl_0: '/img/new.png',
		characters: '1,2',
		published: 'on',
		commissionedAt: '',
		sourcePostUrl: '',
		...fields
	};
	const fd = new FormData();
	for (const [k, v] of Object.entries(values)) fd.set(k, v);
	return new Request('http://localhost/admin/upload', { method: 'POST', body: fd });
}

/** Runs the save and reports its status and data, or where it redirected. */
async function save(platform: App.Platform, fields: Record<string, string>) {
	try {
		const result = (await actions.default({ request: uploadForm(fields), platform } as never)) as {
			status: number;
			data: Record<string, unknown>;
		};
		return { status: result.status, data: result.data, location: null as string | null };
	} catch (e) {
		if (e && typeof e === 'object' && 'location' in e) {
			return { status: 302, data: {}, location: (e as { location: string }).location };
		}
		throw e;
	}
}

const imageCount = (sqlite: Sqlite) => (rows(sqlite, 'SELECT COUNT(*) AS n FROM images')[0] as { n: number }).n;
const entryRow = (sqlite: Sqlite, id: number) =>
	rows(sqlite, 'SELECT image_id, status, delivered_on FROM commissions WHERE id = ?', id)[0] as {
		image_id: number | null;
		status: string;
		delivered_on: string | null;
	};

describe('upload load: prefill from an entry', () => {
	it('carries only the allow-listed fields, and no date for a new piece', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const data = await loadPrefill(platform, `?commission=${id}`);
		if (typeof data === 'number') throw new Error(`load failed with ${data}`);
		expect(data.prefill).toEqual({
			id,
			title: 'Headshot icon',
			artistId: 1,
			characterIds: [1, 2],
			existingParentId: null,
			commissionedOn: ''
		});
		// None of the entry's private values ride along anywhere in the page data.
		expect(JSON.stringify(data)).not.toMatch(/PRIVATE-NOTE|private_chat|4500|2026-09-03|2026-09-05/);
	});

	it("starts a variant upload from the linked piece, with the piece's own date", async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite, { deliveredOn: '2026-10-08' });
		seedImage(sqlite, 7, { commissionedAt: '2026-01-20' });
		link(sqlite, id, 7);
		const data = await loadPrefill(platform, `?commission=${id}`);
		if (typeof data === 'number') throw new Error(`load failed with ${data}`);
		expect(data.prefill).toMatchObject({ existingParentId: 7, commissionedOn: '2026-01-20' });
	});

	it('hides Look up artist, which would send the image to FuzzySearch', async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('fuzzysearchApiKey', 'k')").run();
		const id = privateEntry(sqlite);
		const plain = await loadPrefill(platform, '');
		const fromEntry = await loadPrefill(platform, `?commission=${id}`);
		if (typeof plain === 'number' || typeof fromEntry === 'number') throw new Error('load failed');
		expect(plain.lookupEnabled).toBe(true);
		expect(fromEntry.lookupEnabled).toBe(false);
	});

	it('says the gate is closed before any file goes up', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const data = await loadPrefill(platform, `?commission=${id}`);
		const plain = await loadPrefill(platform, '');
		if (typeof data === 'number' || typeof plain === 'number') throw new Error('load failed');
		expect(data.commissionGate).toEqual({ open: false, gaDate: '2999.01.01' });
		// A plain upload doesn't involve the ledger, so it reads no gate.
		expect(plain.commissionGate).toBeNull();
	});

	it('404s an entry that does not exist, or an id that is not one', async () => {
		const { platform } = ledgerDb();
		expect(await loadPrefill(platform, '?commission=42')).toBe(404);
		expect(await loadPrefill(platform, '?commission=abc')).toBe(404);
	});
});

describe('upload save from an entry: a new piece', () => {
	it('saves the form, not the entry, and links the entry to the new piece', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const result = await save(platform, { commissionId: String(id), commissionDeliveredOn: '2026-10-14' });
		expect(result.location).toBe(`/admin/commissions?added=${id}`);

		const [piece] = rows(
			sqlite,
			'SELECT id, title, source_post_url, commissioned_at, published FROM images'
		) as Record<string, unknown>[];
		expect(piece).toMatchObject({ title: 'Snowfall', source_post_url: null, commissioned_at: null, published: 0 });
		expect(entryRow(sqlite, id)).toEqual({ image_id: piece.id, status: 'delivered', delivered_on: '2026-10-14' });
		expect(rows(sqlite, 'SELECT character_id FROM image_characters ORDER BY character_id')).toEqual([
			{ character_id: 1 },
			{ character_id: 2 }
		]);
	});

	it("keeps a Delivered date the owner set, and never puts a ledger date on the piece", async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite, { deliveredOn: '2026-10-08' });
		await save(platform, { commissionId: String(id), commissionDeliveredOn: '2026-10-14', commissionedAt: '2026-02-01' });
		expect(entryRow(sqlite, id).delivered_on).toBe('2026-10-08');
		expect(rows(sqlite, 'SELECT commissioned_at FROM images')).toEqual([{ commissioned_at: '2026-02-01' }]);
	});

	it('ignores a Delivered date that is not a date', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		await save(platform, { commissionId: String(id), commissionDeliveredOn: 'yesterday' });
		expect(entryRow(sqlite, id)).toMatchObject({ status: 'delivered', delivered_on: null });
	});

	it('refuses a second save for the same entry with 409, leaving one piece and one link', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		expect((await save(platform, { commissionId: String(id) })).status).toBe(302);
		const second = await save(platform, { commissionId: String(id), title: 'Snowfall again' });
		expect(second.status).toBe(409);
		expect(second.data).toMatchObject({ commission: 'just_added', imageId: entryRow(sqlite, id).image_id });
		expect(imageCount(sqlite)).toBe(1);
	});

	it('inserts nothing when two saves race past the checks', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const db = getDb(platform.env.DB);
		const piece = (slug: string) => ({
			title: slug,
			slug,
			imageUrl: '/img/x.png',
			width: null,
			height: null,
			fileSize: null,
			nsfw: false,
			published: false,
			sourcePostUrl: null,
			artistId: 1,
			collectionId: null,
			commissionedAt: null
		});
		const first = await insertLinkedPiece(db, id, piece('first'), null);
		const second = await insertLinkedPiece(db, id, piece('second'), null);
		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(rows(sqlite, 'SELECT slug FROM images')).toEqual([{ slug: 'first' }]);
		expect(entryRow(sqlite, id).image_id).toBe(first);
	});

	it('writes no piece when linking the entry fails, because the batch is one transaction', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		sqlite.exec(
			"CREATE TRIGGER refuse_link BEFORE UPDATE ON commissions BEGIN SELECT RAISE(ABORT, 'link refused'); END;"
		);
		await expect(save(platform, { commissionId: String(id) })).rejects.toThrow(/link refused/);
		expect(imageCount(sqlite)).toBe(0);
		expect(entryRow(sqlite, id).image_id).toBeNull();
	});
});

describe('upload save from an entry: variants of the linked piece', () => {
	it('adds variants to the piece and leaves the link as it was', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		seedImage(sqlite, 7);
		link(sqlite, id, 7);
		const result = await save(platform, { commissionId: String(id), existingParentId: '7', title: '' });
		const variants = rows(sqlite, 'SELECT id, parent_image_id FROM images WHERE id != 7') as {
			id: number;
			parent_image_id: number;
		}[];
		expect(variants).toHaveLength(1);
		expect(variants[0].parent_image_id).toBe(7);
		expect(result.location).toBe(`/admin/commissions?added=${id}&variants=${variants[0].id}`);
		expect(entryRow(sqlite, id).image_id).toBe(7);
	});
});

describe('upload save from an entry: refusals write no image', () => {
	const cases: [string, (sqlite: Sqlite) => Record<string, string>, number, string][] = [
		['a missing entry', () => ({ commissionId: '99' }), 400, 'missing'],
		['an id that is not one', () => ({ commissionId: 'abc' }), 400, 'missing'],
		[
			'a cancelled entry',
			(sqlite) => ({ commissionId: String(privateEntry(sqlite, { status: 'cancelled' })) }),
			400,
			'closed'
		],
		[
			'a not-picked entry',
			(sqlite) => ({ commissionId: String(privateEntry(sqlite, { status: 'not_picked' })) }),
			400,
			'closed'
		],
		[
			'variants of another piece for a linked entry',
			(sqlite) => {
				const id = privateEntry(sqlite);
				seedImage(sqlite, 7);
				seedImage(sqlite, 8);
				link(sqlite, id, 7);
				return { commissionId: String(id), existingParentId: '8', title: '' };
			},
			400,
			'mismatch'
		],
		[
			'variants of a gallery piece for an unlinked entry',
			(sqlite) => {
				seedImage(sqlite, 8);
				return { commissionId: String(privateEntry(sqlite)), existingParentId: '8', title: '' };
			},
			400,
			'group'
		]
	];

	for (const [name, setup, status, code] of cases) {
		it(`refuses ${name} with ${status}`, async () => {
			const { sqlite, platform } = ledgerDb();
			const fields = setup(sqlite);
			const before = imageCount(sqlite);
			const result = await save(platform, fields);
			expect(result.status).toBe(status);
			expect(result.data.commission).toBe(code);
			expect(imageCount(sqlite)).toBe(before);
		});
	}

	it('refuses with 403 while the gate is closed', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const result = await save(platform, { commissionId: String(id) });
		expect(result.status).toBe(403);
		expect(result.data).toEqual({ commission: 'gated', gaDate: '2999.01.01' });
		expect(imageCount(sqlite)).toBe(0);
		expect(entryRow(sqlite, id).image_id).toBeNull();
	});

	it('leaves an upload without an entry as it was', async () => {
		const { sqlite, platform } = ledgerDb();
		privateEntry(sqlite);
		const result = await save(platform, {});
		expect(result.location).toBe('/admin/images');
		expect(rows(sqlite, 'SELECT image_id, status FROM commissions')).toEqual([{ image_id: null, status: 'applied' }]);
	});
});

describe('a piece saved from an entry gets the schema defaults a plain upload gets', () => {
	it('matches a plain insert in every column that has a default', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const db = getDb(platform.env.DB);
		// Only what the upload form provides; everything else is left to defaults.
		const given = {
			title: 'T',
			imageUrl: '/img/x.png',
			width: null,
			height: null,
			fileSize: null,
			nsfw: false,
			published: false,
			sourcePostUrl: null,
			artistId: 1,
			collectionId: null,
			commissionedAt: null
		};
		await db.insert(images).values({ ...given, slug: 'plain' });
		await insertLinkedPiece(db, id, { ...given, slug: 'linked' }, null);
		const [plain, linked] = ['plain', 'linked'].map(
			(slug) => rows(sqlite, 'SELECT * FROM images WHERE slug = ?', slug)[0] as Record<string, unknown>
		);

		const defaulted = Object.values(getTableColumns(images)).filter((c) => c.hasDefault && !c.primary);
		// Armed: the walk finds the defaulted columns this table has today.
		expect(defaulted.map((c) => c.name).sort()).toEqual(['created_at', 'featured', 'nsfw', 'published']);
		for (const column of defaulted) {
			if (column.name === 'created_at') {
				// A timestamp, generated per insert like the plain one.
				expect(linked.created_at, column.name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				continue;
			}
			expect(linked[column.name], column.name).toEqual(plain[column.name]);
		}
	});
});

describe('upload save from an entry: what the browser sends', () => {
	it("fills an empty Delivered date with the browser's date, and keeps the piece's own date", async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite, { status: 'in_progress' });
		await save(platform, {
			commissionId: String(id),
			commissionedAt: '2026-02-01',
			commissionDeliveredOn: '2026-10-14'
		});
		expect(entryRow(sqlite, id)).toMatchObject({ status: 'delivered', delivered_on: '2026-10-14' });
		expect(rows(sqlite, 'SELECT commissioned_at FROM images')).toEqual([{ commissioned_at: '2026-02-01' }]);
	});

	it('saves the piece as private unless the form says public outright', async () => {
		const { sqlite, platform } = ledgerDb();
		const quiet = privateEntry(sqlite, { title: 'No field' });
		// No Private box and no visibility field: a plain upload would publish this.
		await save(platform, { commissionId: String(quiet), published: '', title: 'Quiet' });
		const open = privateEntry(sqlite, { title: 'Public' });
		await save(platform, { commissionId: String(open), commissionVisibility: 'public', title: 'Loud' });
		expect(rows(sqlite, 'SELECT title, published FROM images ORDER BY id')).toEqual([
			{ title: 'Quiet', published: 0 },
			{ title: 'Loud', published: 1 }
		]);
	});
});

describe('upload save from an entry: the entry changes between the checks and the batch', () => {
	/** The same database, with `change` run just before the action's batch: the
	 * moment another tab's save or edit would land. */
	function racing(platform: App.Platform, change: () => void, after?: () => void): App.Platform {
		const d1 = platform.env.DB as unknown as { prepare: (s: string) => unknown; batch: (s: unknown[]) => unknown };
		const db = {
			prepare: (s: string) => d1.prepare(s),
			batch: async (stmts: unknown[]) => {
				change();
				try {
					return await d1.batch(stmts);
				} finally {
					after?.();
				}
			}
		};
		return { env: { ...platform.env, DB: db } } as unknown as App.Platform;
	}

	it('returns 409 and writes nothing when another save linked it first', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		seedImage(sqlite, 7);
		const result = await save(racing(platform, () => link(sqlite, id, 7)), { commissionId: String(id) });
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ commission: 'just_added', imageId: 7 });
		expect(imageCount(sqlite)).toBe(1);
	});

	it('returns 409 with no piece to name when the batch loses a race the checks no longer see', async () => {
		// The entry is closed only while the batch runs: the batch refuses it, and
		// by the time the checks run again it's addable once more.
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite, { status: 'in_progress' });
		const setStatus = (status: string) =>
			sqlite.prepare('UPDATE commissions SET status = ? WHERE id = ?').run(status, id);
		const result = await save(
			racing(
				platform,
				() => setStatus('cancelled'),
				() => setStatus('in_progress')
			),
			{ commissionId: String(id) }
		);
		expect(result.status).toBe(409);
		expect(result.data).toEqual({ commission: 'just_added', imageId: null });
		expect(imageCount(sqlite)).toBe(0);
		expect(entryRow(sqlite, id)).toMatchObject({ image_id: null, status: 'in_progress' });
	});

	it('returns 400 missing and writes nothing when the entry was deleted meanwhile', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const remove = () => sqlite.prepare('DELETE FROM commissions WHERE id = ?').run(id);
		const result = await save(racing(platform, remove), { commissionId: String(id) });
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ commission: 'missing' });
		expect(imageCount(sqlite)).toBe(0);
	});

	it('returns 400 closed and writes nothing when the entry was canceled meanwhile', async () => {
		const { sqlite, platform } = ledgerDb();
		const id = privateEntry(sqlite);
		const cancel = () => sqlite.prepare("UPDATE commissions SET status = 'cancelled' WHERE id = ?").run(id);
		const result = await save(racing(platform, cancel), { commissionId: String(id) });
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ commission: 'closed', status: 'cancelled' });
		expect(imageCount(sqlite)).toBe(0);
		expect(entryRow(sqlite, id)).toMatchObject({ image_id: null, status: 'cancelled' });
	});
});

