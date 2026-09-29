import { test, expect, type Request } from '@playwright/test';
import { gotoAfterLogin, loginRetrying } from './admin-login';

// The admin New Artist dialog, with the shared registry turned on, fed a pasted
// legacy Patreon link (patreon.com/user?u=<id>). That link names no creator: the
// path segment 'user' is a Patreon site path. It once searched the registry for
// the handle 'user'; now the dialog finds no handle, fires no search, shows the
// too-short hint, and keeps Create blocked until a plain name is typed.
//
// Only a browser proves the wiring: classifyQuery's empty handle, the debounce
// gate, the hint, and the button's disabled state all meet in the component.
//
// Runs on the registry-sync project (playwright.config.ts): the only server with
// the registry turned on (wrangler.e2e-registry.toml) and the registry
// interceptor preloaded. It writes no scenario file, so the interceptor answers
// as a healthy, empty registry, and it creates nothing.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';
const LEGACY_PATREON = 'https://www.patreon.com/user?u=123';
// Longer than the dialog's 250 ms search debounce, so a search that was going to
// fire has fired.
const PAST_DEBOUNCE_MS = 1_000;

test('a pasted patreon.com/user?u= link fires no registry search and blocks create', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/artists');

	const searches: Request[] = [];
	page.on('request', (req) => {
		if (new URL(req.url()).pathname === '/api/registry/search') searches.push(req);
	});

	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	// The Add button is client-side; a click that lands before hydration does
	// nothing, so retry until the dialog opens.
	await expect(async () => {
		await page.getByRole('button', { name: 'Add Artist' }).first().click();
		await expect(dialog).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 30_000 });

	const nameField = dialog.getByLabel('Artist Name');
	const create = dialog.getByRole('button', { name: 'Create Artist' });

	await nameField.fill(LEGACY_PATREON);
	await page.waitForTimeout(PAST_DEBOUNCE_MS);

	expect(searches.map((r) => r.url())).toEqual([]);
	await expect(
		dialog.getByText('Type at least 2 characters of a handle, or a name to add a new artist.')
	).toBeVisible();
	await expect(create).toBeDisabled();
	await page.screenshot({ path: testInfo.outputPath('legacy-patreon-link-blocked.png') });

	// A plain name unblocks create, and does search the registry by name, which
	// also proves the request listener above would have seen a handle search.
	await nameField.fill('Marrow Test');
	await expect(create).toBeEnabled();
	await expect.poll(() => searches.map((r) => new URL(r.url()).search)).toContain('?q=Marrow%20Test');
	await page.screenshot({ path: testInfo.outputPath('plain-name-enabled.png') });
});

// A patreon.com/cw/<user> link names its creator after the 'cw/' segment. The
// request carries the pasted URL as typed (the registry normalizes it), so the
// 'kuttoya' search alone can't tell which handle the dialog read: read as
// patreon.com/<user>, the handle would be 'cw', which also meets the two-character
// minimum and fires the same search. The '/cw/a' step is what distinguishes the
// fix from the old behavior: read correctly the handle is 'a', below the minimum,
// so no search fires and the hint shows; read the old way it would be 'cw' and a
// second search would fire.
test('a pasted patreon.com/cw/ link searches the registry by handle', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/artists');

	const searches: Request[] = [];
	page.on('request', (req) => {
		if (new URL(req.url()).pathname === '/api/registry/search') searches.push(req);
	});

	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	await expect(async () => {
		await page.getByRole('button', { name: 'Add Artist' }).first().click();
		await expect(dialog).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 30_000 });

	const cwLink = 'https://www.patreon.com/cw/kuttoya';
	await dialog.getByLabel('Artist Name').fill(cwLink);
	await page.waitForTimeout(PAST_DEBOUNCE_MS);

	expect(searches.map((r) => new URL(r.url()).searchParams.get('handle'))).toEqual([cwLink]);
	await expect(
		dialog.getByText('Type at least 2 characters of a handle, or a name to add a new artist.')
	).toBeHidden();
	await expect(dialog.getByRole('button', { name: 'Create Artist' })).toBeDisabled();
	await page.screenshot({ path: testInfo.outputPath('cw-link-handle-search.png') });

	await dialog.getByLabel('Artist Name').fill('https://www.patreon.com/cw/a');
	await page.waitForTimeout(PAST_DEBOUNCE_MS);

	await expect(
		dialog.getByText('Type at least 2 characters of a handle, or a name to add a new artist.')
	).toBeVisible();
	expect(searches).toHaveLength(1);
	await expect(dialog.getByRole('button', { name: 'Create Artist' })).toBeDisabled();
	await page.screenshot({ path: testInfo.outputPath('cw-short-handle-blocked.png') });
});
