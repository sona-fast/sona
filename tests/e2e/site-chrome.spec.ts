import { test, expect, type Page } from '@playwright/test';

// Site-chrome accessibility and seed checks from the SONA-229 review, on the
// shared read-only server. No login and no writes.
//
// The skip link is driven with the real keyboard: a programmatic .focus() would
// pass even if the link were not the first stop in the tab order, and a
// programmatic click would pass even if activating it left focus in the header.

/** Tab once from a fresh page and return the focused element's class and text. */
async function firstTabStop(page: Page, key: 'Tab' | 'Shift+Tab' = 'Tab') {
	await page.keyboard.press(key);
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return { className: el?.className ?? '', text: el?.textContent?.trim() ?? '' };
	});
}

/** The focused element's box relative to the viewport. */
async function focusedBox(page: Page) {
	return page.evaluate(() => {
		const r = (document.activeElement as HTMLElement).getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth };
	});
}

// One URL per layout that renders a <main>: the (public) layout, the mosaic
// homepage (which escapes that layout), the (paths) layout, the auth-exempt
// admin pages, and the root error page. The sign-in page autofocuses its
// password field, so the keyboard starts there and the skip link is the stop
// just before it.
const PAGES: { name: string; url: string; status: number; autofocus?: string }[] = [
	{ name: 'gallery', url: '/gallery', status: 200 },
	{ name: 'homepage', url: '/', status: 200 },
	{ name: 'connect page', url: '/connect', status: 200 },
	{ name: 'admin sign-in', url: '/admin/login', status: 200, autofocus: 'Password' },
	{ name: 'not-found page', url: '/no-such-page-e2e', status: 404 }
];

for (const { name, url, status, autofocus } of PAGES) {
	test(`the ${name} starts with a skip link that moves focus into the main content`, async ({ page }) => {
		const res = await page.goto(url);
		expect(res?.status()).toBe(status);
		await expect(page.locator('#main-content')).toHaveCount(1);
		await expect(page.locator('main#main-content')).toHaveCount(1);

		// Off-screen before it has focus.
		const hidden = await page.locator('.skip-link').boundingBox();
		expect(hidden!.y + hidden!.height).toBeLessThanOrEqual(0);

		// The first Tab lands on it, and it is on screen while focused.
		if (autofocus) await expect(page.getByLabel(autofocus)).toBeFocused();
		expect(await firstTabStop(page, autofocus ? 'Shift+Tab' : 'Tab')).toEqual({
			className: 'skip-link',
			text: 'Skip to content'
		});
		const box = await focusedBox(page);
		expect(box.top).toBeGreaterThanOrEqual(0);
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(box.vw);
		expect(box.bottom).toBeGreaterThan(box.top);

		// Enter follows it, and the next Tab starts inside the main landmark
		// rather than back in the header.
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/#main-content$/);
		await page.keyboard.press('Tab');
		const inMain = await page.evaluate(() => !!document.activeElement?.closest('main#main-content'));
		expect(inMain).toBe(true);
	});
}

test('the skip link is translated', async ({ page }) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.goto('/gallery');
	expect(await firstTabStop(page)).toEqual({ className: 'skip-link', text: '本文へスキップ' });
});

// WCAG 1.3.1: a heading outline that jumps from h1 to h3 tells a screen-reader
// user a level is missing. The section labels must stay the same small caps
// they were, so the rendered size is checked too.
test('the piece page heading outline never skips a level', async ({ page }) => {
	// parent-piece has variants, so every optional section that can render does.
	await page.goto('/gallery/parent-piece');
	const levels = await page
		.locator('main h1, main h2, main h3, main h4, main h5, main h6')
		.evaluateAll((els) => els.map((el) => Number(el.tagName.slice(1))));
	expect(levels[0]).toBe(1);
	for (let i = 1; i < levels.length; i++) {
		expect(levels[i], `heading ${i} (h${levels[i]}) follows an h${levels[i - 1]}`).toBeLessThanOrEqual(
			levels[i - 1] + 1
		);
	}

	const details = page.getByRole('heading', { name: 'Details', exact: true });
	await expect(details).toHaveJSProperty('tagName', 'H2');
	const look = await details.evaluate((el) => {
		const s = getComputedStyle(el);
		return { size: s.fontSize, transform: s.textTransform };
	});
	expect(look).toEqual({ size: '12px', transform: 'uppercase' });
});

// The seed points each gallery row's thumbnail at the local image route, and
// seed.ts puts the fixture PNG into the bucket under each of those keys. A key
// missing from the bucket shows up here as a card whose image never decodes.
test('every seeded gallery thumbnail loads', async ({ page }) => {
	await page.goto('/gallery');
	const imgs = page.locator('.grid img');
	await expect(imgs.first()).toBeVisible();
	const count = await imgs.count();
	expect(count).toBeGreaterThan(0);
	for (let i = 0; i < count; i++) {
		const img = imgs.nth(i);
		await img.scrollIntoViewIfNeeded();
		await expect(img).toHaveAttribute('src', /-thumb\.png$/);
		await expect
			.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
				message: `thumbnail ${i} decoded`
			})
			.toBe(true);
	}
});
