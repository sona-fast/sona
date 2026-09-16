import { test, expect, type Page } from '@playwright/test';

// SONA-209: the palettes moved from hand-written app.css blocks into theme data
// rendered to src/lib/themes/generated.css. Every other guard on that file is a
// unit test reading the data or the source — nothing proved a BROWSER still ends
// up with the tokens: a dropped @import, a stale build, or a theme block the
// cascade never reaches would leave the page with no --background at all and the
// whole unit suite still green.
//
// Runs against the shared read-only seed, on a public page, with no login: this
// asserts the stylesheet reaches the document, not anything about the content.

// An unresolved custom property reads back as the empty string, so "is a colour"
// is the whole assertion.
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\))$/;

function background(page: Page): Promise<string> {
	return page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
	);
}

test('the generated theme tokens reach the document, and the theme id switches them', async ({
	page
}) => {
	await page.goto('/');

	// The seed sets no themeId, so the page serves the default palette.
	await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'default');
	const stock = await background(page);
	expect(stock).toMatch(COLOR);

	// The theme id is what SSR puts on <html> (src/app.html). Setting it here
	// drives the same selector the generated block carries, so a theme block that
	// never made it into the stylesheet leaves the value unchanged.
	for (const id of ['terracotta', 'petal', 'pewter']) {
		await page.evaluate((theme) => document.documentElement.setAttribute('data-theme-id', theme), id);
		const themed = await background(page);
		expect(themed, `${id} sets --background to a colour`).toMatch(COLOR);
		expect(themed, `${id} changes --background from the default`).not.toBe(stock);
	}
});
