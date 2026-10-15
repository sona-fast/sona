import { describe, it, expect, beforeEach } from 'vitest';
import { clearSettingsCache } from '$lib/server/settings';
import { ledgerDb, seedEntry } from '$lib/server/test/ledger-db';
import { load } from './+page.server';

beforeEach(() => clearSettingsCache());

// SONA-236: a piece added to the gallery from a commission entry is public,
// and the entry behind it stays private. The public piece page's data carries
// none of the entry's strings or dates.
describe('/gallery/[slug] for a piece linked to a commission entry', () => {
	it("carries none of the entry's private fields", async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.exec(
			`INSERT INTO images (id, slug, title, image_url, artist_id, published, commissioned_at, created_at)
			 VALUES (7, 'snowfall', 'Snowfall', '/a.png', 1, 1, '2026-01-20', '2026-10-01')`
		);
		const id = seedEntry(sqlite, {
			title: 'LEDGER-TITLE headshot',
			notes: 'LEDGER-NOTE wait before sharing',
			priceMinor: 4567,
			currency: 'USD',
			requestedOn: '2026-09-03',
			acceptedOn: '2026-09-05',
			deliveredOn: '2026-10-08',
			status: 'delivered',
			characterIds: [1]
		});
		sqlite
			.prepare("UPDATE commissions SET image_id = 7, kind = 'LEDGER-KIND', source_url = 'https://t.me/ledger_chat/1' WHERE id = ?")
			.run(id);

		const data = await load({ platform, params: { slug: 'snowfall' } } as never);
		const text = JSON.stringify(data);
		// The page did load the piece, so the absence below is not an empty page.
		expect(text).toContain('Snowfall');
		expect(text).toContain('2026-01-20');
		expect(text).not.toMatch(/LEDGER-|ledger_chat|4567|2026-09-03|2026-09-05|2026-10-08|delivered/);
	});
});
