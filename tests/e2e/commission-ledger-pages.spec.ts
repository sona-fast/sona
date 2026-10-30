import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { adminLogin, gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';
import { failOnPageErrors } from './page-errors';

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

failOnPageErrors();

test('the ledger lists nothing yet and says who can read it', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions');

	await expect(page.getByRole('heading', { level: 1, name: 'Commissions' })).toBeVisible();
	await expect(page.getByText(/Visitors never see your commission ledger/)).toBeVisible();
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'New entry' })).toHaveAttribute('href', '/admin/commissions/new');
	// The sidebar names the page after Artists.
	const nav = page.locator('.sidebar-nav a');
	const labels = await nav.allInnerTexts();
	expect(labels.map((l) => l.trim()).indexOf('Commissions')).toBe(labels.map((l) => l.trim()).indexOf('Artists') + 1);

	await settledShot(page, testInfo.outputPath('commission-ledger-empty.png'));
});

test('with no artists yet, the form points to the Artists page', async ({ page }, testInfo) => {
	// The shared seed has artists and is read-only, so the page's data comes back
	// with the artist list emptied. A client-side navigation loads it from
	// __data.json, the one response a spec can rewrite.
	await page.route('**/admin/commissions/new/__data.json*', async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		let emptied = false;
		for (const node of body.nodes ?? []) {
			const root = node?.type === 'data' ? node.data?.[0] : undefined;
			if (root && typeof root === 'object' && 'artists' in root) {
				node.data[root.artists] = [];
				emptied = true;
			}
		}
		if (!emptied) throw new Error('no artists list in the page data to empty');
		await route.fulfill({ response, json: body });
	});
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions');
	await waitForHydration(page);
	await page.getByRole('link', { name: 'New entry' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();

	const artist = page.getByLabel('Artist', { exact: true });
	await expect(artist.locator('option')).toHaveCount(1);
	const hint = page.locator('#ce-no-artists');
	await expect(hint).toContainText("You haven't added any artists yet.");
	await expect(artist).toHaveAttribute('aria-describedby', /ce-no-artists/);
	await expect(hint.getByRole('link', { name: 'Artists page' })).toHaveAttribute('href', '/admin/artists');
	await settledShot(page, testInfo.outputPath('commission-entry-no-artists.png'));
});

test("moving an entry to Accepted fills today's date, and a set date stays", async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/new');
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

	// Delivered fills its own date only; the Accepted date the owner changed stays.
	await accepted.fill('2026-01-01');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(delivered).toHaveValue(today);
	await expect(accepted).toHaveValue('2026-01-01');

	// A Delivered date the owner already typed is kept.
	await page.getByLabel('Status').selectOption('in_progress');
	await delivered.fill('2026-01-02');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(delivered).toHaveValue('2026-01-02');

	await settledShot(page, testInfo.outputPath('commission-entry-dates.png'));
});

test('a refused price shows its error on the field, and nothing is saved', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/new');
	// The status select and use:enhance are client-side: before hydration a pick
	// fills nothing and a save posts natively.
	await waitForHydration(page);
	await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();

	await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
	await page.getByLabel('Title').fill('E2E refused price');
	// The browser asks for en-US, so the row opens on USD before anything's saved.
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await page.getByRole('radio', { name: /JPY/ }).check();
	// The hint gives the picked currency's rule before Save.
	await expect(page.locator('#ce-price-hint')).toHaveText(/^JPY amounts are whole numbers\./);
	await expect(page.getByLabel('Amount')).toHaveAttribute('inputmode', 'numeric');
	await page.getByLabel('Amount').fill('45.5');
	await page.getByRole('button', { name: 'Save entry' }).click();

	const price = page.getByLabel('Amount');
	await expect(price).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByText("JPY amounts don't use decimals. Enter a whole number.")).toBeVisible();
	await expect(price).toHaveAttribute('aria-describedby', /ce-price-err/);
	// Focus moves to the first field with an error.
	await expect(price).toBeFocused();
	// The field's edge, and its focus ring, are drawn in the theme's --destructive.
	// The amount sits in a pill with its currency, and the pill draws both.
	const [edge, ring, destructive] = await price.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--destructive)';
		document.body.append(probe);
		const style = getComputedStyle(el.parentElement!);
		const found = [style.borderTopColor, style.outlineColor, getComputedStyle(probe).color];
		probe.remove();
		return found;
	});
	expect(edge).toBe(destructive);
	expect(ring).toBe(destructive);
	await settledShot(page, testInfo.outputPath('commission-entry-price-error.png'));

	await page.goto('/admin/commissions');
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
});

// Before hydration, or with JavaScript off, the form posts natively and the
// server renders the refusal: the typing and the field's error both have to be
// in that HTML.
test('without JavaScript, a refused save keeps what was typed and shows the error', async ({ page, browser }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState(),
		javaScriptEnabled: false
	});
	try {
		const noJs = await context.newPage();
		await noJs.goto('/admin/commissions/new');
		// Nothing fills a date without the page's script, so the hint doesn't
		// promise it.
		await expect(noJs.locator('#ce-dates-hint')).toHaveText('Visitors never see these dates.');
		await noJs.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
		await noJs.getByLabel('Title').fill('E2E no-JS title');
		await noJs.getByLabel('Notes').fill('E2E no-JS note');
		// A row radio (the regional one) is already picked. Choosing in the
		// select without picking Other currency is refused, not saved as either.
		await expect(noJs.getByRole('radio', { name: /USD/ })).toBeChecked();
		await noJs.getByRole('combobox', { name: 'Other currency' }).selectOption('KRW');
		await noJs.getByLabel('Amount').fill('45.5');
		await noJs.getByRole('button', { name: 'Save entry' }).click();
		await noJs.waitForLoadState();
		await expect(
			noJs.getByText('You picked USD and also chose KRW under Other currency. To use KRW, pick Other currency and choose KRW again. To use USD, save again.')
		).toBeVisible();
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS title');
		// The refused page keeps the row pick and clears the select, so saving
		// again saves USD (the commission-ledger-crud spec saves it), and the
		// copy asks for the select again to use KRW.
		await expect(noJs.getByRole('radio', { name: /USD/ })).toBeChecked();
		const otherSelect = noJs.getByRole('combobox', { name: 'Other currency' });
		await expect(otherSelect).toHaveValue('');
		// The select is part of the refused field, so it carries the error too.
		await expect(otherSelect).toHaveAttribute('aria-invalid', 'true');
		await expect(otherSelect).toHaveAttribute('aria-describedby', /\bce-currency-err\b/);
		// Without a script, Other currency is a radio in the row plus a plain
		// select, and the select counts when that radio is picked.
		await noJs.getByRole('combobox', { name: 'Other currency' }).selectOption('KRW');
		await noJs.getByRole('radio', { name: 'Other currency' }).check();
		await noJs.getByLabel('Amount').fill('45.5');
		await noJs.getByRole('button', { name: 'Save entry' }).click();
		await noJs.waitForLoadState();

		await expect(noJs.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS title');
		await expect(noJs.getByLabel('Notes')).toHaveValue('E2E no-JS note');
		await expect(noJs.getByLabel('Amount')).toHaveValue('45.5');
		await expect(noJs.getByLabel('Amount')).toHaveAttribute('aria-invalid', 'true');
		await expect(noJs.getByText("KRW amounts don't use decimals. Enter a whole number.")).toBeVisible();
		// The refused page keeps the Other pick, as a picked option in the row.
		await expect(noJs.getByRole('radio', { name: /KRW/ })).toBeChecked();
		await settledShot(noJs, testInfo.outputPath('commission-entry-nojs-error.png'));
	} finally {
		await context.close();
	}

	await page.goto('/admin/commissions');
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
});

/** Answers the create form's POST with `answer`, without reaching the server. */
async function stubCreate(page: Page, answer: Parameters<Route['fulfill']>[0] | 'abort') {
	await page.route(
		(url) => url.pathname === '/admin/commissions/new',
		async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			if (answer === 'abort') return route.abort('connectionreset');
			return route.fulfill(answer);
		}
	);
}

async function fillEntry(page: Page) {
	await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
	await page.getByLabel('Title').fill('E2E kept title');
	await page.getByLabel('Notes').fill('E2E kept note');
}

for (const [name, answer] of [
	['the connection drops', 'abort'],
	['the server errors', { status: 500, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } }) }]
] as const) {
	test(`when ${name}, the form keeps what was typed and says so`, async ({ page }, testInfo) => {
		await loginRetrying(page, PASSWORD);
		await gotoAfterLogin(page, '/admin/commissions/new');
		await waitForHydration(page);
		await stubCreate(page, answer);
		await fillEntry(page);
		await page.getByRole('button', { name: 'Save entry' }).click();

		await expect(
			page.getByRole('status').filter({ hasText: "Something went wrong, so the entry wasn't saved." })
		).toBeVisible();
		// Focus stays on Save, so trying again is one key away.
		await expect(page.locator('form.entry-form button[type="submit"]')).toBeFocused();
		await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();
		await expect(page.getByLabel('Title')).toHaveValue('E2E kept title');
		await expect(page.getByLabel('Notes')).toHaveValue('E2E kept note');
		await settledShot(page, testInfo.outputPath(`commission-entry-save-error-${name.replaceAll(' ', '-')}.png`));
	});
}

test('a refusal with no field to point at keeps focus on Save', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/commissions/new');
	await waitForHydration(page);
	// A SvelteKit action failure whose data names no field, no gate, no stale save.
	await stubCreate(page, {
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ type: 'failure', status: 400, data: '[{}]' })
	});
	await fillEntry(page);
	const save = page.locator('form.entry-form button[type="submit"]');
	await save.click();

	await expect(page.getByRole('status').filter({ hasText: "Couldn't save the entry. Try again." })).toBeVisible();
	await expect(save).toBeFocused();
	await expect(page.getByLabel('Title')).toHaveValue('E2E kept title');
});

// With JavaScript on, every refusal the server can give keeps what the owner
// typed, ties the error to its field, and moves focus there. Each case is
// refused, so nothing is written to the shared DB.
const refusals: {
	name: string;
	/** Fills the field under test. The title and note are filled for every case. */
	fill: (page: Page) => Promise<void>;
	field: string;
	error: string;
}[] = [
	{
		name: 'no artist',
		fill: async () => {},
		field: 'artistId',
		error: 'Pick an artist.'
	},
	{
		// The artist was deleted in another tab after this form loaded.
		name: 'an artist that no longer exists',
		fill: async (page) => {
			await page.locator('#ce-artistId').evaluate((el: HTMLSelectElement) => el.add(new Option('Gone Artist', '999999')));
			await page.getByLabel('Artist', { exact: true }).selectOption('999999');
		},
		field: 'artistId',
		error: "That artist isn't in your artist list anymore. Pick another one."
	},
	{
		name: 'too many decimals for the currency',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			await page.getByRole('radio', { name: /USD/ }).check();
			await page.getByLabel('Amount').fill('10.555');
		},
		field: 'price',
		error: "USD amounts can't have more than 2 decimal places."
	},
	{
		name: 'an amount that is not a number',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			await page.getByLabel('Amount').fill('about 40');
		},
		field: 'price',
		error: 'Enter the amount as a number, like 45 or 45.50.'
	},
	{
		// A javascript: value isn't a link at all now: it saves as plain text and
		// never becomes one (commissions.test.ts). Past sanitizeUrl's length cap,
		// a link is one Sona can't read.
		name: 'a link Sona cannot read',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			await page.getByLabel("Where it's happening").fill(`https://example.com/${'a'.repeat(2100)}`);
		},
		field: 'sourceUrl',
		error: "Sona couldn't read this link. Fix it or clear it."
	}
];

for (const refusal of refusals) {
	test(`a save refused for ${refusal.name} keeps the typing and focuses the field`, async ({ page }, testInfo) => {
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/commissions/new');
		await waitForHydration(page);
		await page.getByLabel('Title').fill('E2E refused title');
		await page.getByLabel('Notes').fill('E2E refused note');
		await refusal.fill(page);
		await page.getByRole('button', { name: 'Save entry' }).click();

		const field = page.locator(`#ce-${refusal.field}`);
		await expect(page.locator(`#ce-${refusal.field}-err`)).toHaveText(refusal.error);
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(field).toHaveAttribute('aria-describedby', new RegExp(`\\bce-${refusal.field}-err\\b`));
		await expect(field).toBeFocused();
		await expect(page.getByLabel('Title')).toHaveValue('E2E refused title');
		await expect(page.getByLabel('Notes')).toHaveValue('E2E refused note');
		await settledShot(page, testInfo.outputPath('commission-entry-refused.png'));
	});
}

test('the gate closing mid-edit keeps the typing and says why', async ({ page }, testInfo) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/commissions/new');
	await waitForHydration(page);
	// The server's answer once the early-access gate has closed (a key revoked
	// in another tab). The gate itself can't close on a running server.
	await stubCreate(page, {
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ type: 'failure', status: 403, data: '[{"gated":1},true]' })
	});
	await fillEntry(page);
	await page.getByLabel('Amount').fill('30');
	await page.getByRole('button', { name: 'Save entry' }).click();

	const alert = page.getByRole('alert').filter({ hasText: "This entry wasn't saved. The commission ledger opens to everyone" });
	await expect(alert).toBeVisible();
	await expect(alert).toBeFocused();
	await expect(alert.getByRole('link', { name: 'Settings → Account' })).toHaveAttribute('href', '/admin/settings?tab=account#supporter-key');
	await expect(page.getByLabel('Title')).toHaveValue('E2E kept title');
	await expect(page.getByLabel('Notes')).toHaveValue('E2E kept note');
	await expect(page.getByLabel('Amount')).toHaveValue('30');
	await settledShot(page, testInfo.outputPath('commission-entry-gated-mid-edit.png'));
});

/** Sends `header` as the context's Accept-Language. Chromium writes its own,
 * from the context's locale, over extraHTTPHeaders, so each request is
 * rewritten on its way out instead. */
async function acceptLanguage(context: BrowserContext, header: string) {
	await context.route('**/*', (route) =>
		route.continue({ headers: { ...route.request().headers(), 'accept-language': header } })
	);
}

// Accept-Language picks the currency a fresh form opens on, while no saved
// entry has a price: the first region-bearing tag in the owner's first
// language, else nothing picked. The shared ledger is empty, so the region is
// all the form has to go on.
for (const [header, currency] of [
	['en-GB,en;q=0.9', 'GBP'],
	['ja-JP,ja;q=0.9', 'JPY'],
	['de-CH', 'CHF'],
	['fr', null],
	['ja,en-US;q=0.8', null],
	['*', null],
	['', null]
] as const) {
	test(`Accept-Language "${header}" opens the form on ${currency ?? 'no currency'}`, async ({ page, browser }, testInfo) => {
		await adminLogin(page, PASSWORD);
		const context = await browser.newContext({
			baseURL: testInfo.project.use.baseURL,
			storageState: await page.context().storageState()
		});
		try {
			await acceptLanguage(context, header);
			// English copy whatever the header asks for, so the assertions read the same.
			await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: testInfo.project.use.baseURL! }]);
			const tab = await context.newPage();
			await tab.goto('/admin/commissions/new');
			await waitForHydration(tab);
			const radios = tab.getByRole('radiogroup', { name: 'Currency' }).getByRole('radio');
			if (currency) {
				// The region's currency leads the row, and it's picked.
				await expect(radios.first()).toHaveAccessibleName(new RegExp(currency));
				await expect(radios.first()).toBeChecked();
				await expect(tab.locator('#ce-price-hint')).toContainText(currency);
			} else {
				// Nothing to go on: the common currencies, none picked.
				await expect(radios.first()).toHaveAccessibleName(/USD/);
				for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
			}
			await settledShot(tab, testInfo.outputPath('commission-entry-locale-currency.png'));
		} finally {
			await context.close();
		}
	});
}

test('an amount with no currency picked is refused on the currency, and focus moves there', async ({ page, browser }, testInfo) => {
	await adminLogin(page, PASSWORD);
	// A language with no region gives the form no currency to open on.
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: await page.context().storageState()
	});
	try {
		await acceptLanguage(context, 'en');
		const tab = await context.newPage();
		await tab.goto('/admin/commissions/new');
		await waitForHydration(tab);
		await fillEntry(tab);
		const group = tab.getByRole('radiogroup', { name: 'Currency' });
		// Nothing picked, or this save would go through and write to the shared DB.
		await expect(group.getByRole('radio', { checked: true })).toHaveCount(0);
		await tab.getByLabel('Amount').fill('40');
		await tab.getByRole('button', { name: 'Save entry' }).click();

		await expect(tab.locator('#ce-currency-err')).toHaveText('Pick a currency for this amount, or clear the amount.');
		await expect(group).toHaveAttribute('aria-invalid', 'true');
		await expect(group).toHaveAttribute('aria-describedby', /\bce-currency-err\b/);
		await expect(group).toBeFocused();
		await expect(tab.getByLabel('Amount')).toHaveValue('40');
		await expect(tab.getByLabel('Title')).toHaveValue('E2E kept title');
		await settledShot(tab, testInfo.outputPath('commission-entry-currency-missing.png'));
	} finally {
		await context.close();
	}
});

// Without JavaScript the server renders each refusal: the form, its typing, and
// the field's error, never an error page.
const noJsRefusals: {
	name: string;
	/** Accept-Language for the case; en-US opens the form on USD. */
	header?: string;
	fill: (page: Page) => Promise<void>;
	field: string;
	error: string;
	/** The amount the refused page has to keep, when the case types one. */
	amount?: string;
}[] = [
	{
		name: 'no artist',
		fill: async () => {},
		field: 'artistId',
		error: 'Pick an artist.'
	},
	{
		name: 'no title',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			await page.getByLabel('Title').fill('');
		},
		field: 'title',
		error: 'Enter a title.'
	},
	{
		name: 'too many decimals for the currency',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			await page.getByLabel('Amount').fill('10.555');
		},
		field: 'price',
		error: "USD amounts can't have more than 2 decimal places.",
		amount: '10.555'
	},
	{
		name: 'an amount with no currency',
		header: 'en',
		fill: async (page) => {
			await page.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
			// Nothing picked, or this save would go through and write to the shared DB.
			await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
			await page.getByLabel('Amount').fill('40');
		},
		field: 'currency',
		error: 'Pick a currency for this amount, or clear the amount.',
		amount: '40'
	}
];

for (const refusal of noJsRefusals) {
	test(`without JavaScript, a save refused for ${refusal.name} renders the form with its error`, async ({ page, browser }, testInfo) => {
		await adminLogin(page, PASSWORD);
		const context = await browser.newContext({
			baseURL: testInfo.project.use.baseURL,
			storageState: await page.context().storageState(),
			javaScriptEnabled: false
		});
		try {
			if (refusal.header) await acceptLanguage(context, refusal.header);
			const noJs = await context.newPage();
			await noJs.goto('/admin/commissions/new');
			await noJs.getByLabel('Title').fill('E2E no-JS refused');
			await noJs.getByLabel('Notes').fill('E2E no-JS refused note');
			await refusal.fill(noJs);
			const answer = noJs.waitForResponse((res) => res.request().method() === 'POST');
			await noJs.getByRole('button', { name: 'Save entry' }).click();
			expect((await answer).status()).toBe(400);
			await noJs.waitForLoadState();

			await expect(noJs.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();
			await expect(noJs.locator(`#ce-${refusal.field}-err`)).toHaveText(refusal.error);
			const field = noJs.locator(`#ce-${refusal.field}`);
			await expect(field).toHaveAttribute('aria-invalid', 'true');
			await expect(field).toHaveAttribute('aria-describedby', new RegExp(`\\bce-${refusal.field}-err\\b`));
			await expect(noJs.getByLabel('Notes')).toHaveValue('E2E no-JS refused note');
			if (refusal.field !== 'title') await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS refused');
			if (refusal.amount) await expect(noJs.getByLabel('Amount')).toHaveValue(refusal.amount);
			await settledShot(noJs, testInfo.outputPath('commission-entry-nojs-refused.png'));
		} finally {
			await context.close();
		}
	});
}

// An artist deleted after the form loaded, saved without JavaScript: the
// refusal names it and keeps the typing. A crafted post stands in for the
// no-JS form, which can't pick an artist that isn't listed.
test('without JavaScript, an artist that no longer exists is refused with the typing kept', async ({ page, baseURL }) => {
	await adminLogin(page, PASSWORD);
	const res = await page.request.post('/admin/commissions/new', {
		form: { artistId: '999999', title: 'E2E gone artist', notes: 'E2E gone note', status: 'applied', payment: 'unpaid', currency: 'USD', price: '' },
		headers: { origin: baseURL!, accept: 'text/html' },
		maxRedirects: 0
	});
	expect(res.status()).toBe(400);
	const html = await res.text();
	expect(html).toContain("That artist isn't in your artist list anymore. Pick another one.");
	expect(html).toMatch(/id="ce-title"[^>]*value="E2E gone artist"/);
	expect(html).toContain('E2E gone note</textarea>');
});

// Closing the search on an empty query and opening it again shows the same
// list, scrolled to the top. The highlight has to start there too, or Enter
// picks a currency the owner can't see.
test('reopening Other currency starts on the first currency again', async ({ page }, testInfo) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/commissions/new');
	await waitForHydration(page);
	const other = page.getByRole('button', { name: 'Other currency' });
	const find = page.getByRole('combobox', { name: 'Find a currency' });
	const options = page.getByRole('listbox', { name: 'Find a currency' }).getByRole('option');

	await other.click();
	for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
	await expect(find).toHaveAttribute('aria-activedescendant', (await options.nth(3).getAttribute('id'))!);
	await page.keyboard.press('Escape');
	await expect(other).toBeFocused();

	await other.click();
	await expect(find).toHaveAttribute('aria-activedescendant', (await options.first().getAttribute('id'))!);
	await settledShot(page, testInfo.outputPath('currency-search-reopened.png'));
});
