import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';
import { failOnPageErrors } from './page-errors';

// The commission ledger with its early-access gate closed (SONA-236 PR 2): a
// fork with no supporter key before the GA date. Its own server (the
// 'commissions-gated' project in playwright.config.ts) runs without
// E2E_COMMISSION_GATE and is seeded with one entry
// (fixtures/commissions-gated.sql). The owner can read and delete that entry,
// but not add or change one. Each step saves a screenshot under test-results.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-commissions-gated.toml.
const PASSWORD = 'e2e-admin-password';

failOnPageErrors();

// The gate reads the server's real clock, which a spec can't fake. Past the GA
// date (or once the registry entry retires) the gate opens for everyone and
// this spec has nothing to test, so it skips; delete it with the entry.
const registry = readFileSync(new URL('../../src/lib/early-access.ts', import.meta.url), 'utf8');
const gaDate = registry.match(/'commission-ledger':\s*\{\s*gaDate:\s*'(\d{4}-\d{2}-\d{2})'/)?.[1];
// An entry this can't read is a broken check, not a GA'd feature: fail rather
// than skip, or a reformatted registry line would switch this spec off quietly.
if (registry.includes("'commission-ledger'") && gaDate === undefined) {
	throw new Error("early-access.ts registers 'commission-ledger', but its gaDate didn't parse");
}
const gated = gaDate !== undefined && Date.now() < Date.parse(`${gaDate}T00:00:00Z`);

test.describe.configure({ mode: 'serial' });
test.skip(!gated, 'the commission ledger is past its GA date, so the gate is open');

test('the ledger reads, offers the key, and hides New entry', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions');
	await waitForHydration(page);

	const notice = page.getByRole('note');
	await expect(notice).toContainText('Early access');
	await expect(notice).toContainText('Until then, you can read and delete your entries, but not add or change them.');
	await expect(page.getByRole('link', { name: 'New entry' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'View Headshot icon' })).toBeVisible();
	// Adding to the gallery is a change, so it waits for the gate too.
	await expect(page.getByRole('link', { name: /Add to gallery/ })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-ledger-gated.png'));

	const keyLink = notice.getByRole('link', { name: 'Add your key' });
	await expect(keyLink).toHaveAttribute('href', '/admin/settings?tab=account#supporter-key');
	await keyLink.click();
	await expect(page).toHaveURL(/\/admin\/settings\?tab=account#supporter-key$/);
	await expect(page.locator('#supporter-key')).toBeVisible();
});

test('the entry shows plain dates and Delete entry, with no Save', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/1/edit');
	await waitForHydration(page);

	await expect(page.getByRole('heading', { level: 1, name: 'Headshot icon' })).toBeVisible();
	const progress = page.locator('section', { has: page.getByRole('heading', { name: 'Progress' }) });
	await expect(progress.locator('div', { hasText: /^Requested/ })).toContainText('2026.09.03');
	await expect(progress.locator('div', { hasText: /^Delivered/ }).last()).toContainText('2026.10.08');
	await expect(progress).toContainText('45.00 USD');
	// SONA-9: 35 days apart, and nothing on the page may say so.
	await expect(page.locator('main')).not.toContainText(/\b35\b|days?\b|ago\b|since\b/);
	await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-readonly.png'));
});

test('an upload from the entry waits for the gate too, before any file goes up', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/upload?commission=1');
	await waitForHydration(page);

	const notice = page.getByRole('note').filter({ hasText: 'Early access' });
	await expect(notice).toContainText('A supporter key unlocks it now.');
	await expect(notice.getByRole('link', { name: 'Add your key' })).toHaveAttribute(
		'href',
		'/admin/settings?tab=account#supporter-key'
	);
	// No form to fill: no file picker, no Upload Artwork, no prefill note.
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Upload Artwork' })).toHaveCount(0);
	await expect(page.getByText('From your commission')).toHaveCount(0);
	// The page's way back to the entry.
	await expect(page.getByRole('link', { name: 'Back to the entry' })).toHaveAttribute('href', '/admin/commissions/1/edit');
	await settledShot(page, testInfo.outputPath('commission-upload-gated.png'));

	// The page listens for pasted images anywhere on it. With no form to fill,
	// a pasted image must not go up to storage.
	let uploads = 0;
	page.on('request', (r) => {
		if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/upload') uploads += 1;
	});
	await page.evaluate(() => {
		const clipboard = new DataTransfer();
		clipboard.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pasted.png', { type: 'image/png' }));
		window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
	});
	// A paste that went through would POST at once; give it time to show up.
	await page.waitForTimeout(1500);
	expect(uploads).toBe(0);
});

test('Delete entry works with the gate closed', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/1/edit');
	await waitForHydration(page);

	await page.getByRole('button', { name: 'Delete entry' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-ledger-gated-emptied.png'));
});
