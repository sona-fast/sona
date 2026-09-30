import { expect, type Page } from '@playwright/test';

// Site-chrome checks shared by several e2e specs. A module rather than a spec,
// so importing it does not register another file's tests.

/**
 * Resolve CSS values that use the theme's tokens: apply them to a probe
 * element and read its computed style back, so a check holds on every theme.
 * Keys are CSS property names, such as 'background-color'.
 */
export function resolveStyle<K extends string>(page: Page, style: Record<K, string>) {
	return page.evaluate((style) => {
		const probe = document.createElement('div');
		for (const [prop, value] of Object.entries(style)) probe.style.setProperty(prop, value);
		document.body.append(probe);
		const s = getComputedStyle(probe);
		const out = Object.fromEntries(Object.keys(style).map((prop) => [prop, s.getPropertyValue(prop)]));
		probe.remove();
		return out;
	}, style as Record<string, string>) as Promise<Record<K, string>>;
}

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
	const tokens = await resolveStyle(page, {
		'background-color': 'var(--card)',
		'box-shadow': 'inset 0 0 0 1px var(--border)',
		'outline-color': 'var(--ring)'
	});
	const look = await page.evaluate(() => {
		const link = getComputedStyle(document.activeElement as HTMLElement);
		return {
			background: link.backgroundColor,
			edge: link.boxShadow,
			radius: link.borderTopLeftRadius,
			ring: `${link.outlineStyle} ${link.outlineWidth} ${link.outlineColor} ${link.outlineOffset}`
		};
	});
	expect(look).toEqual({
		background: tokens['background-color'],
		edge: tokens['box-shadow'],
		radius: '999px',
		ring: `solid 2px ${tokens['outline-color']} 2px`
	});

	// Enter follows it, and the next Tab starts inside the main landmark rather
	// than back in the header.
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/#main-content$/);
	await page.keyboard.press('Tab');
	const inMain = await page.evaluate((sel) => !!document.activeElement?.closest(sel), main);
	expect(inMain).toBe(true);
}

/**
 * Serve `url` with the root text size set to `scale` times the default, and
 * any other `edit` applied, written into the HTML itself. Use it when the
 * style has to be there from the first paint: with script off, or before the
 * page hydrates.
 */
export async function serveScaled(page: Page, url: string, scale: number, edit = (html: string) => html) {
	await page.route(url, async (route) => {
		const res = await route.fetch();
		const body = edit(await res.text()).replace(
			'</head>',
			`<style>html { font-size: ${scale * 100}% !important; }</style></head>`
		);
		await route.fulfill({ response: res, body });
	});
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

/** How many rows the bottom nav's tabs sit on. */
export function navRowCount(page: Page) {
	return page
		.locator('nav.mobile-nav .tab')
		.evaluateAll((tabs) => new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size);
}

// The theme button is named by what it does, so its name is one of these two
// and swaps when it is pressed.
const TO_LIGHT = 'Switch to light theme';
const TO_DARK = 'Switch to dark theme';
export const THEME_NAME = /^Switch to (light|dark) theme$/;

/**
 * The page has one header, the bottom nav holds no buttons, and the header
 * shows the only theme toggle and the language toggle.
 */
export async function expectHeaderToggles(page: Page) {
	await expect(page.getByRole('banner')).toHaveCount(1);
	const banner = page.getByRole('banner');
	await expect(page.locator('nav.mobile-nav button')).toHaveCount(0);

	const theme = banner.getByRole('button', { name: THEME_NAME });
	await expect(theme).toBeVisible();
	await expect(page.getByRole('button', { name: THEME_NAME })).toHaveCount(1);
	const lang = banner.getByRole('group', { name: 'Switch language' });
	await expect(lang).toBeVisible();
	return { theme, lang };
}

/**
 * expectHeaderToggles, and the toggles work: language comes before theme, the
 * theme button flips the theme and its name both ways, and JP switches the
 * page to Japanese. Leaves the page in Japanese.
 */
export async function expectHeaderTogglesWork(page: Page) {
	const { theme, lang } = await expectHeaderToggles(page);

	// Language first, then theme, in every header.
	expect(
		await lang.evaluate(
			(group, button) => !!(group.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING),
			await theme.elementHandle()
		)
	).toBe(true);

	const before = await page.locator('html').getAttribute('data-theme');
	const nameBefore = await theme.getAttribute('aria-label');
	await theme.click();
	await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
	await expect(theme).toHaveAccessibleName(nameBefore === TO_LIGHT ? TO_DARK : TO_LIGHT);
	await theme.click();
	await expect(theme).toHaveAccessibleName(nameBefore!);

	await lang.getByRole('button', { name: 'JP' }).click();
	await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
}
