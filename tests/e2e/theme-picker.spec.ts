import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginRetrying, gotoAfterLogin } from './admin-login';

// SONA-227: the end-to-end proof that picking a theme in admin settings reaches
// the public page. theme-tokens.spec.ts already proves the generated stylesheet
// carries every theme's block; what nothing covered is the path from the select
// through ?/saveSite into the data-theme-id attribute SSR writes on <html>.
//
// Its own seeded DB + dev server (see tests/e2e/paths.ts): the theme is a global
// setting, so while it is not the default every page on the server renders in
// another palette and another headline face. On the shared server that window
// would land under whatever else was mid-assertion.
//
// Serial, and the last test puts the default back, so the file leaves its own
// fork the way it found it even though nothing else reads this server.
test.describe.configure({ mode: 'serial' });

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// The same dance legal.spec.ts does for its saveSite cases: a client-only tab
// switch is the hydration gate, because an unhydrated form does a real
// navigation and that aborts the goto which follows.
async function openSiteTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Storage', exact: true }).click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
	await page.getByRole('tab', { name: 'Site', exact: true }).click();
}

async function saveSiteSettings(page: Page) {
	const [resp] = await Promise.all([
		page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/admin/settings')
		),
		page.getByRole('button', { name: 'Save site settings' }).click()
	]);
	expect(resp.ok()).toBeTruthy();
}

/** Log in, pick a theme by its visible label, and save the Site tab. */
async function chooseTheme(page: Page, label: string) {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/settings');
	await openSiteTab(page);
	await page.selectOption('select[name="themeId"]', { label });
	await saveSiteSettings(page);
}

/** The resolved --background on the public home page. */
function background(page: Page): Promise<string> {
	return page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
	);
}

/** The whole document as the browser holds it, placeholders and all. */
function renderedHtml(page: Page): Promise<string> {
	return page.evaluate(() => document.documentElement.outerHTML);
}

let stockBackground = '';

test('the seeded fork starts on the default theme', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'default');
	stockBackground = await background(page);
	expect(stockBackground).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/);
});

test('saving Petal repaints the public page', async ({ page }) => {
	await chooseTheme(page, 'Petal — soft pink');

	const response = await page.goto('/');
	// The server's own HTML, before hydration: SSR writes the id and the preload,
	// and a client that set them after load would still leave this body wrong.
	const serverHtml = (await response?.text()) ?? '';
	expect(serverHtml).toContain('data-theme-id="petal"');
	expect(serverHtml).toContain('href="/fonts/Nunito-latin.woff2"');
	expect(serverHtml).not.toContain('%preload%');
	await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'petal');
	expect(await background(page), 'petal leaves --background at the default value').not.toBe(
		stockBackground
	);
	// The preload has to follow the theme too: it names the face the headings
	// render in, and a preload of the wrong file is paid for and never used.
	await expect(page.locator('head link[rel="preload"][as="font"]')).toHaveAttribute(
		'href',
		'/fonts/Nunito-latin.woff2'
	);
	expect(await renderedHtml(page), 'the %preload% placeholder reached the browser').not.toContain(
		'%preload%'
	);
});

test('choosing the default again puts the fork back', async ({ page }) => {
	await chooseTheme(page, 'Ember — warm orange (default)');

	const response = await page.goto('/');
	const serverHtml = (await response?.text()) ?? '';
	expect(serverHtml).toContain('data-theme-id="default"');
	expect(serverHtml).toContain('href="/fonts/JetBrainsMono-latin.woff2"');
	await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'default');
	expect(await background(page)).toBe(stockBackground);
	await expect(page.locator('head link[rel="preload"][as="font"]')).toHaveAttribute(
		'href',
		'/fonts/JetBrainsMono-latin.woff2'
	);
	expect(await renderedHtml(page), 'the %preload% placeholder reached the browser').not.toContain(
		'%preload%'
	);
});
