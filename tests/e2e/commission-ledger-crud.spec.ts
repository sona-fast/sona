import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';
import { contrastRatio } from './contrast';

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
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await page.getByLabel('Amount').fill('120.00');
	await expect(page.locator('#ce-dates-hint')).toHaveText(
		"When you set the status to Accepted or Delivered and that date is empty, Sona fills in today's date. You can change or clear it. Visitors never see these dates."
	);
	await page.getByLabel('Requested').fill('2026-10-02');

	// Hold the save so a second click and an Enter land while it's in flight.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let posts = 0;
	const createPost = (url: URL) => url.pathname === '/admin/commissions/new';
	await page.route(
		createPost,
		async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posts += 1;
			await held;
			await route.continue();
		}
	);
	const save = page.locator('form.entry-form button[type="submit"]');
	await save.click();
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(save).toBeFocused();
	await save.click({ force: true });
	await page.keyboard.press('Enter');
	await expect(save).toBeFocused();
	expect(posts).toBe(1);
	release();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	expect(posts).toBe(1);
	await page.unroute(createPost);
	// One save, one entry.
	await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toHaveCount(1);
	const row = section(page, 'Active').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Test Artist');
	await expect(row).toContainText('Taro, Thistle');
	await expect(row).toContainText('Applied');
	await expect(row).toContainText('Unpaid');
	await expect(section(page, 'Finished')).toContainText('Entries you mark Delivered, Not picked, or Canceled move here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-created.png'));

	// At tablet width the section is under the 760px the seven columns need, so
	// each row becomes a card: no header row, and the row lays out as a block.
	await page.setViewportSize({ width: 744, height: 1024 });
	await expect(section(page, 'Active').locator('thead')).toBeHidden();
	await expect(row).toHaveCSS('display', 'block');
	await settledShot(page, testInfo.outputPath('commission-ledger-cards-744.png'));
});

test('moving the entry to Delivered lists it under Finished', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// The saved price comes back in its typed form.
	await expect(page.getByLabel('Amount')).toHaveValue('120.00');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).not.toHaveValue('');
	await settledShot(page, testInfo.outputPath('commission-entry-edit.png'));
	await page.getByRole('button', { name: 'Save changes' }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Delivered');
	await expect(row).toContainText('Not in your gallery');
	await expect(section(page, 'Active')).toContainText('Entries you mark Applied, Waitlisted, Accepted, or In progress show here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-finished.png'));
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
	// Clearing the amount leaves the entry with no currency, so Reload entry
	// has to pick the opening currency the way a fresh form does.
	await other.getByLabel('Amount').fill('');
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	// This tab, still on the old copy, changes the note and the payment.
	await page.getByLabel('Notes').fill('Typed before the reload.');
	await page.getByLabel('Payment').selectOption('deposit');

	// Record every text the alert ever shows, from the moment it's added, so a
	// first render with half the message (read out, then rewritten) is caught.
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { alertTexts: string[] }).alertTexts = seen;
		const record = (el: Element) => {
			const text = el.textContent?.trim() ?? '';
			if (seen.at(-1) !== text) seen.push(text);
		};
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
				for (const node of mutation.addedNodes) {
					if (node instanceof Element) node.querySelectorAll('[role="alert"]').forEach(record);
					if (node instanceof Element && node.matches('[role="alert"]')) record(node);
				}
				const alert = target?.closest('[role="alert"]');
				if (alert) record(alert);
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	await page.getByRole('button', { name: 'Save changes' }).click();

	const alert = page.getByRole('alert').filter({ hasText: 'changed after you opened it' });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText("Your note comes with it, but your changes to Payment don't, so enter those again.");
	await expect(alert).toBeFocused();
	const texts = await page.evaluate(() => (window as unknown as { alertTexts: string[] }).alertTexts);
	expect(texts.length, JSON.stringify(texts)).toBeGreaterThan(0);
	expect(texts[0]).toContain('your changes to Payment');
	expect(new Set(texts).size, JSON.stringify(texts)).toBe(1);
	await page.getByText('Why did this happen?').click();
	await expect(
		page.getByText(
			'Another tab or device changed this entry after you opened it. For example, Add to gallery marks an entry Delivered. Saving this older copy would undo that change.',
			{ exact: true }
		)
	).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-stale.png'));

	await page.getByRole('button', { name: 'Reload entry' }).click();
	const notes = page.getByLabel('Notes');
	await expect(notes).toHaveValue('Typed before the reload.');
	await expect(notes).toBeFocused();
	await expect(page.getByLabel('Title')).toHaveValue(`${TITLE} (renamed)`);
	await expect(page.getByLabel('Payment')).toHaveValue('unpaid');
	// No saved entry has a price now, so the browser's region (en-US) is picked.
	await expect(page.getByLabel('Amount')).toHaveValue('');
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await expect(page.getByText("Your note from before the reload isn't saved yet. Save changes to keep it.")).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-reloaded.png'));

	// The reloaded form carries the current version, so this save goes through.
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(section(page, 'Finished').getByRole('row', { name: /renamed/ })).toBeVisible();
});

test('an entry deleted elsewhere: save says so, and delete counts as done', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Both actions answer as the server does once the entry is gone. The stubs
	// never reach the server, so the entry is still there for the next test.
	const missing = { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'failure', status: 404, data: '[{"missing":1},true]' }) };
	const action = (name: string) => (url: URL) => url.pathname.endsWith('/edit') && url.search === `?/${name}`;
	await page.route(action('save'), (route) => route.fulfill(missing));
	await page.route(action('delete'), (route) => route.fulfill(missing));

	await page.getByRole('button', { name: 'Save changes' }).click();
	const alert = page.getByRole('alert').filter({ hasText: 'This entry was deleted somewhere else' });
	await expect(alert).toBeVisible();
	await expect(alert).toBeFocused();
	await expect(alert.getByRole('link', { name: 'Go back to your ledger' })).toHaveAttribute('href', '/admin/commissions');
	await expect(page.getByRole('status').filter({ hasText: "Couldn't save the entry" })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-missing.png'));

	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('status').filter({ hasText: "Couldn't delete the entry" })).toHaveCount(0);
});

// A delete that fails with a server error keeps the form and what was typed in
// it; only the toast says it went wrong.
test('a delete that errors keeps the entry form and unsaved typing', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// The stub never reaches the server, so the entry is still there afterwards.
	await page.route(
		(url) => url.pathname.endsWith('/edit') && url.search === '?/delete',
		(route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { message: 'boom' } }) })
	);
	const notes = page.getByLabel('Notes');
	await notes.fill('typed before a failed delete');
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page.getByRole('status').filter({ hasText: 'Something went wrong' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await expect(notes).toHaveValue('typed before a failed delete');
	await settledShot(page, testInfo.outputPath('commission-entry-delete-error.png'));
});

test('deleting the entry empties the ledger', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Hovered, the label keeps 4.5:1 against what the browser actually paints.
	const deleteButton = page.getByRole('button', { name: 'Delete entry' });
	await deleteButton.hover();
	// The button eases its background, and reduced motion doesn't stop that, so
	// read the colors only once the hover has finished.
	await expect.poll(() => deleteButton.evaluate((el) => el.getAnimations().length)).toBe(0);
	const [color, background, pageBackground] = await deleteButton.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--background)';
		document.body.append(probe);
		const style = getComputedStyle(el);
		const found = [style.color, style.backgroundColor, getComputedStyle(probe).backgroundColor];
		probe.remove();
		return found;
	});
	expect(background).toBe(pageBackground);
	expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
	await deleteButton.click();
	const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
	await expect(dialog).toContainText('Test Artist stays in your artist list');
	await settledShot(page, testInfo.outputPath('commission-entry-delete.png'));
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-ledger-emptied.png'));
});

test('Other currency finds a currency, and Add New Artist makes a private artist for the entry', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');

	// No saved entry has a price now, so the row leads with the browser's region.
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await expect(page.locator('#ce-currency-hint')).toHaveText('Pick the currency the artist charges in.');

	// Other currency: search by code, Escape closes back to the button, Enter picks.
	const other = page.getByRole('button', { name: 'Other currency' });
	await other.click();
	const find = page.getByRole('combobox', { name: 'Find a currency' });
	const results = page.getByRole('listbox', { name: 'Find a currency' });
	await expect(find).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(find).toBeHidden();
	await expect(other).toBeFocused();
	// Down and Up move through the list and wrap at both ends; Enter picks the
	// active option.
	await other.click();
	const options = results.getByRole('option');
	const firstId = (await options.first().getAttribute('id'))!;
	const secondId = (await options.nth(1).getAttribute('id'))!;
	const lastId = (await options.last().getAttribute('id'))!;
	await expect(find).toHaveAttribute('aria-activedescendant', firstId);
	await page.keyboard.press('ArrowUp');
	await expect(find).toHaveAttribute('aria-activedescendant', lastId);
	await page.keyboard.press('ArrowDown');
	await expect(find).toHaveAttribute('aria-activedescendant', firstId);
	await page.keyboard.press('ArrowDown');
	await expect(find).toHaveAttribute('aria-activedescendant', secondId);
	// The active option is visible: its edge stands out from the list at 3:1,
	// where an inactive option's edge doesn't show at all.
	const edgeOf = (id: string) =>
		page.locator(`[id="${id}"]`).evaluate((el) => getComputedStyle(el).borderTopColor);
	const listBackground = await results.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(contrastRatio(await edgeOf(secondId), listBackground)).toBeGreaterThanOrEqual(3);
	expect(await edgeOf(firstId)).not.toBe(await edgeOf(secondId));
	await page.keyboard.press('Enter');
	const secondCode = secondId.replace('ce-currency-opt-', '');
	await expect(page.getByRole('radio', { name: new RegExp(secondCode) })).toBeChecked();
	// With nothing matching, there's no list, only the count saying so.
	await other.click();
	await find.fill('zzzz');
	await expect(results).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'No currency matches “zzzz”.' })).toBeVisible();
	await find.fill('krw');
	await expect(results.getByRole('option')).toHaveCount(1);
	await page.keyboard.press('Enter');
	const krw = page.getByRole('radio', { name: /KRW/ });
	await expect(krw).toBeChecked();
	await expect(krw).toBeFocused();
	await expect(page.locator('#ce-price-hint')).toHaveText(/^KRW amounts are whole numbers\./);
	// The list marks the current currency in words, not only with a check.
	await other.click();
	await find.fill('krw');
	await expect(results.getByRole('option', { name: /KRW.*\(current\)/ })).toBeVisible();
	// Names start in one column: A$ has a symbol and BBD has none, yet their
	// names line up. With no symbol among the matches, the name moves up
	// beside the code instead of leaving a gap.
	await find.fill('dollar');
	const nameX = (code: string) =>
		results.locator(`[id="ce-currency-opt-${code}"] .name`).evaluate((el) => el.getBoundingClientRect().left);
	const withSymbols = await nameX('AUD');
	expect(await nameX('BBD')).toBe(withSymbols);
	// A name in the admin language matches too.
	await find.fill('swiss');
	expect(await nameX('CHF')).toBeLessThan(withSymbols);
	await results.getByRole('option', { name: /CHF/ }).click();
	// CHF prints as its own code, so the pill and the amount field each say
	// it once, not "CHF CHF".
	const chfPill = page.locator('label.option', { has: page.getByRole('radio', { name: /CHF/ }) });
	await expect(chfPill.getByRole('radio')).toBeChecked();
	const countChf = (text: string) => text.split('CHF').length - 1;
	expect(countChf(await chfPill.innerText())).toBe(1);
	expect(countChf(await page.locator('.field-pill.amount').innerText())).toBe(1);
	await settledShot(page, testInfo.outputPath('commission-entry-currency-picked.png'));
	// Back to the won, which the entry below is priced in.
	await krw.check();

	// Add New Artist: focus lands in the dialog, so Escape closes it.
	const addArtist = page.getByRole('button', { name: 'Add New Artist' });
	await addArtist.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Artist Name')).toBeFocused();
	// Tab stays inside the dialog: back past its first control wraps to its last.
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.locator(':focus')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(addArtist).toBeFocused();

	await addArtist.click();
	// An entry's artist starts private, so a sync can't share them before Save.
	await expect(dialog.getByLabel('Keep private (commission ledger only)')).toBeChecked();
	await dialog.getByLabel('Artist Name').fill('E2E Private Artist');
	await settledShot(page, testInfo.outputPath('commission-entry-new-artist.png'));
	await dialog.getByRole('button', { name: 'Create Artist' }).click();
	await expect(dialog).toBeHidden();
	const artist = page.getByLabel('Artist', { exact: true });
	await expect(artist.locator('option:checked')).toHaveText('E2E Private Artist');
	await expect(artist).toBeFocused();

	await page.getByLabel('Title').fill('E2E won entry');
	await page.getByLabel('Amount').fill('50000');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Active').getByRole('row', { name: /E2E won entry/ });
	await expect(row).toContainText('E2E Private Artist');

	// The artist was stored private.
	await open(page, '/admin/artists');
	await page
		.getByRole('row', { name: /E2E Private Artist/ })
		.getByRole('button', { name: 'Edit artist' })
		.click();
	// The Edit Artist modal has no dialog role, so the label alone finds it.
	await expect(page.getByLabel('Keep private (commission ledger only)')).toBeChecked();

	// Back on a new entry, the row leads with the newest saved currency.
	await open(page, '/admin/commissions/new');
	await expect(page.getByRole('radio').first()).toHaveAccessibleName(/KRW/);
	await expect(page.getByRole('radio', { name: /KRW/ })).toBeChecked();
	await expect(page.locator('#ce-currency-hint')).toHaveText('The currencies you used most recently show first.');

	// A Japanese owner finds the yen by its Japanese name.
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	try {
		await open(page, '/admin/commissions/new');
		await page.getByRole('button', { name: 'その他の通貨' }).click();
		await page.getByRole('combobox', { name: '通貨を検索' }).fill('円');
		await expect(page.getByRole('listbox', { name: '通貨を検索' }).getByRole('option', { name: /JPY/ })).toBeVisible();
	} finally {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', domain: 'localhost', path: '/' }]);
	}
});

// Without JavaScript, a row pick and a different Other currency pick are
// refused together. The refused page keeps the row pick and clears the select,
// so the refusal's "To use KRW, save again" has to save the row's currency.
test('without JavaScript, saving again after a two-currency refusal saves the row pick', async ({ page, browser }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		const noJs = await context.newPage();
		await noJs.goto('/admin/commissions/new');
		await noJs.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
		await noJs.getByLabel('Title').fill('E2E no-JS save again');
		// The won entry above leads the row and opens picked.
		const krw = noJs.getByRole('radio', { name: /KRW/ });
		await expect(krw).toBeChecked();
		const otherSelect = noJs.getByRole('combobox', { name: 'Other currency' });
		await otherSelect.selectOption('JPY');
		await noJs.getByLabel('Amount').fill('7000');
		await noJs.getByRole('button', { name: 'Save entry' }).click();
		await noJs.waitForLoadState();
		await expect(
			noJs.getByText('You picked KRW and also chose JPY under Other currency. To use JPY, pick Other currency and choose JPY again. To use KRW, save again.')
		).toBeVisible();
		await expect(krw).toBeChecked();
		await expect(otherSelect).toHaveValue('');

		await noJs.getByRole('button', { name: 'Save entry' }).click();
		await expect(noJs).toHaveURL(/\/admin\/commissions$/);
		await noJs.getByRole('link', { name: /^Edit E2E no-JS save again/ }).click();
		await expect(noJs.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
		await expect(noJs.getByRole('radio', { name: /KRW/ })).toBeChecked();
		await expect(noJs.getByLabel('Amount')).toHaveValue('7000');
		await settledShot(noJs, testInfo.outputPath('commission-entry-nojs-saved-again.png'));
	} finally {
		await context.close();
	}
});

// Without JavaScript the Other currency select is a plain field, so a crafted or
// stale post can carry a malformed code. The refusal has to come back as the
// form with its currency error, not an error page from the picker rendering it.
test('a malformed currency code comes back as a field error, not an error page', async ({ page, baseURL }) => {
	await loginRetrying(page, PASSWORD);
	const res = await page.request.post('/admin/commissions/new', {
		form: { title: 'E2E bad currency', price: '10', currency: '__other', currencyOther: 'XYZ1' },
		headers: { origin: baseURL!, accept: 'text/html' },
		maxRedirects: 0
	});
	expect(res.status()).toBe(400);
	expect(await res.text()).toContain('Use a three-letter currency code, like USD or EUR.');
});
