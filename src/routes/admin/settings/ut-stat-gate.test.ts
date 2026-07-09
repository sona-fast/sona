import { describe, it, expect } from 'vitest';
import { showUtFileStat } from './ut-stat';

// Value test for the UploadThing file-count stat gate.
//
// +page.server.ts populates `utUsage` whenever UPLOADTHING_TOKEN exists,
// REGARDLESS of the active storage provider. So `utUsage` being truthy does NOT
// mean UploadThing is the live store — on a site that migrated UT -> R2 (the
// real sparky.ink situation) `utUsage` is still truthy but the file count is
// stale. The provider clause is the only thing hiding that stale count, which is
// why this test asserts on the returned boolean rather than the page source: a
// value test rejects equivalent-looking lies (drop/negate the provider clause)
// while accepting equivalent spellings.

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
