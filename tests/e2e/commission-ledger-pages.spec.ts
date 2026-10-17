import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
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
	await page.getByLabel('Price').fill('45.5');
	await page.getByLabel('Currency').fill('JPY');
	await page.getByRole('button', { name: 'Save entry' }).click();

	const price = page.getByLabel('Price');
	await expect(price).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByText("JPY prices don't use decimals. Enter a whole number.")).toBeVisible();
	await expect(price).toHaveAttribute('aria-describedby', /ce-price-err/);
	// Focus moves to the first field with an error.
	await expect(price).toBeFocused();
	// The field's edge, and its focus ring, are drawn in the theme's --destructive.
	const [edge, ring, destructive] = await price.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--destructive)';
		document.body.append(probe);
		const style = getComputedStyle(el);
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
		await noJs.getByLabel('Artist', { exact: true }).selectOption({ index: 1 });
		await noJs.getByLabel('Title').fill('E2E no-JS title');
		await noJs.getByLabel('Notes').fill('E2E no-JS note');
		await noJs.getByLabel('Price').fill('45.5');
		await noJs.getByLabel('Currency').fill('JPY');
		await noJs.getByRole('button', { name: 'Save entry' }).click();
		await noJs.waitForLoadState();

		await expect(noJs.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();
		await expect(noJs.getByLabel('Title')).toHaveValue('E2E no-JS title');
		await expect(noJs.getByLabel('Notes')).toHaveValue('E2E no-JS note');
		await expect(noJs.getByLabel('Price')).toHaveValue('45.5');
		await expect(noJs.getByLabel('Price')).toHaveAttribute('aria-invalid', 'true');
		await expect(noJs.getByText("JPY prices don't use decimals. Enter a whole number.")).toBeVisible();
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
		await settledShot(page, testInfo.outputPath('commission-entry-save-error.png'));
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
