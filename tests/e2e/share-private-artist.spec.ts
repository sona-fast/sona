import { test, expect, type Request } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';

// Submit to registry for a private (ledger-only) artist, in a real browser
// (SONA-236). The server refuses the first submit with a 409 confirmPrivate; the
// page has to turn that into the Share anyway dialog, send nothing more on
// Cancel or Escape, and resubmit with confirmPrivate=1 only on Share anyway.
// The unit suite covers the server half (page.server.test.ts); only a browser
// proves the enhance callback, the dialog, and the hidden resubmit form line up,
// and where focus lands each time the dialog closes.
//
// Runs on the registry-sync project (playwright.config.ts): the only server with
// the registry turned on, which the Share button needs. The preloaded registry
// interceptor answers the submission with an empty success.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';

test('a private artist asks before sharing, and only Share anyway resubmits', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');

	// A unique name, so a rerun against a reused DB still finds one row. Created
	// over the JSON API with the "keep private" flag and no socials, so nothing
	// is looked up.
	const name = `Private Share ${Date.now()}`;
	const created = await page.request.post('/api/artists', { data: { name, ledgerPrivate: true } });
	expect(created.ok()).toBe(true);

	await gotoAfterLogin(page, `/admin/artists?q=${encodeURIComponent(name)}`);
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toBeVisible();
	await expect(row.getByText('private', { exact: true })).toBeVisible();

	const posts: Request[] = [];
	page.on('request', (req) => {
		if (req.method() === 'POST' && req.url().includes('submitToRegistry')) posts.push(req);
	});
	const sentConfirm = () => posts.map((r) => (r.postData() ?? '').includes('confirmPrivate'));

	const share = row.getByRole('button', { name: 'Submit to shared registry' });
	const dialog = page.getByRole('dialog', { name: 'Share with the registry?' });

	// A click before use:enhance is attached posts natively and shows no dialog.
	await waitForHydration(page);

	// Escape: the dialog closes, nothing more is sent, focus is back on Share.
	await share.click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(share).toBeFocused();
	expect(sentConfirm()).toEqual([false]);

	// Cancel: the same.
	await share.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(share).toBeFocused();
	expect(sentConfirm()).toEqual([false, false]);

	// Share anyway: one more submit, carrying confirmPrivate, and it succeeds.
	await share.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Share anyway' }).click();
	await expect(page.locator('.toaster .alert-message').last()).toHaveText(
		'Submitted to the registry for review'
	);
	expect(sentConfirm()).toEqual([false, false, false, true]);
	await expect(share).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('shared-anyway.png') });
});

// The Edit Artist modal offers "Keep private" only where it can mean something:
// a shared (registry-linked) artist can't be made private, so the box is absent
// for one that isn't private already. A local private artist keeps the box. The
// unit suite covers the update action; only the browser shows what renders.
test('the edit modal hides Keep private for a shared artist, not a local private one', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');

	// Unique names and globalId, so a rerun against a reused DB finds one row
	// each. No socials, so nothing is looked up.
	const stamp = Date.now();
	const linkedName = `Linked Edit ${stamp}`;
	const privateName = `Private Edit ${stamp}`;
	const linked = await page.request.post('/api/artists', {
		data: { name: linkedName, globalId: `e2e-linked-${stamp}`, registryVersion: 1 }
	});
	expect(linked.ok()).toBe(true);
	const local = await page.request.post('/api/artists', { data: { name: privateName, ledgerPrivate: true } });
	expect(local.ok()).toBe(true);

	const keepPrivate = page.getByRole('checkbox', { name: 'Keep private (commission ledger only)' });
	const nameField = page.getByRole('textbox', { name: 'Artist Name' });

	const openEdit = async (name: string) => {
		await gotoAfterLogin(page, `/admin/artists?q=${encodeURIComponent(name)}`);
		const row = page.getByRole('row').filter({ hasText: name });
		await expect(row).toBeVisible();
		await waitForHydration(page);
		await row.getByRole('button', { name: 'Edit artist' }).click();
		await expect(nameField).toHaveValue(name);
	};

	await openEdit(linkedName);
	await expect(keepPrivate).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('linked-edit.png') });

	await openEdit(privateName);
	await expect(keepPrivate).toBeVisible();
	await expect(keepPrivate).toBeChecked();
	await page.screenshot({ path: testInfo.outputPath('private-edit.png') });
});

// A shared artist that is already private (the sync backfill or an approved
// share can leave one so) keeps the box, so its owner can clear the flag. Were
// the box hidden here, saving would post no ledgerPrivate and silently clear it.
// No API creates this state, so the row comes from the registry server's seed
// overlay (fixtures/registry.sql). The test clears the flag, so it runs once
// per seeded DB.
test('the edit modal keeps Keep private for a shared artist that is already private', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');

	const name = 'Linked Private Seeded';
	const keepPrivate = page.getByRole('checkbox', { name: 'Keep private (commission ledger only)' });
	const nameField = page.getByRole('textbox', { name: 'Artist Name' });
	const row = page.getByRole('row').filter({ hasText: name });

	const openEdit = async () => {
		await gotoAfterLogin(page, `/admin/artists?q=${encodeURIComponent(name)}`);
		await expect(row).toBeVisible();
		await waitForHydration(page);
		await row.getByRole('button', { name: 'Edit artist' }).click();
		await expect(nameField).toHaveValue(name);
	};

	await openEdit();
	await expect(keepPrivate).toBeVisible();
	await expect(keepPrivate).toBeChecked();
	await page.screenshot({ path: testInfo.outputPath('linked-private-edit.png') });

	await keepPrivate.uncheck();
	await page.getByRole('button', { name: 'Save Changes' }).click();
	await expect(nameField).toHaveCount(0);
	await expect(row.getByText('private', { exact: true })).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('linked-private-saved.png') });

	await openEdit();
	await expect(keepPrivate).toHaveCount(0);
	await expect(nameField).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('linked-cleared-edit.png') });
});

// Keep private promises the artist stays out of the shared registry, so the New
// Artist dialog must not send the typed name there as a search while the box is
// ticked. Unticking searches for the name as typed.
test('the New Artist dialog sends no registry search while Keep private is ticked', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/artists');

	const searches: string[] = [];
	page.on('request', (req) => {
		const url = new URL(req.url());
		if (url.pathname === '/api/registry/search') searches.push(url.searchParams.get('q') ?? '');
	});

	const dialog = page.getByRole('dialog', { name: 'New Artist' });
	// The Add button is client-side; a click that lands before hydration does
	// nothing, so retry until the dialog opens.
	await expect(async () => {
		await page.getByRole('button', { name: 'Add Artist' }).first().click();
		await expect(dialog).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 30_000 });

	const keepPrivate = dialog.getByLabel('Keep private (commission ledger only)');
	await keepPrivate.check();
	await dialog.getByLabel('Artist Name').fill('Quiet Quill');
	// Longer than the dialog's 250 ms search debounce, so a search that was going
	// to fire has fired.
	await page.waitForTimeout(1_000);
	expect(searches).toEqual([]);
	await expect(dialog.getByRole('combobox')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('private-no-search.png') });

	await keepPrivate.uncheck();
	await expect.poll(() => searches).toEqual(['Quiet Quill']);
});
