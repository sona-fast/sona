import { describe, it, expect } from 'vitest';
import { BREAKDOWN_KINDS } from '$lib/server/storage/usage-breakdown';
import * as m from '$lib/paraglide/messages';
import { breakdownRows, sharePct } from './storage-breakdown-view';

describe('sharePct', () => {
	// Two-tier precision on purpose (approved-mock rendering): whole percents
	// from 1%, one decimal below it. Do not collapse to a single rounding rule.
	it('renders zero and empty totals as a plain 0%', () => {
		expect(sharePct(0, 0)).toBe('0%');
		expect(sharePct(0, 100)).toBe('0%');
	});

	it('renders whole percents from 1% up', () => {
		expect(sharePct(1, 100)).toBe('1%');
		expect(sharePct(50, 100)).toBe('50%');
	});

	it('keeps one decimal below 1% so tiny kinds stay visible', () => {
		expect(sharePct(4, 1000)).toBe('0.4%');
	});
});

describe('breakdownRows', () => {
	it('covers every breakdown kind, in the fixed order', () => {
		// The bar's segment order is locked to the row order (WCAG 1.4.1); a kind
		// added server-side without a row here would silently drop from the table.
		expect(breakdownRows.map((r) => r.kind)).toEqual([...BREAKDOWN_KINDS]);
	});
});

describe('admin_settings_breakdown_file_count', () => {
	// The count is passed as a raw number (not toLocaleString'd): the ICU plural
	// selector needs a number to pick a category — a formatted string would
	// select 'other' for everything.
	it('pluralizes the file count in English', () => {
		expect(m.admin_settings_breakdown_file_count({ count: 1 })).toBe('1 file');
		expect(m.admin_settings_breakdown_file_count({ count: 2 })).toBe('2 files');
		expect(m.admin_settings_breakdown_file_count({ count: 0 })).toBe('0 files');
	});
});
