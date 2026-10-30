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

// The Edit Artist modal always shows "Keep private", enabled only where it can
// mean something: a shared (registry-linked) artist can't be made private, so
// the box is disabled, with the reason, for one that isn't private already. A
// local private artist can use it. The unit suite covers the update action;
// only the browser shows what renders.
test('the edit modal disables Keep private for a shared artist, not a local private one', async ({
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

	const keepPrivate = page.getByRole('checkbox', { name: 'Keep private' });
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
	await expect(keepPrivate).toBeDisabled();
	await expect(keepPrivate).not.toBeChecked();
	await expect(keepPrivate).toHaveAccessibleDescription(new RegExp(`${linkedName} is already shared with the registry\\.`));
	await page.screenshot({ path: testInfo.outputPath('linked-edit.png') });

	await openEdit(privateName);
	await expect(keepPrivate).toBeEnabled();
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
	const keepPrivate = page.getByRole('checkbox', { name: 'Keep private' });
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
	await expect(keepPrivate).toBeDisabled();
	await expect(keepPrivate).not.toBeChecked();
	await expect(nameField).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('linked-cleared-edit.png') });
});

// An artist with published work already shows on the site, so the box is
// disabled with that reason; an unpublished piece alone doesn't do that.
test('the edit modal disables Keep private once an artist has published work', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');

	const stamp = Date.now();
	const withPiece = async (name: string, published: boolean) => {
		const created = await page.request.post('/api/artists', { data: { name } });
		expect(created.ok()).toBe(true);
		const { id } = (await created.json()) as { id: number };
		// "published" is the upload form's Private box, so sending it keeps the piece unpublished.
		const upload = await page.request.post('/admin/upload', {
			form: {
				title: `${name} piece`,
				artistId: String(id),
				count: '1',
				imageUrl_0: '/x1.png',
				...(published ? {} : { published: 'on' })
			},
			headers: { origin: baseURL! },
			maxRedirects: 0
		});
		expect(upload.status()).toBeLessThan(400);
	};
	const publicName = `Published Work ${stamp}`;
	const draftName = `Draft Work ${stamp}`;
	await withPiece(publicName, true);
	await withPiece(draftName, false);

	const keepPrivate = page.getByRole('checkbox', { name: 'Keep private' });
	const nameField = page.getByRole('textbox', { name: 'Artist Name' });
	const openEdit = async (name: string) => {
		await gotoAfterLogin(page, `/admin/artists?q=${encodeURIComponent(name)}`);
		const row = page.getByRole('row').filter({ hasText: name });
		await expect(row).toBeVisible();
		await waitForHydration(page);
		await row.getByRole('button', { name: 'Edit artist' }).click();
		await expect(nameField).toHaveValue(name);
	};

	await openEdit(publicName);
	await expect(keepPrivate).toBeDisabled();
	await expect(keepPrivate).toHaveAccessibleDescription(
		new RegExp(`${publicName} already shows on your site through published work\\.`)
	);
	await page.screenshot({ path: testInfo.outputPath('published-work-edit.png') });

	await openEdit(draftName);
	await expect(keepPrivate).toBeEnabled();
	await expect(keepPrivate).not.toBeChecked();
	await expect(page.getByText('already shows on your site')).toHaveCount(0);
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

	const keepPrivate = dialog.getByLabel('Keep private');
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

// Publishing a piece by a Keep private artist makes them public, so the images
// list asks first: Cancel leaves the piece hidden and the artist private, and
// only Make public publishes it and unticks Keep private (SONA-236).
test('publishing a piece by a Keep private artist asks first', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');

	const name = `Private Piece Artist ${Date.now()}`;
	const created = await page.request.post('/api/artists', { data: { name, ledgerPrivate: true } });
	expect(created.ok()).toBe(true);
	const { id: artistId } = (await created.json()) as { id: number };

	// An unpublished piece by them, through the upload action ("published" is
	// the form's "keep unpublished" box).
	const title = `Unhide Piece ${Date.now()}`;
	const upload = await page.request.post('/admin/upload', {
		form: { title, artistId: String(artistId), count: '1', imageUrl_0: '/x1.png', published: 'on' },
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	expect(upload.status()).toBeLessThan(400);

	await gotoAfterLogin(page, '/admin/images?sort=uploaded&dir=desc');
	// Before hydration the toggle posts without JS, and only the enhanced form
	// turns the 409 into the dialog.
	await waitForHydration(page);
	// The table row; the phone layout repeats the piece in a card list below it.
	const row = page.getByRole('table').getByRole('row').filter({ hasText: title });
	const dialog = page.getByRole('dialog', { name: 'Make a private artist public?' });

	await row.getByRole('button', { name: 'Make public' }).click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(name);
	await page.screenshot({ path: testInfo.outputPath('unhide-dialog.png') });
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await expect(row.getByRole('button', { name: 'Make public' })).toBeVisible();

	await row.getByRole('button', { name: 'Make public' }).click();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(row.getByRole('button', { name: 'Make private' })).toBeVisible();

	await gotoAfterLogin(page, `/admin/artists?q=${encodeURIComponent(name)}`);
	const artistRow = page.getByRole('row').filter({ hasText: name });
	await expect(artistRow).toBeVisible();
	await expect(artistRow.getByText('private', { exact: true })).toHaveCount(0);
});
