import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';

// Saving an existing commission entry (SONA-236 PR 2): a save that errors, a
// refused amount, a cleared price, a currency outside the row, the New Artist
// dialog, and the no-JavaScript paths, including an out-of-date save. Runs on
// the writable 'commissions' server beside commission-ledger-crud.spec.ts.
// Each test makes its own entries, with titles no other test uses, and
// deletes them at the end, so the CRUD spec's empty-ledger checks hold in
// either order. Each test saves a screenshot under test-results.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

/** Entries this test made, deleted when it ends. */
let made: number[] = [];

test.afterEach(async ({ page, baseURL }) => {
	for (const id of made) {
		const res = await page.request.post(`/admin/commissions/${id}/edit?/delete`, {
			form: {},
			headers: { origin: baseURL!, accept: 'text/html' },
			maxRedirects: 0
		});
		expect(res.status(), `entry ${id} deletes`).toBe(303);
	}
	made = [];
});

async function open(page: Page, url: string) {
	await gotoAfterLogin(page, url);
	await waitForHydration(page);
}

/** Saves an entry for Test Artist the way a no-JS form posts it, and returns its id. */
async function createEntry(page: Page, baseURL: string, title: string, fields: Record<string, string> = {}) {
	const form = await page.request.get('/admin/commissions/new');
	const artistId = (await form.text()).match(/<option value="(\d+)"[^>]*>Test Artist<\/option>/)?.[1];
	expect(artistId, 'Test Artist is in the artist select').toBeDefined();
	const res = await page.request.post('/admin/commissions/new', {
		form: { artistId: artistId!, title, status: 'applied', payment: 'unpaid', price: '', currency: '', ...fields },
		headers: { origin: baseURL, accept: 'text/html' },
		maxRedirects: 0
	});
	expect(res.status(), `${title} saves`).toBe(303);
	const list = await (await page.request.get('/admin/commissions')).text();
	const id = list.match(new RegExp(`href="/admin/commissions/(\\d+)/edit"[^>]*aria-label="Edit ${title}"`))?.[1];
	expect(id, `${title} lists with an Edit link`).toBeDefined();
	made.push(Number(id));
	return Number(id);
}

/** Picks `code` in the currency field: from the row when it's there, else
 * through Other currency, since the row holds only recently used currencies. */
async function pickCurrency(page: Page, code: string) {
	const radio = page.getByRole('radio', { name: new RegExp(code) });
	if ((await radio.count()) === 0) {
		await page.getByRole('button', { name: 'Other currency' }).click();
		await page.getByRole('combobox', { name: 'Find a currency' }).fill(code);
		await page.getByRole('listbox', { name: 'Find a currency' }).getByRole('option', { name: new RegExp(`^${code}`) }).click();
	} else await radio.check();
	await expect(radio).toBeChecked();
}

for (const [name, answer] of [
	['the connection drops', 'abort'],
	['the server errors', { status: 500, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } }) }]
] as const) {
	test(`when ${name} on Save changes, the edit form keeps what was typed and says so`, async ({ page, baseURL }, testInfo) => {
		await loginRetrying(page, PASSWORD);
		const title = `E2E save error, ${name}`;
		const id = await createEntry(page, baseURL!, title);
		await open(page, `/admin/commissions/${id}/edit`);

		await page.route(
			(url) => url.pathname.endsWith('/edit') && url.search === '?/save',
			(route: Route) => (answer === 'abort' ? route.abort('connectionreset') : route.fulfill(answer))
		);
		await page.getByLabel('Title').fill(`${title} (typed)`);
		await page.getByLabel('Notes').fill('typed before a failed save');
		await page.getByRole('button', { name: 'Save changes' }).click();

		await expect(page.getByRole('status').filter({ hasText: "Something went wrong, so the entry wasn't saved." })).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
		await expect(page.getByLabel('Title')).toHaveValue(`${title} (typed)`);
		await expect(page.getByLabel('Notes')).toHaveValue('typed before a failed save');
		await expect(page.getByRole('button', { name: 'Save changes' })).toBeFocused();
		await settledShot(page, testInfo.outputPath('commission-edit-save-error.png'));

		// Once the server answers again, the same typing saves.
		await page.unrouteAll();
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page).toHaveURL(/\/admin\/commissions$/);
		await expect(page.getByRole('link', { name: `Edit ${title} (typed)` })).toBeVisible();
	});
}

test('an amount refused for its currency saves once the currency takes decimals', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E decimals entry');
	await open(page, `/admin/commissions/${id}/edit`);

	await pickCurrency(page, 'JPY');
	const amount = page.getByLabel('Amount');
	await amount.fill('10.5');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.locator('#ce-price-err')).toHaveText("JPY amounts don't use decimals. Enter a whole number.");
	await expect(amount).toBeFocused();
	await expect(amount).toHaveValue('10.5');

	// The hint follows the currency at once, and the JPY refusal goes with the
	// JPY pick; the server checks again on Save.
	await pickCurrency(page, 'USD');
	await expect(page.locator('#ce-price-hint')).toHaveText(/^USD amounts can have up to 2 decimal places/);
	await expect(page.getByText("JPY amounts don't use decimals")).toHaveCount(0);
	await expect(amount).not.toHaveAttribute('aria-invalid', 'true');
	await expect(amount).toHaveAccessibleDescription(/^USD amounts can have up to 2 decimal places/);
	await settledShot(page, testInfo.outputPath('commission-edit-currency-changed.png'));
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);

	await open(page, `/admin/commissions/${id}/edit`);
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await expect(page.getByLabel('Amount')).toHaveValue('10.50');
});

test('an amount that is not a number stays refused when the currency changes', async ({ page, baseURL }) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E unreadable amount');
	await open(page, `/admin/commissions/${id}/edit`);

	await pickCurrency(page, 'JPY');
	const amount = page.getByLabel('Amount');
	await amount.fill('about 10');
	await page.getByRole('button', { name: 'Save changes' }).click();
	const error = page.locator('#ce-price-err');
	await expect(error).toHaveText(/^Enter the amount as a number/);

	// Wrong in any currency, so it stays until the next save.
	await pickCurrency(page, 'USD');
	await expect(error).toHaveText(/^Enter the amount as a number/);
	await expect(amount).toHaveAttribute('aria-invalid', 'true');
});

test('a grouped amount and a full-width one save as plain numbers', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	for (const [title, currency, typed, stored] of [
		['E2E grouped amount', 'USD', '1,234.50', '1234.50'],
		['E2E full-width amount', 'JPY', '４５', '45']
	] as const) {
		const id = await createEntry(page, baseURL!, title);
		await open(page, `/admin/commissions/${id}/edit`);
		await pickCurrency(page, currency);
		await page.getByLabel('Amount').fill(typed);
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page).toHaveURL(/\/admin\/commissions$/);

		await open(page, `/admin/commissions/${id}/edit`);
		await expect(page.getByRole('radio', { name: new RegExp(currency) })).toBeChecked();
		await expect(page.getByLabel('Amount')).toHaveValue(stored);
	}
	await settledShot(page, testInfo.outputPath('commission-edit-normalized-amount.png'));
});

/** The id of the entry listed as `title`, read from the ledger's Edit link. */
async function listedId(page: Page, title: string) {
	const list = await (await page.request.get('/admin/commissions')).text();
	const id = list.match(new RegExp(`href="/admin/commissions/(\\d+)/edit"[^>]*aria-label="Edit ${title}"`))?.[1];
	expect(id, `${title} lists with an Edit link`).toBeDefined();
	return Number(id);
}

// Where it's happening takes plain text for a chat with no message links.
// fixtures/commissions.sql gives Chat Artist (54) a Telegram link.
test("a place typed as text saves as text, never looks up an artist, and offers the artist's chat", async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const lookups: string[] = [];
	page.on('request', (r) => {
		if (new URL(r.url()).pathname === '/api/admin/artist-from-link') lookups.push(r.postData() ?? '');
	});
	await open(page, '/admin/commissions/new');
	const title = 'E2E plain text place';
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Chat Artist' });
	await page.getByLabel('Title').fill(title);
	const place = page.getByLabel("Where it's happening");
	await place.fill('Telegram DM');
	await place.blur();
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const id = await listedId(page, title);
	made.push(id);

	await open(page, `/admin/commissions/${id}/edit`);
	await expect(place).toHaveValue('Telegram DM');
	const chat = page.getByRole('link', { name: 'Open chat with Chat Artist on Telegram (opens in a new tab)' });
	await expect(chat).toHaveText('Open chat');
	await expect(chat).toHaveAttribute('href', 'https://t.me/e2e_chat_artist');
	await expect(chat).toHaveAttribute('target', '_blank');
	await settledShot(page, testInfo.outputPath('commission-edit-plain-place.png'));

	// Another artist picked, the saved artist's chat would be the wrong one.
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await expect(chat).toHaveCount(0);
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Chat Artist' });
	// A link in the field is the place itself, so there's no chat to offer.
	await place.fill('https://example.com/opening');
	await expect(chat).toHaveCount(0);
	expect(lookups, 'plain text never goes to the artist lookup').toEqual([]);
});

test('Kind suggests kinds already used, and still takes a new one', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await createEntry(page, baseURL!, 'E2E kind older', { kind: 'e2e painted bust' });
	await createEntry(page, baseURL!, 'E2E kind newer', { kind: 'E2E Painted bust' });

	await open(page, '/admin/commissions/new');
	const kind = page.getByLabel('Kind');
	await expect(kind).toHaveAttribute('placeholder', 'Painted bust, icon, ref sheet...');
	await expect(kind).toHaveAttribute('list', 'ce-kind-list');
	// One suggestion per kind whatever its letter case, in the spelling used last.
	const offered = page.locator('#ce-kind-list option');
	expect(await offered.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toContain('E2E Painted bust');
	expect(
		await offered.evaluateAll((els) => els.filter((el) => (el as HTMLOptionElement).value.toLowerCase() === 'e2e painted bust').length)
	).toBe(1);
	await settledShot(page, testInfo.outputPath('commission-kind-suggestions.png'));

	// A suggestion is only a suggestion: a new kind saves as typed.
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill('E2E kind new');
	await kind.fill('E2E chibi');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const id = await listedId(page, 'E2E kind new');
	made.push(id);
	await open(page, `/admin/commissions/${id}/edit`);
	await expect(kind).toHaveValue('E2E chibi');
	expect(await page.locator('#ce-kind-list option').evaluateAll((els) => (els[0] as HTMLOptionElement).value)).toBe('E2E chibi');
});

test('a receipt link saves beside Payment, and plain text there is refused', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill('E2E receipt');
	const receipt = page.getByLabel('Receipt or order link');
	await expect(receipt).toHaveAccessibleDescription('A Ko-fi order or other page that shows what you paid.');

	await receipt.fill('Paid on Ko-fi');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page.locator('#ce-receiptUrl-err')).toHaveText("Sona couldn't read this link. Fix it or clear it.");
	await expect(receipt).toBeFocused();

	await receipt.fill('ko-fi.com/s/e2e0001');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const id = await listedId(page, 'E2E receipt');
	made.push(id);
	await open(page, `/admin/commissions/${id}/edit`);
	await expect(receipt).toHaveValue('https://ko-fi.com/s/e2e0001');
	await settledShot(page, testInfo.outputPath('commission-edit-receipt.png'));
});

test('clearing the amount saves the entry with no price', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E cleared price', { price: '45.50', currency: 'EUR' });
	await open(page, `/admin/commissions/${id}/edit`);
	await expect(page.getByLabel('Amount')).toHaveValue('45.50');
	await expect(page.getByRole('radio', { name: /EUR/ })).toBeChecked();

	await page.getByLabel('Amount').fill('');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);

	// The edit page's own HTML carries what's stored: no amount, no currency.
	const html = await (await page.request.get(`/admin/commissions/${id}/edit`)).text();
	expect(html).toMatch(/id="ce-price"[^>]*value=""/);
	await open(page, `/admin/commissions/${id}/edit`);
	await expect(page.getByLabel('Amount')).toHaveValue('');
	await settledShot(page, testInfo.outputPath('commission-edit-price-cleared.png'));
});

test('an entry in a currency the row has dropped opens with it picked, and saves it again', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	// CHF first, then four newer currencies push it out of the recent row.
	const id = await createEntry(page, baseURL!, 'E2E franc entry', { price: '80.00', currency: 'CHF' });
	for (const code of ['AUD', 'CAD', 'NZD', 'SGD']) await createEntry(page, baseURL!, `E2E row filler ${code}`, { price: '1', currency: code });

	await open(page, '/admin/commissions/new');
	await expect(page.getByRole('radio', { name: /CHF/ })).toHaveCount(0);

	await open(page, `/admin/commissions/${id}/edit`);
	const chf = page.getByRole('radio', { name: /CHF/ });
	await expect(page.getByRole('radio').first()).toHaveAccessibleName(/CHF/);
	await expect(chf).toBeChecked();
	await expect(page.getByLabel('Amount')).toHaveValue('80.00');
	await settledShot(page, testInfo.outputPath('commission-edit-dropped-currency.png'));

	await page.getByLabel('Notes').fill('still in francs');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await open(page, `/admin/commissions/${id}/edit`);
	await expect(page.getByRole('radio', { name: /CHF/ })).toBeChecked();
	await expect(page.getByLabel('Amount')).toHaveValue('80.00');
	await expect(page.getByLabel('Notes')).toHaveValue('still in francs');
});

test("the New Artist dialog's Escape, Cancel, and a failed create keep the entry's typing", async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const artist = page.getByLabel('Artist', { exact: true });
	await artist.selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill('E2E dialog typing');
	await page.getByLabel('Notes').fill('typed before the dialog');
	await page.getByLabel('Amount').fill('25');
	const kept = async () => {
		await expect(page.getByLabel('Title')).toHaveValue('E2E dialog typing');
		await expect(page.getByLabel('Notes')).toHaveValue('typed before the dialog');
		await expect(page.getByLabel('Amount')).toHaveValue('25');
	};

	const addArtist = page.getByRole('button', { name: 'Add New Artist' });
	const dialog = page.getByRole('dialog');
	await addArtist.click();
	await dialog.getByLabel('Artist Name').fill('E2E abandoned artist');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await kept();
	await expect(artist.locator('option:checked')).toHaveText('Test Artist');

	await addArtist.click();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await kept();

	// The create fails: the dialog stays open and says so, and the entry form
	// under it is untouched.
	await page.route('**/api/artists', (route) =>
		route.request().method() === 'POST' ? route.fulfill({ status: 500, body: '' }) : route.continue()
	);
	await addArtist.click();
	await dialog.getByLabel('Artist Name').fill('E2E failed artist');
	await dialog.getByRole('button', { name: 'Create Artist' }).click();
	await expect(dialog.getByText('Could not create artist.')).toBeVisible();
	await expect(dialog.getByLabel('Artist Name')).toHaveValue('E2E failed artist');
	await settledShot(page, testInfo.outputPath('commission-entry-artist-create-failed.png'));
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await kept();
	await expect(artist.locator('option', { hasText: 'E2E failed artist' })).toHaveCount(0);

	// Created for real, the artist is picked and the typing stays.
	await page.unrouteAll();
	const name = `E2E dialog artist ${Date.now()}`;
	await addArtist.click();
	await dialog.getByLabel('Artist Name').fill(name);
	await dialog.getByRole('button', { name: 'Create Artist' }).click();
	await expect(dialog).toBeHidden();
	await expect(artist.locator('option:checked')).toHaveText(name);
	await kept();
	await settledShot(page, testInfo.outputPath('commission-entry-artist-created.png'));
});

test('without JavaScript, a refused edit saves once fixed', async ({ page, browser, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E no-JS edit', { price: '500', currency: 'JPY' });
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		const noJs = await context.newPage();
		await noJs.goto(`/admin/commissions/${id}/edit`);
		await noJs.getByLabel('Amount').fill('500.5');
		await noJs.getByLabel('Notes').fill('no-JS note');
		const refused = noJs.waitForResponse((res) => res.request().method() === 'POST');
		await noJs.getByRole('button', { name: 'Save changes' }).click();
		expect((await refused).status()).toBe(400);
		await noJs.waitForLoadState();
		await expect(noJs.locator('#ce-price-err')).toHaveText("JPY amounts don't use decimals. Enter a whole number.");
		await expect(noJs.getByLabel('Notes')).toHaveValue('no-JS note');
		await expect(noJs.getByRole('radio', { name: /JPY/ })).toBeChecked();

		// The refused page carries the version the form loaded with, so the
		// fixed save goes through.
		await noJs.getByLabel('Amount').fill('501');
		await noJs.getByRole('button', { name: 'Save changes' }).click();
		await expect(noJs).toHaveURL(/\/admin\/commissions$/);
		await noJs.goto(`/admin/commissions/${id}/edit`);
		await expect(noJs.getByLabel('Amount')).toHaveValue('501');
		await expect(noJs.getByLabel('Notes')).toHaveValue('no-JS note');
		await settledShot(noJs, testInfo.outputPath('commission-edit-nojs-fixed.png'));
	} finally {
		await context.close();
	}
});

// Without the page's script, Delete entry is a link to the same page, which
// draws the dialog's confirmation in the page with a form that posts.
test('without JavaScript, Delete entry deletes the entry after a confirmation', async ({ page, browser, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E no-JS delete');
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		const noJs = await context.newPage();
		await noJs.goto(`/admin/commissions/${id}/edit`);
		const deleteEntry = noJs.getByRole('link', { name: 'Delete entry' });

		// Cancel leaves the entry as it was.
		await deleteEntry.click();
		const confirm = noJs.getByRole('region', { name: 'Delete this entry?' });
		await expect(confirm).toContainText('This permanently removes “E2E no-JS delete” from your ledger');
		await confirm.getByRole('link', { name: 'Cancel' }).click();
		await expect(noJs).toHaveURL(new RegExp(`/admin/commissions/${id}/edit$`));
		await expect(confirm).toHaveCount(0);

		await deleteEntry.click();
		await expect(confirm).toBeVisible();
		await settledShot(noJs, testInfo.outputPath('commission-edit-nojs-delete-confirm.png'));
		await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(noJs).toHaveURL(/\/admin\/commissions$/);
		await expect(noJs.getByRole('link', { name: 'Edit E2E no-JS delete' })).toHaveCount(0);
		made = [];
		await settledShot(noJs, testInfo.outputPath('commission-edit-nojs-deleted.png'));
	} finally {
		await context.close();
	}
});

// The save's 404 renders the page again, and the load hands it a gone entry
// rather than 404ing, so the form stays with what was typed.
test('without JavaScript, saving an entry deleted elsewhere says so', async ({ page, browser, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E no-JS gone');
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		const noJs = await context.newPage();
		await noJs.goto(`/admin/commissions/${id}/edit`);
		// Another tab deletes it.
		const deleted = await page.request.post(`/admin/commissions/${id}/edit?/delete`, {
			form: {},
			headers: { origin: baseURL!, accept: 'text/html' },
			maxRedirects: 0
		});
		expect(deleted.status()).toBe(303);
		made = [];

		await noJs.getByLabel('Notes').fill('typed on a deleted entry');
		const answer = noJs.waitForResponse((res) => res.request().method() === 'POST');
		await noJs.getByRole('button', { name: 'Save changes' }).click();
		expect((await answer).status()).toBe(404);
		await noJs.waitForLoadState();
		// As with JavaScript on: the alert says why, and links back to the ledger.
		const alert = noJs.getByRole('alert').filter({ hasText: 'This entry was deleted somewhere else' });
		await expect(alert).toBeVisible();
		await expect(alert.getByRole('link', { name: 'Go back to your ledger' })).toHaveAttribute('href', '/admin/commissions');
		await expect(noJs.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
		await expect(noJs.getByLabel('Notes')).toHaveValue('typed on a deleted entry');
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS gone');
		await settledShot(noJs, testInfo.outputPath('commission-edit-nojs-gone.png'));
	} finally {
		await context.close();
	}
});

test('without JavaScript, an out-of-date save keeps the typing, and Reload entry loads the current entry', async ({ page, browser, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const id = await createEntry(page, baseURL!, 'E2E no-JS stale');
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		// The no-JS tab opens the form first.
		const noJs = await context.newPage();
		await noJs.goto(`/admin/commissions/${id}/edit`);

		// Another tab renames the entry.
		await open(page, `/admin/commissions/${id}/edit`);
		await page.getByLabel('Title').fill('E2E no-JS stale (renamed)');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page).toHaveURL(/\/admin\/commissions$/);

		await noJs.getByLabel('Notes').fill('typed on the old copy');
		const refused = noJs.waitForResponse((res) => res.request().method() === 'POST');
		await noJs.getByRole('button', { name: 'Save changes' }).click();
		expect((await refused).status()).toBe(409);
		await noJs.waitForLoadState();

		const alert = noJs.getByRole('alert').filter({ hasText: 'changed after you opened it' });
		await expect(alert).toBeVisible();
		await expect(noJs.getByLabel('Notes')).toHaveValue('typed on the old copy');
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS stale');
		await settledShot(noJs, testInfo.outputPath('commission-edit-nojs-stale.png'));

		// The alert says to select Reload entry; without a script it still has
		// to load the entry as it is now.
		const reload = noJs.getByRole('link', { name: 'Reload entry' });
		await expect(reload).toBeVisible();
		await reload.click();
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS stale (renamed)');
		await expect(noJs.getByRole('alert').filter({ hasText: 'changed after you opened it' })).toHaveCount(0);
		await noJs.getByLabel('Notes').fill('typed after the reload');
		await noJs.getByRole('button', { name: 'Save changes' }).click();
		await expect(noJs).toHaveURL(/\/admin\/commissions$/);
		await noJs.goto(`/admin/commissions/${id}/edit`);
		await expect(noJs.getByLabel('Notes')).toHaveValue('typed after the reload');
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS stale (renamed)');
	} finally {
		await context.close();
	}
});
