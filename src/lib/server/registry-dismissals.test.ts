import { describe, it, expect } from 'vitest';
import { parseDismissed, addDismissed } from './registry-dismissals';

describe('parseDismissed', () => {
	it('reads a stored id array', () => {
		expect(parseDismissed('[1,2,3]')).toEqual(new Set([1, 2, 3]));
	});
	it('returns empty for null/garbage/non-array', () => {
		expect(parseDismissed(null).size).toBe(0);
		expect(parseDismissed('not json').size).toBe(0);
		expect(parseDismissed('{"a":1}').size).toBe(0);
	});
	it('drops non-number entries', () => {
		expect(parseDismissed('[1,"x",2,null]')).toEqual(new Set([1, 2]));
	});
});

describe('addDismissed — the dismiss state transition', () => {
	it('adds an id (idempotently)', () => {
		expect(addDismissed(new Set([1]), 2)).toEqual([1, 2]);
		expect(addDismissed(new Set([1, 2]), 2)).toEqual([1, 2]);
	});

	it('a rejected submission is filtered out once dismissed', () => {
		const rejected = { id: 42, status: 'rejected' as const };
		// Before: shown.
		let dismissed = parseDismissed(null);
		expect(dismissed.has(rejected.id)).toBe(false);
		// Dismiss → persist → reload.
		dismissed = parseDismissed(JSON.stringify(addDismissed(dismissed, rejected.id)));
		// After: excluded by the load filter.
		expect(dismissed.has(rejected.id)).toBe(true);
		expect([rejected].filter((s) => !dismissed.has(s.id))).toEqual([]);
	});

	it('caps the stored list to the newest N', () => {
		const many = new Set(Array.from({ length: 500 }, (_, i) => i));
		const capped = addDismissed(many, 999, 500);
		expect(capped.length).toBe(500);
		expect(capped.includes(999)).toBe(true);
		expect(capped.includes(0)).toBe(false); // oldest dropped
	});
});
