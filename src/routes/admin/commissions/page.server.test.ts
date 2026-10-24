import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { ledgerDb, restoreRegistry, seedEntry, setLedgerGa } from '$lib/server/test/ledger-db';
import { load } from './+page.server';

beforeEach(() => {
	restoreRegistry();
	clearSettingsCache();
	clearSupporterKeyStatusCache();
});
afterEach(restoreRegistry);

type Data = {
	entries: Record<string, unknown>[];
	gate: { open: boolean; gaDate: string | null };
};
const run = async (platform: App.Platform) => (await load({ platform } as never)) as unknown as Data;

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
				piece: { id: 7, title: 'Snowfall' }
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
});
