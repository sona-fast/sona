import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, gotoRetrying, loginRetrying, waitForHydration } from './admin-login';
import { failOnPageErrors } from './page-errors';

// A variant shows under its parent's collection on the public site, so the
// edit form's Collection field carries a note while the image is a variant.
// The note follows the "Variant of" picker as it changes, not the saved row,
// and the select names it through aria-describedby.
//
// NON-MUTATING: the form is never saved. Runs on the shared read-only server.
// Seed: Parent Piece SFW (1) has a variant, Variant Piece NSFW (2); Ref Sheet
// (3) stands alone.

failOnPageErrors();

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
const HINT = "Variants show in their parent's collection on the public site while the parent is published.";

const collection = (page: Page) => page.getByRole('combobox', { name: 'Collection', exact: true });
const hint = (page: Page) => page.getByText(HINT);

test('the Collection note shows for a variant, hides for a standalone image, and follows the picker', async ({
	page
}) => {
	await loginRetrying(page, PASSWORD);

	// A saved variant: the note shows and is the select's description.
	await gotoAfterLogin(page, '/admin/images/2/edit');
	await waitForHydration(page);
	await expect(hint(page)).toBeVisible();
	await expect(collection(page)).toHaveAccessibleDescription(HINT);

	// A parent with variants of its own has no picker and no note.
	await gotoRetrying(page, '/admin/images/1/edit');
	await waitForHydration(page);
	await expect(collection(page)).toBeVisible();
	await expect(hint(page)).toHaveCount(0);
	await expect(collection(page)).not.toHaveAttribute('aria-describedby');

	// A standalone image: no note until a parent is picked, and none again once
	// the pick is cleared.
	await gotoRetrying(page, '/admin/images/3/edit');
	await waitForHydration(page);
	await expect(hint(page)).toHaveCount(0);
	await expect(collection(page)).not.toHaveAttribute('aria-describedby');

	const variantOf = page.getByRole('combobox', { name: 'Variant of' });
	await variantOf.selectOption({ label: 'Parent Piece SFW' });
	await expect(hint(page)).toBeVisible();
	await expect(collection(page)).toHaveAccessibleDescription(HINT);

	await variantOf.selectOption({ label: 'Not a variant' });
	await expect(hint(page)).toHaveCount(0);
	await expect(collection(page)).not.toHaveAttribute('aria-describedby');
});
