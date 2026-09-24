import { describe, it, expect } from 'vitest';
import { showUtFileStat } from './ut-stat';

// The predicate is tested by value. That the template actually renders the stat
// only through this helper is covered by tests/e2e/ut-stat.spec.ts.

describe('showUtFileStat', () => {
	const utUsage = { usedBytes: 1, limitBytes: 10, filesUploaded: 42 };

	it('shows the stat when utUsage is present and provider is uploadthing', () => {
		expect(showUtFileStat({ utUsage, settings: { storageProvider: 'uploadthing' } })).toBe(true);
	});

	it('hides the stat on a migrated R2 site even though utUsage is still present', () => {
		expect(showUtFileStat({ utUsage, settings: { storageProvider: 'r2' } })).toBe(false);
	});

	it('hides the stat when utUsage is null even on the uploadthing provider', () => {
		expect(showUtFileStat({ utUsage: null, settings: { storageProvider: 'uploadthing' } })).toBe(
			false
		);
		expect(
			showUtFileStat({ utUsage: undefined, settings: { storageProvider: 'uploadthing' } })
		).toBe(false);
	});

	it('hides the stat when utUsage is null and provider is r2', () => {
		expect(showUtFileStat({ utUsage: null, settings: { storageProvider: 'r2' } })).toBe(false);
	});
});
