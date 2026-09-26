import { expect, type Page } from '@playwright/test';

// Site-chrome checks shared by site-chrome.spec.ts, passport.spec.ts and
// stickers-content.spec.ts. A module rather than a spec, so importing it does
// not register another file's tests.

/** Tab once from a fresh page and return the focused element's class and text. */
export async function firstTabStop(page: Page, key: 'Tab' | 'Shift+Tab' = 'Tab') {
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

/**
 * The skip link, driven with the real keyboard on the page already loaded: it
 * is off screen until focused, the first Tab lands on it (or the Shift+Tab
 * before an autofocused field), it shows on screen as a card pill with its
 * focus ring, and Enter moves the next Tab into `main`.
 *
 * A programmatic .focus() would pass even if the link were not the first stop
 * in the tab order, and a programmatic click would pass even if activating it
 * left focus in the header.
 */
export async function expectSkipLinkReachesMain(
	page: Page,
	{ main = 'main#main-content', autofocus }: { main?: string; autofocus?: string } = {}
) {
	await expect(page.locator(main)).toHaveCount(1);

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

	// It reads as a pill on the card surface with a hairline edge, and the focus
	// ring stays its own outline. The expected colors are the theme's tokens,
	// resolved on a probe element, so this holds on every theme.
	const look = await page.evaluate(() => {
		const link = getComputedStyle(document.activeElement as HTMLElement);
		const probe = document.createElement('div');
		probe.style.cssText =
			'background: var(--card); box-shadow: inset 0 0 0 1px var(--border); outline: 2px solid var(--ring)';
		document.body.append(probe);
		const want = getComputedStyle(probe);
		const tokens = { background: want.backgroundColor, edge: want.boxShadow, ring: want.outlineColor };
		probe.remove();
		return {
			background: link.backgroundColor,
			edge: link.boxShadow,
			radius: link.borderTopLeftRadius,
			ring: `${link.outlineStyle} ${link.outlineWidth} ${link.outlineColor} ${link.outlineOffset}`,
			tokens
		};
	});
	expect(look).toEqual({
		background: look.tokens.background,
		edge: look.tokens.edge,
		radius: '999px',
		ring: `solid 2px ${look.tokens.ring} 2px`,
		tokens: look.tokens
	});

	// Enter follows it, and the next Tab starts inside the main landmark rather
	// than back in the header.
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/#main-content$/);
	await page.keyboard.press('Tab');
	const inMain = await page.evaluate((sel) => !!document.activeElement?.closest(sel), main);
	expect(inMain).toBe(true);
}

/** The bottom nav publishes its height as --mobile-nav-height once hydrated.
 * Wait until that matches the bar as rendered, so anything measured against
 * the clearance sees the wrapped bar rather than the one before it. */
export async function waitForNavHeight(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const h = getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-height');
				return h === `${(document.querySelector('nav.mobile-nav') as HTMLElement).offsetHeight}px`;
			})
		)
		.toBe(true);
}
