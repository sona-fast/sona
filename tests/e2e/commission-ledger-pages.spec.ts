import { test, expect } from '@playwright/test';
import { adminLogin, waitForHydration } from './admin-login';

// The commission ledger pages (SONA-236 PR 2), driven in a real browser. The
// server actions are covered against a real schema in the vitest suites beside
// each route; what only a browser shows is the form's own behavior: the status
// select filling a date, and a refused save tying its error to the field.
//
// Runs on the SHARED read-only DB/server: the one submit here is refused by the
// server with 400, so no test writes a row. The ledger's early-access gate is
// open through E2E_COMMISSION_GATE in wrangler.e2e.toml. Each test saves a
// screenshot under test-results so a pass can be checked afterwards.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('the ledger lists nothing yet and says who can read it', async ({ page }, testInfo) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/commissions');

	await expect(page.getByRole('heading', { level: 1, name: 'Commissions' })).toBeVisible();
	await expect(page.getByText(/Visitors never see your commission ledger/)).toBeVisible();
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'New entry' })).toHaveAttribute('href', '/admin/commissions/new');
	// The sidebar names the page after Artists.
	const nav = page.locator('.sidebar-nav a');
	const labels = await nav.allInnerTexts();
	expect(labels.map((l) => l.trim()).indexOf('Commissions')).toBe(labels.map((l) => l.trim()).indexOf('Artists') + 1);

	await page.screenshot({ path: testInfo.outputPath('commission-ledger-empty.png'), fullPage: true });
});

test("moving an entry to Accepted fills today's date, and a set date stays", async ({ page }, testInfo) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/commissions/new');
	// The status select and use:enhance are client-side: before hydration a pick
	// fills nothing and a save posts natively.
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();

	const today = await page.evaluate(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	});
	const accepted = page.getByLabel('Accepted', { exact: true });
	const delivered = page.getByLabel('Delivered', { exact: true });
	await expect(accepted).toHaveValue('');

	await page.getByLabel('Status').selectOption('accepted');
	await expect(accepted).toHaveValue(today);
	await expect(delivered).toHaveValue('');

	// A Delivered date the owner already typed is kept.
	await delivered.fill('2026-01-02');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(delivered).toHaveValue('2026-01-02');

	await page.screenshot({ path: testInfo.outputPath('commission-entry-dates.png'), fullPage: true });
});

test('a refused price shows its error on the field, and nothing is saved', async ({ page }, testInfo) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/commissions/new');
	// The status select and use:enhance are client-side: before hydration a pick
	// fills nothing and a save posts natively.
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();

	await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
	await page.getByLabel('Title').fill('E2E refused price');
	await page.getByLabel('Price').fill('45.5');
	await page.getByLabel('Currency').fill('JPY');
	await page.getByRole('button', { name: 'Save entry' }).click();

	const price = page.getByLabel('Price');
	await expect(price).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByText("JPY prices don't use decimals. Enter a whole number.")).toBeVisible();
	await expect(price).toHaveAttribute('aria-describedby', /ce-price-err/);
	// Focus moves to the first field with an error.
	await expect(price).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('commission-entry-price-error.png'), fullPage: true });

	await page.goto('/admin/commissions');
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
});
