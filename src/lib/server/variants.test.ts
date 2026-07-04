import { describe, expect, it } from 'vitest';
import { variantAssignmentError, MAX_VARIANT_SET } from './variants';

describe('variantAssignmentError', () => {
	it('allows a plain image to become a variant of a parent', () => {
		expect(
			variantAssignmentError({ selfId: 5, parent: { id: 3, parentImageId: null } })
		).toBeNull();
	});

	it('allows batch assignment with no self image yet (upload flow)', () => {
		expect(
			variantAssignmentError({ selfId: null, parent: { id: 3, parentImageId: null } })
		).toBeNull();
	});

	it('rejects a missing parent', () => {
		expect(variantAssignmentError({ selfId: 5, parent: undefined })).toBe('missing');
	});

	it('rejects self-reference', () => {
		expect(variantAssignmentError({ selfId: 3, parent: { id: 3, parentImageId: null } })).toBe(
			'self'
		);
	});

	it('rejects a parent that is itself a variant (one level only)', () => {
		expect(variantAssignmentError({ selfId: 5, parent: { id: 3, parentImageId: 1 } })).toBe(
			'nested'
		);
	});

	it('rejects re-parenting an image that has variants of its own', () => {
		expect(
			variantAssignmentError({
				selfId: 5,
				parent: { id: 3, parentImageId: null },
				selfHasVariants: true
			})
		).toBe('has_variants');
	});

	it('checks self-reference before nesting so the clearest error wins', () => {
		expect(variantAssignmentError({ selfId: 3, parent: { id: 3, parentImageId: 1 } })).toBe(
			'self'
		);
	});
});

describe('MAX_VARIANT_SET', () => {
	it('is the agreed cap of 8 files per one-flow upload', () => {
		expect(MAX_VARIANT_SET).toBe(8);
	});
});
