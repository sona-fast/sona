// Variant-group rules shared by the image edit action, the bulk upload action,
// and the admin images "group as variants" action. Groups are one level deep:
// a parent (parent_image_id IS NULL) and its direct variants — never nested.

export const MAX_VARIANT_SET = 8; // parent + 7 variants per one-flow upload

/**
 * Refused when an image that is the owner character's designated reference
 * sheet is about to become a variant. /art excludes variants from both
 * ref-sheet paths (SONA-18), so allowing the write would void the reference
 * sheet without saying so — and on a fork whose only content is that sheet,
 * /art would start 404ing. Callers clear the designation first.
 */
export const REFERENCE_BECOMES_VARIANT_ERROR =
	'This image is the reference sheet, so it cannot become a variant. Clear the reference sheet first.';

export type VariantAssignmentError = 'self' | 'missing' | 'nested' | 'has_variants';

/**
 * Validates assigning `selfId` as a variant of `parent`. Pure — callers fetch
 * the rows. Returns null when the assignment is allowed.
 *
 * - 'self': an image cannot be its own parent
 * - 'missing': the chosen parent does not exist
 * - 'nested': the chosen parent is itself a variant (one level only)
 * - 'has_variants': the image being assigned already has variants of its own,
 *   so re-parenting it would nest its group
 */
export function variantAssignmentError(opts: {
	selfId: number | null;
	parent: { id: number; parentImageId: number | null } | undefined;
	selfHasVariants?: boolean;
}): VariantAssignmentError | null {
	if (!opts.parent) return 'missing';
	if (opts.selfId !== null && opts.parent.id === opts.selfId) return 'self';
	if (opts.parent.parentImageId !== null) return 'nested';
	if (opts.selfHasVariants) return 'has_variants';
	return null;
}
