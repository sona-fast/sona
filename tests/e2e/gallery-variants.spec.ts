import { test, expect, type Page } from '@playwright/test';

// Regression coverage for the gallery variant strip (shipped in #73). The strip
// swaps the shown image client-side (SvelteKit nav, View Transition), and an
// NSFW variant must arrive blurred every time it is shown — including when you
// return to it or navigate there with the browser history buttons. This is the
// behavior the node-only unit suite cannot exercise because it can't mount the
// component. Seed: tests/e2e/fixtures/seed.sql (SFW parent-piece + NSFW
// variant-piece pointing at it).

const PARENT = '/gallery/parent-piece';
const VARIANT = '/gallery/variant-piece';
const tileFor = (href: string) => `.variant-strip a[href="${href}"]`;

const mainImg = (page: Page) => page.locator('.image-preview img');
const h1 = (page: Page) => page.locator('.image-meta h1');
const overlay = (page: Page) => page.locator('.nsfw-overlay');
const currentTile = (page: Page) => page.locator('.variant-strip a[aria-current="page"]');

// Marker planted after load; a full page reload wipes it, so its survival proves
// a navigation stayed client-side (SvelteKit router, not the browser).
async function plantSpaMarker(page: Page) {
	await page.evaluate(() => ((window as unknown as { __spa: boolean }).__spa = true));
}
async function stayedClientSide(page: Page) {
	return page.evaluate(() => (window as unknown as { __spa?: boolean }).__spa === true);
}

// In `vite dev`, hydration lags the initial load (modules stream in), so a click
// fired right after page.goto can land before the SvelteKit router + Svelte
// handlers attach — the <a> then does a full page load instead of a client-side
// nav. Retrying the whole nav until the marker survives is the deterministic
// fix; once the first client-side nav lands, the app stays hydrated for the rest
// of the test. Returns with the page on `to`, hydrated.
async function navFromParentClientSide(page: Page, to: string, expectedH1: string) {
	await expect(async () => {
		await page.goto(PARENT);
		await plantSpaMarker(page);
		await page.locator(tileFor(to)).click();
		await expect(h1(page)).toHaveText(expectedH1);
		expect(await stayedClientSide(page)).toBe(true);
	}).toPass();
}

test.describe('gallery variant strip', () => {
	test('parent renders SFW and unblurred', async ({ page }) => {
		await page.goto(PARENT);
		await expect(h1(page)).toHaveText('Parent Piece SFW');
		await expect(overlay(page)).toHaveCount(0);
		await expect(mainImg(page)).toHaveAttribute('src', /parentpiece/);
		await expect(mainImg(page)).not.toHaveClass(/blurred/);
		await expect(currentTile(page)).toHaveAttribute('href', PARENT);
		await expect(page).toHaveTitle(/Parent Piece SFW/);
	});

	test('clicking the NSFW variant tile swaps content client-side and arrives blurred', async ({
		page
	}) => {
		await navFromParentClientSide(page, VARIANT, 'Variant Piece NSFW');

		await expect(page).toHaveURL(new RegExp(`${VARIANT}$`));
		// The image, highlight, title and blur all follow the URL, client-side.
		await expect(mainImg(page)).toHaveAttribute('src', /variantpiece/);
		await expect(currentTile(page)).toHaveAttribute('href', VARIANT);
		await expect(page).toHaveTitle(/Variant Piece NSFW/);
		await expect(overlay(page)).toHaveCount(1);
		await expect(mainImg(page)).toHaveClass(/blurred/);
	});

	test('reveal clears the blur, and returning to the variant re-blurs it', async ({ page }) => {
		await page.goto(VARIANT);
		await expect(overlay(page)).toHaveCount(1);
		await expect(mainImg(page)).toHaveClass(/blurred/);

		// Reveal is a client action; retry the click until it lands post-hydration.
		await expect(async () => {
			await page.locator('.reveal-btn').click();
			await expect(overlay(page)).toHaveCount(0, { timeout: 1500 });
		}).toPass();
		await expect(mainImg(page)).not.toHaveClass(/blurred/);

		// Strip back to the parent, then back to the variant: the reveal must reset.
		await page.locator(tileFor(PARENT)).click();
		await expect(h1(page)).toHaveText('Parent Piece SFW');
		await expect(overlay(page)).toHaveCount(0);
		await expect(mainImg(page)).toHaveAttribute('src', /parentpiece/);

		await page.locator(tileFor(VARIANT)).click();
		await expect(h1(page)).toHaveText('Variant Piece NSFW');
		await expect(overlay(page)).toHaveCount(1);
		await expect(mainImg(page)).toHaveClass(/blurred/);
	});

	test('browser back/forward follow the URL and re-blur the NSFW variant', async ({ page }) => {
		// Build history client-side: parent -> variant -> parent.
		await navFromParentClientSide(page, VARIANT, 'Variant Piece NSFW');
		await page.locator(tileFor(PARENT)).click();
		await expect(h1(page)).toHaveText('Parent Piece SFW');

		// Back -> variant: blurred again, image + title follow, still client-side.
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${VARIANT}$`));
		await expect(h1(page)).toHaveText('Variant Piece NSFW');
		await expect(mainImg(page)).toHaveAttribute('src', /variantpiece/);
		await expect(overlay(page)).toHaveCount(1);
		await expect(mainImg(page)).toHaveClass(/blurred/);
		await expect(page).toHaveTitle(/Variant Piece NSFW/);
		expect(await stayedClientSide(page)).toBe(true);

		// Back -> parent, then forward -> variant: still tracks the URL.
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${PARENT}$`));
		await expect(h1(page)).toHaveText('Parent Piece SFW');
		await expect(mainImg(page)).toHaveAttribute('src', /parentpiece/);
		await expect(page).toHaveTitle(/Parent Piece SFW/);

		await page.goForward();
		await expect(page).toHaveURL(new RegExp(`${VARIANT}$`));
		await expect(mainImg(page)).toHaveAttribute('src', /variantpiece/);
		await expect(overlay(page)).toHaveCount(1);
	});
});
