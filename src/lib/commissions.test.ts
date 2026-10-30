import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { commissions } from '$lib/server/db/schema';
import {
	COMMISSION_PAYMENTS,
	COMMISSION_STATUSES,
	PAYMENT_LABELS,
	STATUS_LABELS,
	changedFields,
	commissionDateRows,
	datesAfterStatusChange,
	formValuesOf,
	formatMinor,
	mergeReloaded,
	staleMessage,
	isActiveStatus,
	isCalendarDate,
	localToday,
	parsePrice,
	sourceLinkHref
} from './commissions';

const messages = (locale: 'en' | 'ja') =>
	JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf-8')) as Record<
		string,
		string
	>;

describe('client-safe enum copies', () => {
	// The browser can't import schema.ts, so these are copies. A value added to
	// the schema but not here would be refused by the form and missing a label.
	it('match the schema enums exactly, in order', () => {
		expect([...COMMISSION_STATUSES]).toEqual(commissions.status.enumValues);
		expect([...COMMISSION_PAYMENTS]).toEqual(commissions.payment.enumValues);
	});

	it('label every status and payment in both locales', () => {
		for (const locale of ['en', 'ja'] as const) {
			const catalog = messages(locale);
			for (const status of COMMISSION_STATUSES) {
				const text = STATUS_LABELS[status]({}, { locale });
				expect(text, `${locale} ${status}`).toBe(catalog[`admin_commissions_status_${status}`]);
			}
			for (const payment of COMMISSION_PAYMENTS) {
				const text = PAYMENT_LABELS[payment]({}, { locale });
				expect(text, `${locale} ${payment}`).toBe(catalog[`admin_commissions_payment_${payment}`]);
			}
		}
	});
});

describe('isActiveStatus', () => {
	it('splits the ledger into active and finished as the design doc lists them', () => {
		expect(COMMISSION_STATUSES.filter(isActiveStatus)).toEqual(['applied', 'waitlisted', 'accepted', 'in_progress']);
		expect(COMMISSION_STATUSES.filter((s) => !isActiveStatus(s))).toEqual(['not_picked', 'delivered', 'cancelled']);
	});
});

describe('datesAfterStatusChange', () => {
	const empty = { requestedOn: '2026-10-02', acceptedOn: '', deliveredOn: '' };

	it("fills today's date for Accepted and Delivered when that date is empty", () => {
		expect(datesAfterStatusChange('accepted', empty, '2026-10-14')).toEqual({ ...empty, acceptedOn: '2026-10-14' });
		expect(datesAfterStatusChange('delivered', empty, '2026-10-14')).toEqual({ ...empty, deliveredOn: '2026-10-14' });
	});

	it('keeps a date the owner already set', () => {
		const set = { ...empty, acceptedOn: '2026-10-05' };
		expect(datesAfterStatusChange('accepted', set, '2026-10-14')).toEqual(set);
	});

	it('fills nothing for the other statuses', () => {
		for (const status of ['applied', 'waitlisted', 'not_picked', 'in_progress', 'cancelled'] as const) {
			expect(datesAfterStatusChange(status, empty, '2026-10-14'), status).toEqual(empty);
		}
	});
});

describe('localToday', () => {
	it('uses the local calendar date, zero-padded', () => {
		expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
	});
});

describe('isCalendarDate', () => {
	it('accepts real dates, including a leap day', () => {
		expect(isCalendarDate('2026-10-14')).toBe(true);
		expect(isCalendarDate('2028-02-29')).toBe(true);
	});

	it('refuses impossible dates and other shapes', () => {
		for (const value of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '20261014', 'today', '2026-10-14T00:00']) {
			expect(isCalendarDate(value), value).toBe(false);
		}
	});
});

describe('parsePrice', () => {
	it('stores prices in minor units with the currency’s own digit count', () => {
		expect(parsePrice('45.50', 'USD', 'en')).toEqual({ ok: true, minor: 4550 });
		expect(parsePrice('45.5', 'USD', 'en')).toEqual({ ok: true, minor: 4550 });
		expect(parsePrice('45', 'USD', 'en')).toEqual({ ok: true, minor: 4500 });
		expect(parsePrice('45', 'JPY', 'en')).toEqual({ ok: true, minor: 45 });
		expect(parsePrice('1.234', 'BHD', 'en')).toEqual({ ok: true, minor: 1234 });
		expect(parsePrice('0.10', 'EUR', 'en')).toEqual({ ok: true, minor: 10 });
	});

	it('refuses decimals the currency does not have, rather than rounding', () => {
		expect(parsePrice('45.5', 'JPY', 'en')).toEqual({ ok: false, reason: 'decimals', digits: 0 });
		expect(parsePrice('45.505', 'USD', 'en')).toEqual({ ok: false, reason: 'decimals', digits: 2 });
	});

	it('refuses anything that is not a plain number', () => {
		for (const value of ['', '45.', '.5', '-1', '1e3', '45 USD', '1234567890123']) {
			expect(parsePrice(value, 'USD', 'en'), value).toEqual({ ok: false, reason: 'format' });
		}
	});

	it('refuses a price too large to store exactly, rather than rounding it', () => {
		// CLF uses four minor digits, so twelve whole digits make a 16-digit integer.
		expect(parsePrice('999999999999.9999', 'CLF', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('999999999999.99', 'USD', 'en')).toEqual({ ok: true, minor: 99999999999999 });
	});

	it('refuses a malformed currency code', () => {
		expect(parsePrice('30', 'XYZ1', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('30', 'usd', 'en')).toEqual({ ok: false, reason: 'format' });
	});

	it('reads full-width digits and punctuation as their ASCII forms', () => {
		expect(parsePrice('４５．５０', 'USD', 'en')).toEqual({ ok: true, minor: 4550 });
		expect(parsePrice('４５', 'JPY', 'ja')).toEqual({ ok: true, minor: 45 });
		expect(parsePrice('１，２３４', 'JPY', 'ja')).toEqual({ ok: true, minor: 1234 });
		expect(parsePrice('１，２３４．５', 'USD', 'ja')).toEqual({ ok: true, minor: 123450 });
	});

	it('reads spaces, NBSP, narrow NBSP, and apostrophes as grouping', () => {
		for (const value of ['1 000', '1 000', '1 000', "1'000", '1’000', '１　０００']) {
			expect(parsePrice(value, 'JPY', 'en'), value).toEqual({ ok: true, minor: 1000 });
		}
		expect(parsePrice("1'234'567.50", 'USD', 'en')).toEqual({ ok: true, minor: 123456750 });
		expect(parsePrice('1 234,50', 'EUR', 'en')).toEqual({ ok: true, minor: 123450 });
		// Grouping only ever groups: never a decimal, even before two digits.
		expect(parsePrice('45 50', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice("45'5", 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
	});

	it('with both "," and ".", reads the last as the decimal and the other as grouping', () => {
		expect(parsePrice('1,234.50', 'USD', 'en')).toEqual({ ok: true, minor: 123450 });
		expect(parsePrice('1.234,50', 'USD', 'en')).toEqual({ ok: true, minor: 123450 });
		expect(parsePrice('1,234,567.5', 'USD', 'de')).toEqual({ ok: true, minor: 123456750 });
		expect(parsePrice('1.234.567,5', 'USD', 'ja')).toEqual({ ok: true, minor: 123456750 });
		// The decimal kind appears once, after every group, and groups are threes.
		expect(parsePrice('1.234.50', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('1,234.5,0', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('12,34.50', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('1,2345.50', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
		// Mixed grouping characters are refused rather than guessed at.
		expect(parsePrice('1 000,000.50', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
	});

	it('reads one kind of separator appearing more than once as grouping in threes', () => {
		for (const locale of ['en', 'ja', 'de']) {
			expect(parsePrice('1,000,000', 'JPY', locale), locale).toEqual({ ok: true, minor: 1000000 });
			expect(parsePrice('1.000.000', 'JPY', locale), locale).toEqual({ ok: true, minor: 1000000 });
			for (const value of ['1,00,0', '1,00,000', '1.0000.000', '1234,567,890', '1,000,00']) {
				expect(parsePrice(value, 'JPY', locale), `${value} ${locale}`).toEqual({ ok: false, reason: 'format' });
			}
		}
	});

	it('reads a lone separator before exactly three digits by the locale’s group separator', () => {
		// en and ja group with ",", so 1,000 is a thousand and 1.000 is one.
		for (const locale of ['en', 'ja']) {
			expect(parsePrice('1,000', 'JPY', locale), locale).toEqual({ ok: true, minor: 1000 });
			expect(parsePrice('1.000', 'JPY', locale), locale).toEqual({ ok: false, reason: 'decimals', digits: 0 });
			expect(parsePrice('1.000', 'BHD', locale), locale).toEqual({ ok: true, minor: 1000 });
		}
		// de groups with ".", so the reading flips.
		expect(parsePrice('1.000', 'JPY', 'de')).toEqual({ ok: true, minor: 1000 });
		expect(parsePrice('1,000', 'JPY', 'de')).toEqual({ ok: false, reason: 'decimals', digits: 0 });
		expect(parsePrice('1,000', 'BHD', 'de')).toEqual({ ok: true, minor: 1000 });
		// A lone group separator still needs a valid first group.
		expect(parsePrice('1234,567', 'JPY', 'en')).toEqual({ ok: false, reason: 'format' });
	});

	it('reads a lone separator before any other count of digits as the decimal', () => {
		for (const locale of ['en', 'ja', 'de']) {
			expect(parsePrice('45,50', 'USD', locale), locale).toEqual({ ok: true, minor: 4550 });
			expect(parsePrice('45.5', 'USD', locale), locale).toEqual({ ok: true, minor: 4550 });
			expect(parsePrice('45,5', 'JPY', locale), locale).toEqual({ ok: false, reason: 'decimals', digits: 0 });
			expect(parsePrice('1,2345', 'USD', locale), locale).toEqual({ ok: false, reason: 'decimals', digits: 2 });
		}
	});

	it('keeps the twelve-digit limit after grouping is removed', () => {
		expect(parsePrice('999,999,999,999.99', 'USD', 'en')).toEqual({ ok: true, minor: 99999999999999 });
		expect(parsePrice('1,234,567,890,123', 'USD', 'en')).toEqual({ ok: false, reason: 'format' });
	});

	it('refuses junk, negatives, and stray separators in any locale', () => {
		for (const locale of ['en', 'ja', 'de']) {
			for (const value of [
				'',
				' ',
				'-1',
				'−1',
				'－４５',
				'+45',
				'$45',
				'45€',
				'4 5x',
				'1,,000',
				'1..5',
				'1, 000',
				',5',
				'45,',
				"'1000",
				'1e3',
				'0x10',
				'４５円'
			]) {
				expect(parsePrice(value, 'USD', locale), `${JSON.stringify(value)} ${locale}`).toEqual({ ok: false, reason: 'format' });
			}
		}
	});
});

describe('formatMinor', () => {
	it('turns minor units back into the typed form', () => {
		expect(formatMinor(4550, 'USD')).toBe('45.50');
		expect(formatMinor(5, 'USD')).toBe('0.05');
		expect(formatMinor(45, 'JPY')).toBe('45');
		expect(formatMinor(1234, 'BHD')).toBe('1.234');
	});

	it('round-trips through parsePrice', () => {
		for (const [minor, currency] of [[4550, 'USD'], [7, 'EUR'], [12000, 'JPY'], [1, 'BHD']] as const) {
			expect(parsePrice(formatMinor(minor, currency), currency, 'en')).toEqual({ ok: true, minor });
		}
	});
});

describe('commissionDateRows (SONA-9)', () => {
	it('shows two set dates as plain dates, with no day count or relative time', () => {
		const shown = commissionDateRows({ requestedOn: '2026-09-03', acceptedOn: null, deliveredOn: '2026-10-08' });
		expect(shown).toEqual([
			{ label: 'Requested', value: '2026.09.03' },
			{ label: 'Delivered', value: '2026.10.08' }
		]);
		// 35 days apart. No row may say so in any form.
		const text = shown.map((r) => `${r.label} ${r.value}`).join(' ');
		expect(text).not.toMatch(/\b35\b|days?|weeks?|months?|ago|since|elapsed|duration|took/i);
	});

	it('shows nothing for an entry without dates', () => {
		expect(commissionDateRows({ requestedOn: null, acceptedOn: null, deliveredOn: null })).toEqual([]);
	});
});

const ENTRY = {
	artistId: 1,
	title: 'Headshot icon',
	kind: 'Icon',
	sourceUrl: 'https://t.me/artist_a/412',
	characters: [{ id: 1 }, { id: 2 }],
	status: 'in_progress' as const,
	payment: 'paid' as const,
	receiptUrl: 'https://ko-fi.com/s/0a1b2c',
	price: '45.00',
	currency: 'USD',
	notes: 'Transparent background.',
	requestedOn: '2026-09-03',
	acceptedOn: '2026-09-05',
	deliveredOn: null
};

describe('changedFields', () => {
	const loaded = formValuesOf(ENTRY);

	it('finds nothing when nothing changed, or only the note did', () => {
		expect(changedFields(loaded, { ...loaded })).toEqual([]);
		expect(changedFields(loaded, { ...loaded, notes: 'New note' })).toEqual([]);
	});

	it('names the fields besides Notes, in form order', () => {
		expect(changedFields(loaded, { ...loaded, price: '50.00', notes: 'x', status: 'delivered' })).toEqual([
			'status',
			'price'
		]);
	});

	it('names a changed receipt link after Payment, in form order', () => {
		expect(changedFields(loaded, { ...loaded, receiptUrl: '', price: '50.00', payment: 'refunded' })).toEqual([
			'payment',
			'receiptUrl',
			'price'
		]);
		expect(staleMessage(loaded, { ...loaded, receiptUrl: '' }, 'en')).toMatch(/your changes to Receipt or order link,/);
	});

	it('compares characters as a set', () => {
		expect(changedFields(loaded, { ...loaded, characterIds: [2, 1] })).toEqual([]);
		expect(changedFields(loaded, { ...loaded, characterIds: [2] })).toEqual(['characterIds']);
	});
});

describe('staleMessage', () => {
	const loaded = formValuesOf(ENTRY);
	const head = "This entry wasn't saved because it changed after you opened it. Select Reload entry to get the latest version.";

	it('says only what happened when nothing was changed', () => {
		expect(staleMessage(loaded, { ...loaded }, 'en')).toBe(head);
	});

	it('says the note comes along when only the note changed', () => {
		expect(staleMessage(loaded, { ...loaded, notes: 'New' }, 'en')).toBe(`${head} Your note comes with it.`);
	});

	it('names the other fields the reload drops', () => {
		expect(staleMessage(loaded, { ...loaded, notes: 'New', title: 'T', price: '1' }, 'en')).toBe(
			`${head} Your note comes with it, but your changes to Title and Price don't, so enter those again.`
		);
		expect(staleMessage(loaded, { ...loaded, sourceUrl: '' }, 'en')).toBe(
			`${head} Reloading doesn't keep your changes to Where it's happening, so enter those again.`
		);
	});

	const headJa = 'このエントリーは開いた後に変更されたため、保存されませんでした。「エントリーを再読み込み」を選ぶと最新の内容を取得できます。';

	it('runs the Japanese sentences together, with no space between them', () => {
		expect(staleMessage(loaded, { ...loaded, notes: 'New' }, 'ja')).toBe(`${headJa}メモはそのまま引き継がれます。`);
	});

	it('names the dropped fields in Japanese, with and without a note change', () => {
		expect(staleMessage(loaded, { ...loaded, payment: 'unpaid' }, 'ja')).toBe(
			`${headJa}再読み込みすると支払いの変更は失われるため、もう一度入力してください。`
		);
		expect(staleMessage(loaded, { ...loaded, notes: 'New', title: 'T', price: '1' }, 'ja')).toBe(
			`${headJa}メモは引き継がれますが、タイトル、価格の変更は引き継がれないため、もう一度入力してください。`
		);
	});
});

describe('mergeReloaded', () => {
	const loadedNote = 'Transparent background.';
	const fresh = formValuesOf({ ...ENTRY, status: 'delivered', deliveredOn: '2026-10-12' });

	it('takes the current entry as is when the owner left the note alone', () => {
		expect(mergeReloaded(fresh, loadedNote, loadedNote)).toEqual({ values: fresh, restoredNote: '' });
	});

	it('puts the typed note back over the current entry', () => {
		const { values, restoredNote } = mergeReloaded(fresh, loadedNote, 'Artist posted it, so I can share it.');
		expect(values).toEqual({ ...fresh, notes: 'Artist posted it, so I can share it.' });
		expect(restoredNote).toBe('kept');
	});

	it("says 'replaces' when the other change also edited the note", () => {
		const edited = { ...fresh, notes: 'Edited elsewhere.' };
		const { values, restoredNote } = mergeReloaded(edited, loadedNote, 'Typed here.');
		expect(values.notes).toBe('Typed here.');
		expect(values.status).toBe('delivered');
		expect(restoredNote).toBe('replaces');
	});
});

describe('sourceLinkHref', () => {
	it('reads a web address as a link, with or without its https://', () => {
		expect(sourceLinkHref('https://vgen.co/taro/commission/9')).toBe('https://vgen.co/taro/commission/9');
		expect(sourceLinkHref('  http://example.com/a  ')).toBe('http://example.com/a');
		expect(sourceLinkHref('bsky.app/profile/taro.bsky.social')).toBe('https://bsky.app/profile/taro.bsky.social');
	});

	it('reads the owner’s own words as text, not a link', () => {
		for (const value of ['Telegram DM', 'Telegram', 'DM on t.me/taro', 'https://x.com/a and then Telegram', 'テレグラムのDM', '']) {
			expect(sourceLinkHref(value)).toBeNull();
		}
	});

	it('never makes a link from a script, data, or other non-web scheme', () => {
		for (const value of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'tg://resolve?domain=taro', 'mailto:a@b.co']) {
			expect(sourceLinkHref(value)).toBeNull();
		}
	});

	it('reads an email address, an @handle, or a word ending in a period as text', () => {
		for (const value of [
			'artist@gmail.com',
			'orders@ko-fi.com',
			'https://artist@gmail.com',
			'@artist.bsky.social',
			'Telegram.',
			'DMs.',
			'vgen.co.',
			'192.168.1.10',
			'v1.2'
		]) {
			expect(sourceLinkHref(value)).toBeNull();
		}
	});

	it('still reads an @ in the path, an idn host, and a port as a link', () => {
		expect(sourceLinkHref('bsky.app/profile/@taro')).toBe('https://bsky.app/profile/@taro');
		expect(sourceLinkHref('https://example.xn--p1ai/a')).toBe('https://example.xn--p1ai/a');
		expect(sourceLinkHref('https://vgen.co:443/taro')).toBe('https://vgen.co/taro');
	});

	it('takes nothing from a missing value', () => {
		expect(sourceLinkHref(null)).toBeNull();
		expect(sourceLinkHref(undefined)).toBeNull();
	});
});
