import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import {
	entryForm,
	ledgerDb,
	ledgerSnapshot,
	restoreRegistry,
	rows,
	runAction,
	setLedgerGa,
	type Sqlite
} from '$lib/server/test/ledger-db';
import { actions, load } from './+page.server';

// The gate logic stays real; only the signature check is faked.
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

function storeValidKey(sqlite: Sqlite) {
	sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('supporterKey', 'head.tail')").run();
	vi.mocked(verifySupporterKey).mockResolvedValue({
		valid: true,
		login: 'sparky',
		tier: 2,
		expiresAt: new Date('2999-01-01T00:00:00Z')
	});
}

const create = (platform: App.Platform, form: FormData) => runAction(actions.default as never, { platform, form });

describe('create action: early-access gate', () => {
	it('refuses with 403 before GA without a key, and writes nothing', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		const before = ledgerSnapshot(sqlite);
		const result = await create(platform, entryForm());
		expect(result.status).toBe(403);
		expect(ledgerSnapshot(sqlite)).toEqual(before);
	});

	it('refuses with 403 before GA even when the input is also invalid', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		expect((await create(platform, entryForm({ status: 'bogus' }))).status).toBe(403);
		expect(ledgerSnapshot(sqlite).commissions).toEqual([]);
	});

	it('refuses with 403 when the stored key has expired', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('supporterKey', 'old.token')").run();
		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date('2000-01-01T00:00:00Z')
		});
		expect((await create(platform, entryForm())).status).toBe(403);
		expect(ledgerSnapshot(sqlite).commissions).toEqual([]);
	});

	it('creates the entry before GA with a valid key', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		storeValidKey(sqlite);
		expect((await create(platform, entryForm())).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT title FROM commissions')).toEqual([{ title: 'Ref sheet update' }]);
	});

	it('ignores the e2e bypass outside dev builds', async () => {
		setLedgerGa('future');
		const { sqlite, platform } = ledgerDb();
		(platform.env as unknown as Record<string, string>).E2E_COMMISSION_GATE = 'open';
		expect((await create(platform, entryForm())).status).toBe(403);
		expect(ledgerSnapshot(sqlite).commissions).toEqual([]);
	});

	it('loads the form either way, with the gate state for the page', async () => {
		setLedgerGa('future');
		const { platform } = ledgerDb();
		const data = (await load({ platform, request: new Request('http://x/') } as never)) as {
			gate: { open: boolean; gaDate: string };
			artists: unknown[];
			characters: unknown[];
		};
		expect(data.gate).toEqual({ open: false, gaDate: '2999.01.01' });
		expect(data.artists).toHaveLength(2);
		expect(data.characters).toEqual([
			{ id: 1, name: 'Kit', ownerName: null },
			{ id: 2, name: 'Pip', ownerName: null }
		]);
	});
});

describe('load: the currency picker', () => {
	beforeEach(() => setLedgerGa('past'));

	it("offers saved currencies by last save and the region the browser's languages name", async () => {
		const { platform } = ledgerDb();
		await create(platform, entryForm({ title: 'Old', price: '10', currency: 'EUR' }));
		await new Promise((r) => setTimeout(r, 5));
		await create(platform, entryForm({ title: 'Newer', price: '1000', currency: 'KRW' }));
		await create(platform, entryForm({ title: 'No price', price: '', currency: '' }));
		const request = new Request('http://x/', { headers: { 'accept-language': 'en-GB,en;q=0.9' } });
		const data = (await load({ platform, request } as never)) as { recentCurrencies: string[]; localeCurrency: string | null };
		expect(data.recentCurrencies).toEqual(['KRW', 'EUR']);
		expect(data.localeCurrency).toBe('GBP');
	});

	it('offers only the four most recently saved of five currencies', async () => {
		const { platform } = ledgerDb();
		for (const currency of ['EUR', 'GBP', 'JPY', 'KRW', 'CAD']) {
			await create(platform, entryForm({ title: currency, price: '1000', currency }));
			await new Promise((r) => setTimeout(r, 5));
		}
		const request = new Request('http://x/');
		const data = (await load({ platform, request } as never)) as { recentCurrencies: string[] };
		expect(data.recentCurrencies).toEqual(['CAD', 'KRW', 'JPY', 'GBP']);
	});

	it('names no region when the browser sends only a language', async () => {
		const { platform } = ledgerDb();
		const request = new Request('http://x/', { headers: { 'accept-language': 'en' } });
		const data = (await load({ platform, request } as never)) as { recentCurrencies: string[]; localeCurrency: string | null };
		expect(data).toMatchObject({ recentCurrencies: [], localeCurrency: null });
	});
});

describe('load: the Kind suggestions', () => {
	beforeEach(() => setLedgerGa('past'));

	const kindsAfter = async (platform: App.Platform) =>
		((await load({ platform, request: new Request('http://x/') } as never)) as { recentKinds: string[] }).recentKinds;

	it('offers each kind once, newest first, in the spelling used last', async () => {
		const { platform } = ledgerDb();
		for (const kind of ['Icon', 'Ref sheet', '', 'icon', 'Étude', 'étude']) {
			await create(platform, entryForm({ title: `Kind ${kind || 'none'}`, kind }));
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(await kindsAfter(platform)).toEqual(['étude', 'icon', 'Ref sheet']);
	});

	it('moves a kind up when an entry using it is saved again', async () => {
		const { sqlite, platform } = ledgerDb();
		await create(platform, entryForm({ title: 'Old', kind: 'Badge' }));
		await new Promise((r) => setTimeout(r, 5));
		await create(platform, entryForm({ title: 'New', kind: 'Scene' }));
		sqlite.prepare("UPDATE commissions SET updated_at = '2999-01-01T00:00:00.000Z' WHERE title = 'Old'").run();
		expect(await kindsAfter(platform)).toEqual(['Badge', 'Scene']);
	});

	it('offers at most 20, and nothing when no entry has a kind', async () => {
		const { sqlite, platform } = ledgerDb();
		expect(await kindsAfter(platform)).toEqual([]);
		const insert = sqlite.prepare(
			"INSERT INTO commissions (artist_id, title, kind, created_at, updated_at) VALUES (1, 't', ?, '2026-10-01', ?)"
		);
		for (let i = 0; i < 25; i++) insert.run(`Kind ${i}`, `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`);
		const kinds = await kindsAfter(platform);
		expect(kinds).toHaveLength(20);
		expect(kinds[0]).toBe('Kind 24');
	});
});

describe('create action: what it stores', () => {
	beforeEach(() => setLedgerGa('past'));

	it('stores every field, the price in minor units, and the character links', async () => {
		const { sqlite, platform } = ledgerDb();
		const form = entryForm({
			characterId: ['1', '2'],
			price: '45.50',
			currency: 'usd',
			status: 'delivered',
			payment: 'deposit',
			acceptedOn: '2026-10-05',
			deliveredOn: '2026-10-08'
		});
		expect((await create(platform, form)).status).toBe('redirected');
		const [row] = rows(sqlite, 'SELECT * FROM commissions') as Record<string, unknown>[];
		expect(row).toMatchObject({
			artist_id: 1,
			title: 'Ref sheet update',
			kind: 'Ref sheet',
			source_url: 'https://t.me/artist_a/412',
			status: 'delivered',
			payment: 'deposit',
			price_minor: 4550,
			currency: 'USD',
			notes: 'Two outfits, front and back views.',
			requested_on: '2026-10-02',
			accepted_on: '2026-10-05',
			delivered_on: '2026-10-08',
			image_id: null
		});
		expect(row.created_at).toBe(row.updated_at);
		expect(rows(sqlite, 'SELECT commission_id, character_id FROM commission_characters ORDER BY character_id')).toEqual([
			{ commission_id: row.id, character_id: 1 },
			{ commission_id: row.id, character_id: 2 }
		]);
	});

	it('stores empty optional fields as null', async () => {
		const { sqlite, platform } = ledgerDb();
		const form = entryForm({
			kind: '',
			sourceUrl: '',
			characterId: undefined,
			price: '',
			currency: '',
			notes: '',
			requestedOn: ''
		});
		expect((await create(platform, form)).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT kind, source_url, price_minor, currency, notes, requested_on FROM commissions')).toEqual([
			{ kind: null, source_url: null, price_minor: null, currency: null, notes: null, requested_on: null }
		]);
		expect(ledgerSnapshot(sqlite).links).toEqual([]);
	});

	// Where it's happening: a link is sanitized as before; the owner's own words
	// are kept as typed, never turned into a link.
	it.each([
		['https://vgen.co/taro/commission/9', 'https://vgen.co/taro/commission/9'],
		['vgen.co/taro', 'https://vgen.co/taro'],
		['  Telegram DM  ', 'Telegram DM'],
		['Telegram', 'Telegram'],
		['DM on t.me/taro', 'DM on t.me/taro'],
		['javascript:alert(1)', 'javascript:alert(1)'],
		[`Telegram ${'x'.repeat(111)}`, `Telegram ${'x'.repeat(111)}`]
	])('stores where it is happening %j as %j', async (sent, stored) => {
		const { sqlite, platform } = ledgerDb();
		expect((await create(platform, entryForm({ sourceUrl: sent }))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT source_url FROM commissions')).toEqual([{ source_url: stored }]);
	});

	it.each([
		['https://ko-fi.com/s/0a1b2c', 'https://ko-fi.com/s/0a1b2c'],
		['ko-fi.com/s/0a1b2c', 'https://ko-fi.com/s/0a1b2c'],
		['', null]
	])('stores the receipt link %j as %j', async (sent, stored) => {
		const { sqlite, platform } = ledgerDb();
		expect((await create(platform, entryForm({ receiptUrl: sent }))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT receipt_url FROM commissions')).toEqual([{ receipt_url: stored }]);
	});

	it('stores no price and no currency when the amount is empty but a currency is picked', async () => {
		const { sqlite, platform } = ledgerDb();
		const result = await create(platform, entryForm({ price: '', currency: 'EUR' }));
		expect(result.status).toBe('redirected');
		expect(rows(sqlite, 'SELECT price_minor, currency FROM commissions')).toEqual([{ price_minor: null, currency: null }]);
	});

	it('takes the Other currency select when the row has Other currency picked, as it does without JavaScript', async () => {
		const { sqlite, platform } = ledgerDb();
		const form = entryForm({ price: '1200', currency: '__other' });
		form.set('currencyOther', 'krw');
		expect((await create(platform, form)).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT price_minor, currency FROM commissions')).toEqual([{ price_minor: 1200, currency: 'KRW' }]);
	});

	it('asks which currency was meant when a row pick and a different Other currency pick arrive together', async () => {
		// Without JavaScript, a row radio stays picked while the owner chooses
		// in the select; the form can't say which one they meant.
		const { sqlite, platform } = ledgerDb();
		const form = entryForm({ price: '12', currency: 'USD' });
		form.set('currencyOther', 'jpy');
		const result = await create(platform, form);
		expect(result.status).toBe(400);
		expect(result.data.errors).toEqual({
			currency: 'You picked USD and also chose JPY under Other currency. To use JPY, pick Other currency and choose JPY again. To use USD, save again.'
		});
		expect(result.data.values).toMatchObject({ price: '12', currency: 'USD' });
		expect(ledgerSnapshot(sqlite)).toEqual({ commissions: [], links: [] });
	});

	it('saves a row pick when the Other currency select names the same code', async () => {
		const { sqlite, platform } = ledgerDb();
		const form = entryForm({ price: '12', currency: 'USD' });
		form.set('currencyOther', 'usd');
		expect((await create(platform, form)).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT price_minor, currency FROM commissions')).toEqual([{ price_minor: 1200, currency: 'USD' }]);
	});

	it('links the new entry, not an older one, when entries already exist', async () => {
		const { sqlite, platform } = ledgerDb();
		await create(platform, entryForm({ title: 'First', characterId: ['1'] }));
		await create(platform, entryForm({ title: 'Second', characterId: ['2'] }));
		expect(
			rows(
				sqlite,
				'SELECT c.title, cc.character_id FROM commission_characters cc JOIN commissions c ON c.id = cc.commission_id ORDER BY c.id'
			)
		).toEqual([
			{ title: 'First', character_id: 1 },
			{ title: 'Second', character_id: 2 }
		]);
	});

	it('links 120 characters to one entry under the 100-parameter cap', async () => {
		const { sqlite, platform } = ledgerDb();
		const insert = sqlite.prepare("INSERT INTO characters (name, created_at) VALUES (?, '2026-10-01')");
		const ids: string[] = [];
		for (let i = 0; i < 120; i++) ids.push(String(insert.run(`C${i}`).lastInsertRowid));
		expect((await create(platform, entryForm({ characterId: ids }))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT COUNT(*) AS n FROM commission_characters')).toEqual([{ n: 120 }]);
	});
});

describe('create action: bad input', () => {
	beforeEach(() => setLedgerGa('past'));

	// Each case: the overrides, and the field that must carry the error.
	const cases: [string, Record<string, string | string[] | undefined>, string][] = [
		['unknown status', { status: 'finished' }, 'status'],
		['unknown payment', { payment: 'half' }, 'payment'],
		['price without currency', { price: '60', currency: '' }, 'currency'],
		['malformed currency XYZ1', { price: '30', currency: 'XYZ1' }, 'currency'],
		['decimals in JPY', { price: '45.5', currency: 'JPY' }, 'price'],
		['three decimals in USD', { price: '45.505', currency: 'USD' }, 'price'],
		['price that is not a number', { price: 'forty', currency: 'USD' }, 'price'],
		['missing title', { title: '   ' }, 'title'],
		['title over 120 characters', { title: 'x'.repeat(121) }, 'title'],
		['kind over 60 characters', { kind: 'x'.repeat(61) }, 'kind'],
		['notes over 2,000 characters', { notes: 'x'.repeat(2001) }, 'notes'],
		['impossible date', { requestedOn: '2026-02-30' }, 'requestedOn'],
		['date in another shape', { acceptedOn: '10/14/2026' }, 'acceptedOn'],
		['not a date', { deliveredOn: 'soon' }, 'deliveredOn'],
		['link over 2,048 characters', { sourceUrl: `https://example.com/${'a'.repeat(2048)}` }, 'sourceUrl'],
		['plain text over 120 characters', { sourceUrl: `Telegram ${'x'.repeat(112)}` }, 'sourceUrl'],
		['receipt that is plain text', { receiptUrl: 'Ko-fi order' }, 'receiptUrl'],
		['script receipt link', { receiptUrl: 'javascript:alert(1)' }, 'receiptUrl'],
		['receipt link over 2,048 characters', { receiptUrl: `https://ko-fi.com/${'a'.repeat(2048)}` }, 'receiptUrl'],
		['no artist', { artistId: '' }, 'artistId'],
		['artist id that is not a number', { artistId: 'abc' }, 'artistId'],
		['unknown artist', { artistId: '99' }, 'artistId'],
		['unknown character', { characterId: ['1', '99'] }, 'characterIds'],
		['character id that is not a number', { characterId: ['x'] }, 'characterIds']
	];

	for (const [name, overrides, field] of cases) {
		it(`refuses ${name} with 400 on ${field}, and writes nothing`, async () => {
			const { sqlite, platform } = ledgerDb();
			const result = await create(platform, entryForm(overrides));
			expect(result.status).toBe(400);
			expect(Object.keys(result.data.errors as object)).toEqual([field]);
			expect(ledgerSnapshot(sqlite)).toEqual({ commissions: [], links: [] });
		});
	}

	it('counts a CRLF line break as one character and stores it as LF', async () => {
		// Browsers send textarea line breaks as CRLF. A note the textarea's
		// maxlength allowed must not be refused for the extra carriage returns.
		const { sqlite, platform } = ledgerDb();
		const line = 'x'.repeat(99);
		const typed = Array.from({ length: 20 }, () => line).join('\n'); // 1,999 characters
		const sent = typed.replaceAll('\n', '\r\n') + 'y';
		expect(typed.length + 1).toBe(2000);
		expect((await create(platform, entryForm({ notes: sent }))).status).toBe('redirected');
		expect(rows(sqlite, 'SELECT notes FROM commissions')).toEqual([{ notes: typed + 'y' }]);
	});

	it('accepts a title of exactly 120 characters', async () => {
		const { platform } = ledgerDb();
		expect((await create(platform, entryForm({ title: 'x'.repeat(120) }))).status).toBe('redirected');
	});

	it('sends back what was typed, trimmed, so a save without JavaScript keeps it', async () => {
		const { platform } = ledgerDb();
		const result = await create(
			platform,
			entryForm({
				title: '  Kept title ',
				notes: 'Line one\r\nline two',
				price: '45.5',
				currency: 'JPY',
				characterId: ['1', 'x'],
				receiptUrl: ' ko-fi.com/s/0a1b2c '
			})
		);
		expect(result.status).toBe(400);
		expect(result.data.values).toEqual({
			artistId: '1',
			title: 'Kept title',
			kind: 'Ref sheet',
			sourceUrl: 'https://t.me/artist_a/412',
			characterIds: [1],
			status: 'applied',
			payment: 'unpaid',
			receiptUrl: 'ko-fi.com/s/0a1b2c',
			price: '45.5',
			currency: 'JPY',
			notes: 'Line one\nline two',
			requestedOn: '2026-10-02',
			acceptedOn: '',
			deliveredOn: ''
		});
	});

	it('sends back what was typed when the artist is unknown', async () => {
		const { platform } = ledgerDb();
		const result = await create(platform, entryForm({ artistId: '99' }));
		expect(result.status).toBe(400);
		expect(result.data.values).toMatchObject({ artistId: '99', title: 'Ref sheet update' });
	});

	it('names every bad field at once', async () => {
		const { platform } = ledgerDb();
		const result = await create(platform, entryForm({ title: '', status: 'nope', price: '1', currency: '' }));
		expect(result.status).toBe(400);
		expect(Object.keys(result.data.errors as object).sort()).toEqual(['currency', 'status', 'title']);
	});
});
