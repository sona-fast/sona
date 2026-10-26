import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';

// The New Artist dialog's Import all confirmation, driven from the keyboard
// (SONA-236). The confirmation is a second layer outside the dialog's panel,
// so it needs its own focus handling: focus moves in when it opens, Tab stays
// inside it, the first Escape closes only it (focus back on Import all), and a
// second Escape closes the dialog (focus back on its opener). The entry form's
// copy of the dialog also has to close and list the imported artists once an
// import succeeds.
//
// Runs on the registry-sync project (playwright.config.ts): the only server
// with the registry turned on, which the Import all footer needs. Its
// wrangler.e2e-registry.toml also opens the commission ledger's early-access
// gate for the entry form. The browser's own /api/registry/import calls are
// answered here with page.route, so the plan has artists to import and the
// import itself writes nothing.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';
const PLAN = { enabled: true, total: 5, toCreate: 3, skipped: 2 };

/** Answers the dialog's import plan, and its Import all with a success after
 * running `onImport` (the stand-in for what a real import would write). */
async function routeImport(page: Page, onImport: () => Promise<void> = async () => {}) {
	await page.route(
		(url) => url.pathname === '/api/registry/import',
		async (route) => {
			if (route.request().method() === 'POST') {
				await onImport();
				return route.fulfill({ json: { enabled: true, created: PLAN.toCreate } });
			}
			return route.fulfill({ json: PLAN });
		}
	);
}

test('Import all is reachable by keyboard, and each Escape closes one layer', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await routeImport(page);
	await gotoAfterLogin(page, '/admin/artists');
	await waitForHydration(page);

	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	const opener = page.getByRole('button', { name: 'Add Artist' }).first();
	await opener.focus();
	await page.keyboard.press('Enter');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Artist Name')).toBeFocused();

	const importAll = dialog.getByRole('button', { name: 'Import all…' });
	await importAll.focus();
	await page.keyboard.press('Enter');

	const confirm = page.getByRole('dialog', { name: 'Import all registry artists' });
	await expect(confirm).toBeVisible();
	await expect(confirm).toBeFocused();
	// Around the whole layer and past both ends: focus never leaves it.
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Tab');
		await expect(confirm.locator(':focus')).toHaveCount(1);
	}
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Shift+Tab');
		await expect(confirm.locator(':focus')).toHaveCount(1);
	}
	await expect(confirm.getByRole('button', { name: 'Import 3 artists' })).toBeEnabled();
	await page.screenshot({ path: testInfo.outputPath('import-all-confirm-focused.png') });

	await page.keyboard.press('Escape');
	await expect(confirm).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(importAll).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test('Import all from the entry form closes the dialog and lists the imported artists', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	// A unique name, so a rerun against a reused DB still finds one option.
	const name = `Imported Artist ${Date.now()}`;
	// The stand-in import writes one artist after the form has loaded, so only
	// a refresh after the import can put it in the Artist select. Private and
	// without socials, so creating it looks nothing up.
	await routeImport(page, async () => {
		const created = await page.request.post('/api/artists', { data: { name, ledgerPrivate: true } });
		expect(created.ok()).toBe(true);
	});
	await gotoAfterLogin(page, '/admin/commissions/new');
	await waitForHydration(page);

	const artist = page.getByLabel('Artist', { exact: true });
	await expect(artist.locator('option', { hasText: name })).toHaveCount(0);

	const addArtist = page.getByRole('button', { name: 'Add New Artist' });
	await addArtist.click();
	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	await dialog.getByRole('button', { name: 'Import all…' }).click();
	const confirm = page.getByRole('dialog', { name: 'Import all registry artists' });
	await confirm.getByRole('button', { name: 'Import 3 artists' }).click();

	await expect(confirm).toHaveCount(0);
	await expect(dialog).toHaveCount(0);
	await expect(artist.locator('option', { hasText: name })).toHaveCount(1);
	await expect(addArtist).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('entry-form-imported-all.png') });
});

test('a failed Import all keeps the confirmation open with focus back on Import N', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	// Hold the import so the confirmation's controls are disabled while it runs,
	// as a slow registry would, then refuse it.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(
		(url) => url.pathname === '/api/registry/import',
		async (route) => {
			if (route.request().method() === 'POST') {
				await held;
				return route.fulfill({ status: 502, json: { enabled: true, error: 'key refused' } });
			}
			return route.fulfill({ json: PLAN });
		}
	);
	await gotoAfterLogin(page, '/admin/artists');
	await waitForHydration(page);

	await page.getByRole('button', { name: 'Add Artist' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	await dialog.getByRole('button', { name: 'Import all…' }).click();
	const confirm = page.getByRole('dialog', { name: 'Import all registry artists' });
	const importN = confirm.getByRole('button', { name: 'Import 3 artists' });
	await importN.focus();
	await page.keyboard.press('Enter');
	await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();
	release();

	await expect(page.getByText('Registry said: key refused')).toBeVisible();
	await expect(confirm).toBeVisible();
	await expect(importN).toBeEnabled();
	await expect(importN).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('import-all-failed-focus.png') });
});
