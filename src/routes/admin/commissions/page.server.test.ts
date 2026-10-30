import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { ledgerDb, restoreRegistry, runAction, seedEntry, setLedgerGa } from '$lib/server/test/ledger-db';
import { actions, load } from './+page.server';

beforeEach(() => {
	restoreRegistry();
	clearSettingsCache();
	clearSupporterKeyStatusCache();
});
afterEach(restoreRegistry);

type Data = {
	added: Record<string, unknown> | null;
	entries: Record<string, unknown>[];
	gate: { open: boolean; gaDate: string | null };
};
const run = async (platform: App.Platform, query = '') =>
	(await load({ platform, url: new URL(`http://localhost/admin/commissions${query}`) } as never)) as unknown as Data;

describe('/admin/commissions load', () => {
	it('reads every entry while the gate is closed', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		seedEntry(sqlite, { title: 'Con badge' });
		const data = await run(platform);
		expect(data.gate).toEqual({ open: false, gaDate: '2999.01.01' });
		expect(data.entries.map((e) => e.title)).toEqual(['Con badge']);
	});

	it('lists each entry with its artist, characters, status, payment, and linked piece', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		sqlite.exec(
			"INSERT INTO images (id, slug, title, image_url, artist_id, created_at) VALUES (7, 'snowfall', 'Snowfall', '/a.png', 2, '2026-10-01')"
		);
		const linked = seedEntry(sqlite, {
			artistId: 2,
			title: 'Winter portrait',
			status: 'delivered',
			payment: 'paid',
			characterIds: [2, 1],
			updatedAt: '2026-10-02T00:00:00.000Z'
		});
		sqlite.prepare('UPDATE commissions SET image_id = 7 WHERE id = ?').run(linked);
		seedEntry(sqlite, { title: 'Birthday gift', status: 'waitlisted', updatedAt: '2026-10-01T00:00:00.000Z' });

		const data = await run(platform);
		expect(data.gate.open).toBe(true);
		// Newest change first.
		expect(data.entries).toEqual([
			{
				id: linked,
				title: 'Winter portrait',
				kind: null,
				status: 'delivered',
				payment: 'paid',
				artistName: 'Artist B',
				artistAvatarUrl: null,
				characterNames: ['Kit', 'Pip'],
				// No thumbnail stored, so the full image stands in.
				piece: { id: 7, title: 'Snowfall', thumb: '/a.png' }
			},
			{
				id: expect.any(Number),
				title: 'Birthday gift',
				kind: null,
				status: 'waitlisted',
				payment: 'unpaid',
				artistName: 'Artist A',
				artistAvatarUrl: null,
				characterNames: [],
				piece: null
			}
		]);
	});

	// The list carries what the table shows and nothing private it doesn't:
	// no notes, price, link, or dates, and nothing measuring time (SONA-9).
	it('ships only the keys the table shows', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		seedEntry(sqlite, {
			notes: 'Private note',
			priceMinor: 4500,
			currency: 'USD',
			requestedOn: '2026-09-03',
			deliveredOn: '2026-10-08'
		});
		const [entry] = (await run(platform)).entries;
		expect(Object.keys(entry).sort()).toEqual(
			['id', 'title', 'kind', 'status', 'payment', 'artistName', 'artistAvatarUrl', 'characterNames', 'piece'].sort()
		);
		expect(JSON.stringify(entry)).not.toMatch(/Private note|4500|2026-09-03|2026-10-08|2026-10-01/);
	});

	it('loads 120 entries with characters, under the 100-parameter cap', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		for (let i = 0; i < 120; i++) seedEntry(sqlite, { title: `Entry ${i}`, characterIds: [1, 2] });
		const data = await run(platform);
		expect(data.entries).toHaveLength(120);
		expect(data.entries.every((e) => (e.characterNames as string[]).join() === 'Kit,Pip')).toBe(true);
	});

	// After an upload from an entry: the notice comes from the saved rows. The
	// URL carries ids only, and an id that doesn't check out shows nothing.
	describe('the "Added to your gallery" notice', () => {
		function linked(sqlite: Parameters<typeof seedEntry>[0], published: number) {
			sqlite.exec(
				`INSERT INTO images (id, slug, title, image_url, artist_id, published, created_at)
				 VALUES (7, 'snowfall', 'Snowfall', '/a.png', 1, ${published}, '2026-10-01'),
				        (8, 'other', 'Other', '/b.png', 1, 1, '2026-10-01')`
			);
			const id = seedEntry(sqlite, { status: 'delivered' });
			sqlite.prepare('UPDATE commissions SET image_id = 7 WHERE id = ?').run(id);
			return id;
		}
		const variant = (sqlite: Parameters<typeof seedEntry>[0], id: number, parent: number, published: number) =>
			sqlite.exec(
				`INSERT INTO images (id, slug, title, image_url, artist_id, parent_image_id, published, created_at)
				 VALUES (${id}, 'v-${id}', 'V', '/v.png', 1, ${parent}, ${published}, '2026-10-01')`
			);

		it('names the new piece and whether visitors can see it', async () => {
			setLedgerGa('past');
			const pub = ledgerDb();
			const pubId = linked(pub.sqlite, 1);
			expect((await run(pub.platform, `?added=${pubId}`)).added).toEqual({
				kind: 'piece',
				imageId: 7,
				title: 'Snowfall',
				published: true
			});
			const priv = ledgerDb();
			const privId = linked(priv.sqlite, 0);
			expect((await run(priv.platform, `?added=${privId}`)).added).toMatchObject({ published: false });
		});

		it("counts new variants of the entry's piece", async () => {
			setLedgerGa('past');
			const { sqlite, platform } = ledgerDb();
			const id = linked(sqlite, 1);
			variant(sqlite, 20, 7, 0);
			variant(sqlite, 21, 7, 0);
			expect((await run(platform, `?added=${id}&variants=20,21`)).added).toEqual({
				kind: 'variants',
				count: 2,
				published: false,
				pieceId: 7,
				pieceTitle: 'Snowfall'
			});
		});

		it('shows nothing for ids that do not check out', async () => {
			setLedgerGa('past');
			const { sqlite, platform } = ledgerDb();
			const id = linked(sqlite, 1);
			variant(sqlite, 30, 8, 1);
			const unlinked = seedEntry(sqlite, { title: 'Unlinked' });
			for (const query of [
				'',
				'?added=abc',
				'?added=999',
				`?added=${unlinked}`,
				`?added=${id}&variants=30`,
				`?added=${id}&variants=999`,
				`?added=${id}&variants=`,
				`?added=${id}&variants=1,2,3,4,5,6,7,8,9`
			]) {
				expect((await run(platform, query)).added, query).toBeNull();
			}
		});
	});
});

describe('/admin/commissions delete action', () => {
	const remove = (platform: App.Platform, id: string) => {
		const form = new FormData();
		form.set('id', id);
		return runAction(actions.delete as never, { platform, form });
	};

	it("deletes only the row's entry, before GA and without a key", async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const gone = seedEntry(sqlite, { title: 'Delete me', characterIds: [1] });
		seedEntry(sqlite, { title: 'Keep me', characterIds: [1] });

		expect((await remove(platform, String(gone))).status).not.toBe(404);
		expect((await run(platform)).entries.map((e) => e.title)).toEqual(['Keep me']);
	});

	it('404s an unknown or malformed id and deletes nothing', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		seedEntry(sqlite, { title: 'Still here' });

		expect((await remove(platform, '42')).status).toBe(404);
		expect((await remove(platform, 'abc')).status).toBe(404);
		expect((await run(platform)).entries.map((e) => e.title)).toEqual(['Still here']);
	});
});
