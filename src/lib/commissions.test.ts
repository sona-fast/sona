import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { commissions } from '$lib/server/db/schema';
import {
	COMMISSION_PAYMENTS,
	COMMISSION_STATUSES,
	PAYMENT_LABELS,
	STATUS_LABELS,
	commissionDateRows,
	datesAfterStatusChange,
	formatMinor,
	isActiveStatus,
	isCalendarDate,
	localToday,
	parsePrice
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
		expect(parsePrice('45.50', 'USD')).toEqual({ ok: true, minor: 4550 });
		expect(parsePrice('45.5', 'USD')).toEqual({ ok: true, minor: 4550 });
		expect(parsePrice('45', 'USD')).toEqual({ ok: true, minor: 4500 });
		expect(parsePrice('45', 'JPY')).toEqual({ ok: true, minor: 45 });
		expect(parsePrice('1.234', 'BHD')).toEqual({ ok: true, minor: 1234 });
		expect(parsePrice('0.10', 'EUR')).toEqual({ ok: true, minor: 10 });
	});

	it('refuses decimals the currency does not have, rather than rounding', () => {
		expect(parsePrice('45.5', 'JPY')).toEqual({ ok: false, reason: 'decimals', digits: 0 });
		expect(parsePrice('45.505', 'USD')).toEqual({ ok: false, reason: 'decimals', digits: 2 });
	});

	it('refuses anything that is not a plain number', () => {
		for (const value of ['', '45.', '.5', '-1', '1e3', '4,500', '45 USD', '1234567890123']) {
			expect(parsePrice(value, 'USD'), value).toEqual({ ok: false, reason: 'format' });
		}
	});

	it('refuses a malformed currency code', () => {
		expect(parsePrice('30', 'XYZ1')).toEqual({ ok: false, reason: 'format' });
		expect(parsePrice('30', 'usd')).toEqual({ ok: false, reason: 'format' });
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
			expect(parsePrice(formatMinor(minor, currency), currency)).toEqual({ ok: true, minor });
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
