import { describe, expect, it } from 'vitest';
import { currencyRow, currencySymbol, findCurrencies, initialCurrency, knownCurrencies, localeCurrency } from './currencies';

describe('localeCurrency', () => {
	it('reads the region of an Accept-Language header', () => {
		expect(localeCurrency('en-GB,en;q=0.9')).toBe('GBP');
		expect(localeCurrency('de-DE')).toBe('EUR');
		expect(localeCurrency('ja-JP,ja;q=0.9,en;q=0.8')).toBe('JPY');
		expect(localeCurrency('en-US')).toBe('USD');
	});

	it("takes the first region among tags in the first tag's language", () => {
		expect(localeCurrency('en,fr-CA;q=0.8,en-GB;q=0.5')).toBe('GBP');
		expect(localeCurrency('en,en-GB')).toBe('GBP');
		expect(localeCurrency('zh-Hant,zh-Hant-TW')).toBe('TWD');
	});

	it("never takes a region from a lower-priority language's tag", () => {
		expect(localeCurrency('ja,en-US;q=0.9,en;q=0.8')).toBeNull();
		expect(localeCurrency('de,en-US;q=0.7')).toBeNull();
		expect(localeCurrency('*,en-US')).toBeNull();
		expect(localeCurrency('en_US,en-GB')).toBeNull();
	});

	it('gives nothing when no tag says where the owner is', () => {
		expect(localeCurrency('en')).toBeNull();
		expect(localeCurrency('*')).toBeNull();
		expect(localeCurrency('not a tag!!, ;;')).toBeNull();
		expect(localeCurrency('es-419')).toBeNull();
		expect(localeCurrency('en-AQ')).toBeNull();
		expect(localeCurrency('')).toBeNull();
		expect(localeCurrency(null)).toBeNull();
	});
});

describe('currencyRow', () => {
	it('leads the common currencies with the regional one when nothing is saved', () => {
		expect(currencyRow({ recent: [], localeCurrency: 'CAD' })).toEqual(['CAD', 'USD', 'EUR', 'GBP']);
		expect(currencyRow({ recent: [], localeCurrency: 'GBP' })).toEqual(['GBP', 'USD', 'EUR', 'JPY']);
	});

	it('falls back to USD, EUR, GBP and JPY with no region', () => {
		expect(currencyRow({ recent: [], localeCurrency: null })).toEqual(['USD', 'EUR', 'GBP', 'JPY']);
	});

	it('shows saved currencies by last use once there are any', () => {
		expect(currencyRow({ recent: ['EUR', 'KRW'], localeCurrency: 'GBP' })).toEqual(['EUR', 'KRW']);
	});

	it("puts the entry's own currency first, even a rarely used one, and keeps four", () => {
		expect(
			currencyRow({ entryCurrency: 'KRW', recent: ['USD', 'EUR', 'JPY', 'GBP'], localeCurrency: null })
		).toEqual(['KRW', 'USD', 'EUR', 'JPY']);
		expect(currencyRow({ entryCurrency: 'EUR', recent: ['USD', 'EUR'], localeCurrency: null })).toEqual([
			'EUR',
			'USD'
		]);
	});

	it("keeps an entry's own code even when Intl does not list it", () => {
		expect(currencyRow({ entryCurrency: 'ZZZ', recent: ['EUR'], localeCurrency: null })).toEqual(['ZZZ', 'EUR']);
	});

	it('drops codes Intl does not know', () => {
		expect(currencyRow({ recent: ['ZZZ', 'usd', 'EUR'], localeCurrency: null })).toEqual(['EUR']);
	});
});

describe('initialCurrency', () => {
	it('opens a new entry on the most recent currency, then the regional one', () => {
		expect(initialCurrency({ recent: ['EUR', 'USD'], localeCurrency: 'GBP' })).toBe('EUR');
		expect(initialCurrency({ recent: [], localeCurrency: 'GBP' })).toBe('GBP');
	});
	it('picks nothing with nothing to go on', () => {
		expect(initialCurrency({ recent: [], localeCurrency: null })).toBe('');
	});
});

describe('currencySymbol', () => {
	it("gives a currency's own symbol", () => {
		expect(currencySymbol('USD', 'en')).toBe('$');
		expect(currencySymbol('JPY', 'en')).toBe('¥');
	});
	it('gives nothing when the locale prints the code, so the code shows once', () => {
		expect(currencySymbol('CHF', 'en')).toBeNull();
		expect(currencySymbol('CHF', 'en', 'symbol')).toBeNull();
	});
	it('tells dollars apart in the search list', () => {
		expect(currencySymbol('AUD', 'en', 'symbol')).toBe('A$');
		expect(currencySymbol('AUD', 'en')).toBe('$');
	});
	it('gives nothing for a code that is not a currency', () => {
		expect(currencySymbol('not', 'en')).toBeNull();
	});
});

describe('findCurrencies', () => {
	const all = knownCurrencies();
	const namer = (locale: string) => {
		const names = new Intl.DisplayNames([locale], { type: 'currency' });
		return (code: string) => names.of(code) ?? code;
	};
	const find = (query: string, locale = 'en') => findCurrencies(all, query, locale, namer(locale));
	// The search before symbols counted: the code or the name contains the query.
	const byText = (query: string, locale = 'en') => {
		const q = query.trim().toLocaleLowerCase(locale);
		const nameOf = namer(locale);
		return all.filter((code) => code.toLowerCase().includes(q) || nameOf(code).toLocaleLowerCase(locale).includes(q));
	};

	it('finds EUR first for €', () => {
		expect(find('€')[0]).toBe('EUR');
		expect(find(' € ')[0]).toBe('EUR');
	});

	it('lists USD first for $, then the other dollars', () => {
		const found = find('$');
		expect(found[0]).toBe('USD');
		expect(found).toEqual(expect.arrayContaining(['AUD', 'CAD', 'NZD']));
		expect(found.indexOf('USD')).toBeLessThan(found.indexOf('AUD'));
	});

	it('finds JPY then CNY for ¥, and the full-width ￥ the same way', () => {
		expect(find('¥').slice(0, 2)).toEqual(['JPY', 'CNY']);
		expect(find('￥').slice(0, 2)).toEqual(['JPY', 'CNY']);
		expect(find('¥', 'ja')).toContain('JPY');
	});

	it('finds a symbol of its own as typed, such as A$', () => {
		expect(find('A$')[0]).toBe('AUD');
		expect(find('ca$')[0]).toBe('CAD');
	});

	it('finds codes and names exactly as before when the query is no symbol', () => {
		for (const query of ['dollar', 'eu', 'JP', 'yen', 'krona']) expect(find(query)).toEqual(byText(query));
		for (const query of ['円', 'ドル']) expect(find(query, 'ja')).toEqual(byText(query, 'ja'));
	});

	it('finds every currency, in order, for an empty query', () => {
		expect(find('')).toEqual(all);
		expect(find('   ')).toEqual(all);
	});
});
