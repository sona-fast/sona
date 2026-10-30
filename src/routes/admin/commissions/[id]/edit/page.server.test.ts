import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import {
	entryForm,
	ledgerDb,
	ledgerSnapshot,
	restoreRegistry,
	rows,
	runAction,
	seedEntry,
	setLedgerGa,
	type Sqlite
} from '$lib/server/test/ledger-db';
import { actions, load } from './+page.server';

vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

beforeEach(() => {
	restoreRegistry();
	clearSettingsCache();
	clearSupporterKeyStatusCache();
	vi.mocked(verifySupporterKey).mockReset();
});
afterEach(restoreRegistry);

const VERSION = '2026-10-01T00:00:00.000Z';

function storeValidKey(sqlite: Sqlite) {
	sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('supporterKey', 'head.tail')").run();
	vi.mocked(verifySupporterKey).mockResolvedValue({
		valid: true,
		login: 'sparky',
		tier: 2,
		expiresAt: new Date('2999-01-01T00:00:00Z')
	});
}

function saveForm(overrides: Record<string, string | string[] | undefined> = {}) {
	return entryForm({ version: VERSION, ...overrides });
}

const save = (platform: App.Platform, id: string, form: FormData) =>
	runAction(actions.save as never, { platform, id, form });
const remove = (platform: App.Platform, id: string) => runAction(actions.delete as never, { platform, id });

async function loadStatus(platform: App.Platform, id: string): Promise<number | 'ok'> {
	try {
		await load({ platform, request: new Request('http://x/'), params: { id } } as never);
		return 'ok';
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

/** The load as it runs after a no-JS POST to `action`, rendering the action's answer. */
async function loadAfterPost(platform: App.Platform, id: string, action: 'save' | 'delete') {
	const url = new URL(`http://x/admin/commissions/${id}/edit?/${action}`);
	try {
		return await load({ platform, request: new Request(url, { method: 'POST' }), params: { id }, url } as never);
	} catch (e) {
		if (isHttpError(e)) return e.status;
		if (isRedirect(e)) return `${e.status} ${e.location}`;
		throw e;
	}
}

describe('load', () => {
	it('404s a non-numeric id, and an id with no entry', async () => {
		setLedgerGa('past');
		const { platform } = ledgerDb();
		for (const id of ['abc', '1.5', '-1', '0', '1e3', ' 1']) expect(await loadStatus(platform, id), id).toBe(404);
		expect(await loadStatus(platform, '42')).toBe(404);
	});

	// Without JavaScript the page renders again after the action, so a save
	// that found the entry gone keeps the form instead of a public 404.
	it('after a no-JS save, an entry deleted elsewhere loads as gone; a GET still 404s', async () => {
		setLedgerGa('past');
		const { platform } = ledgerDb();
		const data = (await loadAfterPost(platform, '42', 'save')) as { entry: unknown; gate: { open: boolean } };
		expect(data.entry).toBeNull();
		expect(data.gate.open).toBe(true);
		expect(await loadStatus(platform, '42')).toBe(404);
		expect(await loadAfterPost(platform, 'abc', 'save')).toBe(404);
	});

	it('after a no-JS delete of an entry already gone, goes to the ledger', async () => {
		setLedgerGa('future');
		const { platform } = ledgerDb();
		expect(await loadAfterPost(platform, '42', 'delete')).toBe('303 /admin/commissions');
	});

	it('after a no-JS save with the gate closed, an entry deleted elsewhere still 404s', async () => {
		setLedgerGa('future');
		const { platform } = ledgerDb();
		expect(await loadAfterPost(platform, '42', 'save')).toBe(404);
	});

	it('loads an entry while the gate is closed', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { title: 'Headshot icon' });
		const data = (await load({ platform, request: new Request('http://x/'), params: { id: String(id) } } as never)) as {
			entry: { title: string };
			gate: { open: boolean };
		};
		expect(data.entry.title).toBe('Headshot icon');
		expect(data.gate.open).toBe(false);
	});

	// Open chat links the entry's own artist's Telegram, never another artist's.
	it("loads the entry's own artist's Telegram link, and the plain-text place as typed", async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		sqlite.exec(`
			UPDATE artists SET telegram_url = 'https://t.me/artist_a' WHERE id = 1;
			UPDATE artists SET telegram_url = 'https://t.me/artist_b' WHERE id = 2;
		`);
		const id = seedEntry(sqlite, { artistId: 2 });
		sqlite.prepare("UPDATE commissions SET source_url = 'Telegram DM' WHERE id = ?").run(id);
		const { entry } = (await load({ platform, request: new Request('http://x/'), params: { id: String(id) } } as never)) as {
			entry: Record<string, unknown>;
		};
		expect(entry).toMatchObject({ artistName: 'Artist B', artistTelegramUrl: 'https://t.me/artist_b', sourceUrl: 'Telegram DM' });
	});

	// SONA-9: the entry the page receives carries its three dates as plain
	// values, and nothing that measures time between them or since them.
	it('ships only allow-listed keys, with the dates and no duration', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, {
			requestedOn: '2026-09-03',
			acceptedOn: '2026-09-05',
			deliveredOn: '2026-10-08',
			priceMinor: 4500,
			currency: 'USD',
			characterIds: [2, 1]
		});
		const { entry } = (await load({ platform, request: new Request('http://x/'), params: { id: String(id) } } as never)) as {
			entry: Record<string, unknown>;
		};
		expect(Object.keys(entry).sort()).toEqual(
			[
				'id',
				'artistId',
				'artistName',
				'artistAvatarUrl',
				// Open chat beside a plain-text "Where it's happening".
				'artistTelegramUrl',
				'title',
				'kind',
				'sourceUrl',
				'status',
				'payment',
				'price',
				'currency',
				'notes',
				'requestedOn',
				'acceptedOn',
				'deliveredOn',
				'characters',
				'piece',
				// The row's updated_at, sent back as the stale-save token and never shown.
				'version'
			].sort()
		);
		for (const key of Object.keys(entry)) expect(key).not.toMatch(/days|elapsed|since|ago|duration|created/i);
		expect(entry).toMatchObject({
			requestedOn: '2026-09-03',
			acceptedOn: '2026-09-05',
			deliveredOn: '2026-10-08',
			price: '45.00',
			currency: 'USD',
			characters: [
				{ id: 1, name: 'Kit' },
				{ id: 2, name: 'Pip' }
			],
			version: VERSION
		});
	});
});

describe('save action', () => {
	it('refuses with 403 before GA without a key, and leaves the entry as it was', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { characterIds: [1] });
		const before = ledgerSnapshot(sqlite);
		const result = await save(platform, String(id), saveForm({ title: 'Changed', characterId: ['2'] }));
		expect(result.status).toBe(403);
		expect(ledgerSnapshot(sqlite)).toEqual(before);
	});

	it('saves before GA with a valid key', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		storeValidKey(sqlite);
		const id = seedEntry(sqlite);
		expect((await save(platform, String(id), saveForm({ title: 'Changed' }))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT title FROM commissions')).toEqual([{ title: 'Changed' }]);
	});

	it('replaces the character links and moves the version on', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { characterIds: [1] });
		const result = await save(platform, String(id), saveForm({ characterId: ['2'], status: 'accepted', acceptedOn: '2026-10-14' }));
		expect(result.status).toBe('redirected');
		expect(rows(sqlite, 'SELECT character_id FROM commission_characters')).toEqual([{ character_id: 2 }]);
		const [row] = rows(sqlite, 'SELECT status, accepted_on, created_at, updated_at FROM commissions') as Record<
			string,
			string
		>[];
		expect(row).toMatchObject({ status: 'accepted', accepted_on: '2026-10-14', created_at: VERSION });
		expect(row.updated_at).not.toBe(VERSION);
	});

	it('refuses a stale version with 409 and changes nothing; the current version saves', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { title: 'Original', characterIds: [1] });

		// Another tab saves first, so the version this form loaded with is old.
		expect((await save(platform, String(id), saveForm({ title: 'From the other tab' }))).status).toBe('redirected');
		const afterOther = ledgerSnapshot(sqlite);

		const stale = await save(platform, String(id), saveForm({ title: 'From this tab', characterId: ['2'] }));
		expect(stale.status).toBe(409);
		// The typing goes back with the version it was sent under, so a second
		// Save without JavaScript is refused again rather than overwriting.
		expect(stale.data).toEqual({
			stale: true,
			version: VERSION,
			values: expect.objectContaining({ title: 'From this tab', characterIds: [2] })
		});
		expect(ledgerSnapshot(sqlite)).toEqual(afterOther);

		// Reload entry: the form now carries the current version, and saves.
		const current = (afterOther.commissions[0] as { updated_at: string }).updated_at;
		const fresh = await save(platform, String(id), saveForm({ version: current, title: 'From this tab', characterId: ['2'] }));
		expect(fresh.status).toBe('redirected');
		expect(rows(sqlite, 'SELECT title FROM commissions')).toEqual([{ title: 'From this tab' }]);
		expect(rows(sqlite, 'SELECT character_id FROM commission_characters')).toEqual([{ character_id: 2 }]);
	});

	it('refuses a save with no version as stale', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite);
		const before = ledgerSnapshot(sqlite);
		expect((await save(platform, String(id), saveForm({ version: undefined }))).status).toBe(409);
		expect(ledgerSnapshot(sqlite)).toEqual(before);
	});

	it('refuses bad input with 400 and leaves the entry as it was', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { characterIds: [1] });
		const before = ledgerSnapshot(sqlite);
		for (const overrides of [
			{ status: 'done' },
			{ price: '45.5', currency: 'JPY' },
			{ artistId: '99' },
			{ characterId: ['99'] }
		]) {
			const result = await save(platform, String(id), saveForm(overrides));
			expect(result.status, JSON.stringify(overrides)).toBe(400);
			expect(result.data.values, JSON.stringify(overrides)).toMatchObject({ title: 'Ref sheet update' });
			expect(result.data.version, JSON.stringify(overrides)).toBe(VERSION);
		}
		expect(ledgerSnapshot(sqlite)).toEqual(before);
	});

	it('a save fixed after a 400 is refused as stale when another tab saved in between', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { title: 'Original' });

		const refused = await save(platform, String(id), saveForm({ title: 'From this tab', price: '45.5', currency: 'JPY' }));
		expect(refused.status).toBe(400);
		// The version this form loaded with, not one read after the refusal.
		expect(refused.data.version).toBe(VERSION);
		// Another tab saves while this one fixes the price.
		expect((await save(platform, String(id), saveForm({ title: 'From the other tab' }))).status).toBe('redirected');

		// The form resubmits with the version the 400 handed back.
		const resubmit = await save(
			platform,
			String(id),
			saveForm({ version: refused.data.version as string, title: 'From this tab', price: '45', currency: 'JPY' })
		);
		expect(resubmit.status).toBe(409);
		expect(rows(sqlite, 'SELECT title FROM commissions')).toEqual([{ title: 'From the other tab' }]);
	});

	it('404s a non-numeric id and an entry that is gone', async () => {
		setLedgerGa('past');
		const { platform } = ledgerDb();
		expect((await save(platform, 'abc', saveForm())).status).toBe(404);
		expect((await save(platform, '42', saveForm())).status).toBe(404);
	});

	it('hands back what was typed when the entry was deleted after the form loaded', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite);
		expect((await remove(platform, String(id))).status).toBe('redirected');
		const result = await save(platform, String(id), saveForm({ notes: 'typed on a deleted entry' }));
		expect(result.status).toBe(404);
		expect(result.data.missing).toBe(true);
		expect(result.data.values).toMatchObject({ title: 'Ref sheet update', notes: 'typed on a deleted entry' });
		expect(result.data.version).toBe(VERSION);
	});
});

describe('delete action', () => {
	it('deletes before GA without a key, links included', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const id = seedEntry(sqlite, { characterIds: [1, 2] });
		const keep = seedEntry(sqlite, { title: 'Keep me', characterIds: [1] });
		expect((await remove(platform, String(id))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT id FROM commissions')).toEqual([{ id: keep }]);
		expect(rows(sqlite, 'SELECT commission_id FROM commission_characters')).toEqual([{ commission_id: keep }]);
		// The artist and characters stay.
		expect(rows(sqlite, 'SELECT COUNT(*) AS n FROM artists')).toEqual([{ n: 2 }]);
		expect(rows(sqlite, 'SELECT COUNT(*) AS n FROM characters')).toEqual([{ n: 2 }]);
	});

	it('404s a non-numeric id and an unknown entry', async () => {
		setLedgerGa('past');
		const { sqlite, platform } = ledgerDb();
		seedEntry(sqlite);
		expect((await remove(platform, 'abc')).status).toBe(404);
		expect((await remove(platform, '42')).status).toBe(404);
		expect(rows(sqlite, 'SELECT COUNT(*) AS n FROM commissions')).toEqual([{ n: 1 }]);
	});
});
