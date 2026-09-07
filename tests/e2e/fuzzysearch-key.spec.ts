import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Artist lookup key settings (SONA-156), driven in a real browser: the four
// states of the section on the Connections tab, and the two transitions that
// only exist client-side — the removal confirmation opening, and Keep putting
// the connected state back. Nothing renders Svelte under vitest, so the unit
// suite can only grep the source for these (page.server.test.ts does); whether
// the states actually swap is only answerable here.
//
// Mutating, and deliberately narrow about it: this spec submits exactly two
// actions, saveFuzzysearchKey and removeFuzzysearchKey, and ends with the key
// removed — which is the seeded state every other spec sees. The invalid-key
// submission below persists nothing (it fails the shape check server-side).

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// Printable ASCII, over eight characters: passes the action's shape check. Not
// a real FuzzySearch key — nothing here calls out.
const FAKE_KEY = 'e2e-fuzzysearch-key-8901';

const section = (page: Page) => page.locator('section.lookup-section');
const keyInput = (page: Page) => page.locator('input[name="fuzzysearchApiKey"]');
const saveButton = (page: Page) =>
	page.locator('form[action="?/saveFuzzysearchKey"] button[type="submit"]');
const removeButton = (page: Page) => section(page).locator('button.btn-remove');
const confirmPanel = (page: Page) => section(page).locator('.remove-confirm');
const keyRecord = (page: Page) => section(page).locator('.key-record');

// The connections sections are hidden by CSS until the tab is active, and the
// toggle is client JS — so the click only "takes" once hydrated (the
// supporter-key spec's retry shape).
async function openConnectionsTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Connections', exact: true }).click();
		await expect(section(page)).toBeVisible({ timeout: 1500 });
	}).toPass();
}

// Serial: the two tests below share one settings row, and the second one's
// starting point is the state the seed leaves behind.
test.describe.configure({ mode: 'serial' });

test.describe('admin settings artist lookup key', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
	});

	test('the unconnected state discloses what leaves the site and takes a key', async ({
		page
	}) => {
		// The disclosure is the reason the section leads with prose: an operator
		// has to read what gets sent before pasting a key.
		await expect(section(page)).toContainText('sends that image file to FuzzySearch');
		await expect(section(page)).toContainText('independent service, not part of Sona');
		await expect(keyInput(page)).toBeVisible();
		// Nothing saved yet: no masked record, no removal action.
		await expect(keyRecord(page)).toHaveCount(0);
		await expect(removeButton(page)).toHaveCount(0);
		// The link to a key comes before the button that wants one.
		const hint = section(page).locator('.hint');
		await expect(hint).toContainText('api.fuzzysearch.net/selfserve');
	});

	test('a malformed key is refused with the error wired to the field', async ({ page }) => {
		await keyInput(page).fill('nope');
		await saveButton(page).click();

		const error = section(page).locator('.field-error#fuzzysearch-key-error');
		await expect(error).toHaveText(/That doesn't look like a key\./);
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
		await expect(keyInput(page)).toHaveAttribute('aria-describedby', 'fuzzysearch-key-error');
		// Rejected before the write: the section is still the unconnected one.
		await expect(keyRecord(page)).toHaveCount(0);
	});

	test('saving connects, Keep backs out of removal, and Remove disconnects', async ({ page }) => {
		await keyInput(page).fill(FAKE_KEY);
		await saveButton(page).click();

		// Connected: the eyebrow, and the mask — never the key itself.
		await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible();
		await expect(keyRecord(page)).toContainText('8901');
		await expect(keyRecord(page)).not.toContainText('e2e-fuzzysearch');
		await expect(keyInput(page)).toHaveCount(0);
		// The save form unmounts and takes the focused Save button with it, so the
		// button that replaces it has to pick focus up.
		await expect(removeButton(page)).toBeFocused();

		// Removal asks first, and moves focus onto the safe choice — every button
		// involved unmounts as the panel opens, so without that a keyboard user
		// lands back on <body>.
		await removeButton(page).click();
		await expect(confirmPanel(page)).toBeVisible();
		const keep = confirmPanel(page).getByRole('button', { name: 'Keep', exact: true });
		await expect(keep).toBeFocused();

		// Keep restores the connected state and hands focus back.
		await keep.click();
		await expect(confirmPanel(page)).toHaveCount(0);
		await expect(keyRecord(page)).toContainText('8901');
		await expect(removeButton(page)).toBeFocused();

		// Remove, confirmed, clears the key and returns the section to its
		// unconnected state — the state the seed hands every other spec.
		await removeButton(page).click();
		await confirmPanel(page).getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(keyRecord(page)).toHaveCount(0);
		await expect(keyInput(page)).toBeVisible();
		// Both confirmation buttons are gone, so focus has to land on the field
		// that replaced them rather than on <body>.
		await expect(keyInput(page)).toBeFocused();
	});
});

// The save above writes to the SHARED seeded DB. If anything between it and the
// final Remove fails, the key stays saved: the CI retry restarts this serial
// block at the unconnected-state test, which then fails for the wrong reason,
// and every later spec sees a connected section. Put the row back the way this
// file found it (legal.spec.ts carries the same guard for privacyPolicy).
test.afterAll(async ({ browser }) => {
	const page = await browser.newPage();
	try {
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
		if ((await removeButton(page).count()) === 0) return;
		await removeButton(page).click();
		await confirmPanel(page).getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(keyRecord(page)).toHaveCount(0);
	} finally {
		await page.close();
	}
});
