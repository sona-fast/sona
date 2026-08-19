import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// The per-type storage breakdown (SONA-192) on the admin Storage tab: under R2
// the loader lists the bucket and the tab renders a segmented bar + breakdown
// table; under UploadThing there is no per-prefix listing, so the table must be
// absent and the R2-only pointer shown instead. Unit tests cover the loader and
// the view module; only rendering the page proves the table's accessible
// structure (sr-only caption, column headers, fixed row order) and that the
// aria-hidden bar/table split survives markup changes.
//
// Runs against the ut-stat project's dedicated server (see playwright.config.ts):
// it flips the storage provider, which would race the shared server's specs. The
// local R2 bucket is empty, so every row renders as a zero row — the structure
// assertions are provider-driven, not data-driven.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

// Same retry pattern as ut-stat.spec.ts: the panel is display:none until the
// hydrated tab click lands.
async function openStorageTab(page: Page) {
	const tab = page.getByRole('tab', { name: 'Storage', exact: true });
	await expect(async () => {
		await tab.click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
}

// Select a provider via the real radio + save path (see ut-stat.spec.ts for why
// the wrapping label is clicked instead of the visually hidden input).
async function setProvider(page: Page, provider: 'uploadthing' | 'r2') {
	await openStorageTab(page);
	const radio = page.getByRole('radio', {
		name: provider === 'r2' ? /Cloudflare R2/ : /UploadThing/
	});
	await expect(async () => {
		await radio.locator('..').click();
		await expect(radio).toBeChecked({ timeout: 1500 });
	}).toPass();
	await page.getByRole('button', { name: 'Save storage settings' }).click();
	const expected = provider === 'r2' ? 'Cloudflare R2' : 'UploadThing';
	await expect(page.getByText('Provider', { exact: true }).locator('..')).toContainText(expected);
}

// The two tests flip the provider on one seeded DB — keep them off each other.
test.describe.configure({ mode: 'serial' });

test.describe('admin settings storage breakdown', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
	});

	test('renders the accessible breakdown table and segmented bar under R2', async ({ page }) => {
		await setProvider(page, 'r2');

		const table = page.locator('table.breakdown');
		await expect(table).toBeVisible();
		// The sr-only caption names the table for screen readers.
		await expect(table.locator('caption')).toHaveText('Storage by content type');

		// Four column headers, in order; the Files header is sr-only by design.
		const headers = table.locator('thead th');
		await expect(headers).toHaveCount(4);
		await expect(headers.nth(0)).toHaveText('Content type');
		await expect(headers.nth(1)).toHaveText('Files');
		await expect(headers.nth(2)).toHaveText('Size');
		await expect(headers.nth(3)).toHaveText('Share of used');

		// Six rows in the fixed kind order, ending on the catch-all bucket.
		const rows = table.locator('tbody tr');
		await expect(rows).toHaveCount(6);
		await expect(rows.nth(5)).toContainText('Avatars & other files');

		// The segmented bar is redundant with the table, so it must stay out of
		// the accessibility tree.
		await expect(page.locator('.storage-bar[aria-hidden="true"]')).toHaveCount(1);

		// The bucket-derived Files stat tile renders alongside the table.
		await expect(
			page.locator('.storage-info .stat-label', { hasText: 'Files' })
		).toBeVisible();
	});

	test('hides the table and shows the R2-only note under UploadThing', async ({ page }) => {
		await setProvider(page, 'uploadthing');

		await expect(page.locator('table.breakdown')).toHaveCount(0);
		await expect(
			page.getByText('Usage by content type is available on Cloudflare R2 storage.')
		).toBeVisible();
	});
});
