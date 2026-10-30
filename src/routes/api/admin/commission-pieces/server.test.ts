import { describe, it, expect } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { ledgerDb, seedEntry } from '$lib/server/test/ledger-db';
import { GET } from './+server';

// GET /api/admin/commission-pieces (SONA-236 Link a piece), against the shipped
// schema. The admin gate in hooks.server.ts covers who may call it, as it does
// every /api route outside /api/cron.

async function get(platform: App.Platform, query: string): Promise<number | Record<string, unknown>> {
	try {
		const res = await GET({ platform, url: new URL(`http://localhost/api/admin/commission-pieces${query}`) } as never);
		return (await res.json()) as Record<string, unknown>;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

describe('GET /api/admin/commission-pieces', () => {
	it("lists the entry artist's pieces, or every piece with scope=all", async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.exec(`INSERT INTO images (id, slug, title, image_url, artist_id, created_at) VALUES
			(7, 'a', 'Snowfall', '/a.png', 1, '2026-10-01'),
			(8, 'b', 'Beach', '/b.png', 2, '2026-10-02')`);
		const id = seedEntry(sqlite);
		const ids = (list: number | Record<string, unknown>) => (list as { pieces: { id: number }[] }).pieces.map((p) => p.id);
		expect(ids(await get(platform, `?entry=${id}`))).toEqual([7]);
		expect(ids(await get(platform, `?entry=${id}&scope=all`))).toEqual([8, 7]);
		expect(ids(await get(platform, `?entry=${id}&scope=all&q=beach`))).toEqual([8]);
	});

	it('404s a malformed or unknown entry', async () => {
		const { platform } = ledgerDb();
		expect(await get(platform, '')).toBe(404);
		expect(await get(platform, '?entry=abc')).toBe(404);
		expect(await get(platform, '?entry=42')).toBe(404);
	});
});
