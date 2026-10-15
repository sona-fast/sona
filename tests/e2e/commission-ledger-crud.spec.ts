import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';

// The commission ledger saved through the real form (SONA-236 PR 2): create an
// entry, move it to Delivered, refuse an out-of-date save from a second tab and
// bring the typed note back, then delete it. Its own writable server (the
// 'commissions' project in playwright.config.ts), where E2E_COMMISSION_GATE
// opens the early-access gate. The tests run in order on one ledger. Each step
// saves a screenshot under test-results.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
const TITLE = 'E2E ref sheet';

test.describe.configure({ mode: 'serial' });

/** A fresh document that has hydrated, so the status select and use:enhance
 * are attached before the test touches them. */
async function open(page: Page, url: string) {
	await gotoAfterLogin(page, url);
	await waitForHydration(page);
}

const section = (page: Page, heading: 'Active' | 'Finished') =>
	page.locator('section', { has: page.getByRole('heading', { level: 2, name: heading }) });

test('creates an entry that lists under Active', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');

	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(TITLE);
	await page.locator('label.char-chip', { hasText: 'Taro' }).click();
	await page.locator('label.char-chip', { hasText: 'Thistle' }).click();
	await page.getByLabel('Price').fill('120.00');
	await page.getByLabel('Currency').fill('USD');
	await page.getByLabel('Requested').fill('2026-10-02');
	await page.getByRole('button', { name: 'Save entry' }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Active').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Test Artist');
	await expect(row).toContainText('Taro, Thistle');
	await expect(row).toContainText('Applied');
	await expect(row).toContainText('Unpaid');
	await expect(section(page, 'Finished')).toContainText('Entries you mark Delivered, Not picked, or Canceled move here.');
	await page.screenshot({ path: testInfo.outputPath('commission-ledger-created.png'), fullPage: true });

	// At tablet width the section is under the 760px the seven columns need, so
	// each row becomes a card: no header row, and the row lays out as a block.
	await page.setViewportSize({ width: 744, height: 1024 });
	await expect(section(page, 'Active').locator('thead')).toBeHidden();
	await expect(row).toHaveCSS('display', 'block');
	await page.screenshot({ path: testInfo.outputPath('commission-ledger-cards-744.png'), fullPage: true });
});

test('moving the entry to Delivered lists it under Finished', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// The saved price comes back in its typed form.
	await expect(page.getByLabel('Price')).toHaveValue('120.00');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).not.toHaveValue('');
	await page.screenshot({ path: testInfo.outputPath('commission-entry-edit.png'), fullPage: true });
	await page.getByRole('button', { name: 'Save changes' }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Delivered');
	await expect(row).toContainText('Not in your gallery');
	await expect(section(page, 'Active')).toContainText('Entries you mark Applied, Waitlisted, Accepted, or In progress show here.');
	await page.screenshot({ path: testInfo.outputPath('commission-ledger-finished.png'), fullPage: true });
});

test('an out-of-date save is refused, and Reload entry brings the typed note back', async ({ page, context }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');

	// This tab opens the form first.
	await open(page, editUrl!);

	// Another tab changes the entry and saves.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByLabel('Title').fill(`${TITLE} (renamed)`);
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	// This tab, still on the old copy, changes the note and the payment.
	await page.getByLabel('Notes').fill('Typed before the reload.');
	await page.getByLabel('Payment').selectOption('deposit');
	await page.getByRole('button', { name: 'Save changes' }).click();

	const alert = page.getByRole('alert').filter({ hasText: 'changed after you opened it' });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText('Your note comes with it, but your changes to Payment don');
	await expect(alert).toBeFocused();
	await page.getByText('Why did this happen?').click();
	await expect(page.getByText('Another tab or device changed this entry')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('commission-entry-stale.png'), fullPage: true });

	await page.getByRole('button', { name: 'Reload entry' }).click();
	const notes = page.getByLabel('Notes');
	await expect(notes).toHaveValue('Typed before the reload.');
	await expect(notes).toBeFocused();
	await expect(page.getByLabel('Title')).toHaveValue(`${TITLE} (renamed)`);
	await expect(page.getByLabel('Payment')).toHaveValue('unpaid');
	await expect(page.getByText("Your note from before the reload isn't saved yet. Save changes to keep it.")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('commission-entry-reloaded.png'), fullPage: true });

	// The reloaded form carries the current version, so this save goes through.
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(section(page, 'Finished').getByRole('row', { name: /renamed/ })).toBeVisible();
});

test('deleting the entry empties the ledger', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	await page.getByRole('button', { name: 'Delete entry' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
	await expect(dialog).toContainText('Test Artist stays in your artist list');
	await page.screenshot({ path: testInfo.outputPath('commission-entry-delete.png'), fullPage: true });
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('commission-ledger-emptied.png'), fullPage: true });
});
