import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, gotoRetrying, loginRetrying, openSiteTab } from './admin-login';
import { expectHeaderTogglesWork, THEME_NAME, waitForNavHeight } from './site-chrome-helpers';

// The three-path splash homepage (landingLayout = 'threePath') on a phone. As on
// every page with the bottom nav, the header is the only place the theme and
// language toggles live. No seeded server renders the splash, so this file
// switches the upload server's homepage to it through the settings form. It
// puts the previous layout back afterwards, pass or fail.
//
// Mutating: it rides the upload server, which the other settings-writing specs
// (fuzzysearch-key, artist-lookup) already run on one worker at a time.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

type SiteFields = { landingLayout?: string; siteName?: string; ownerName?: string; splashSubtitle?: string };

/** Save `fields` on the Site tab, and wait until the server renders the
 *  homepage the way `rendered` expects. */
async function saveSite(page: Page, fields: SiteFields, rendered: (html: string) => boolean) {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', domain: 'localhost', path: '/' }]);
	await gotoRetrying(page, '/admin/settings');
	await openSiteTab(page);
	if (fields.landingLayout) await page.selectOption('select[name="landingLayout"]', fields.landingLayout);
	if (fields.siteName) await page.fill('input[name="siteName"]', fields.siteName);
	// Empty is a real value here: it makes the splash heading show the site name.
	if (fields.ownerName !== undefined) await page.fill('input[name="ownerName"]', fields.ownerName);
	if (fields.splashSubtitle !== undefined) await page.fill('input[name="splashSubtitle"]', fields.splashSubtitle);
	await page.getByRole('button', { name: 'Save site settings' }).click();
	await expect(async () => {
		expect(rendered(await (await page.request.get('/')).text())).toBe(true);
	}).toPass({ timeout: 30_000 });
}

/** The splash's main carries class "splash". */
const isSplash = (html: string) => html.includes('class="splash');

/**
 * Sign in, read the current site settings, run `body`, and put the settings
 * back afterwards, pass or fail. A failed restore after a failed body is
 * attached to the test rather than thrown, so the first failure stays the one
 * reported.
 */
async function withSiteSettings(page: Page, body: () => Promise<void>) {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/settings');
	const previous = {
		landingLayout: await page.locator('select[name="landingLayout"]').inputValue(),
		siteName: await page.locator('input[name="siteName"]').inputValue(),
		ownerName: await page.locator('input[name="ownerName"]').inputValue(),
		splashSubtitle: await page.locator('input[name="splashSubtitle"]').inputValue()
	};
	expect(previous.landingLayout).not.toBe('');
	// Left over from an aborted run, the splash would be written back as the
	// layout to restore. Fail here instead.
	expect(
		previous.landingLayout,
		'the server already shows the splash, probably from an aborted run; set the homepage layout back before rerunning'
	).not.toBe(
		'threePath'
	);
	expect(previous.siteName).not.toBe('');

	let failed = false;
	try {
		await body();
	} catch (err) {
		failed = true;
		throw err;
	} finally {
		await page.setViewportSize({ width: 1280, height: 720 });
		try {
			await saveSite(page, previous, (html) => !isSplash(html) && html.includes(previous.siteName));
		} catch (err) {
			if (!failed) throw err;
			test.info().annotations.push({ type: 'restore failed', description: String(err) });
		}
	}
}

/** The WCAG contrast ratio of an element's text against the splash behind it,
 *  with the element's opacity blended in. */
function footerMarkContrast(page: Page) {
	return page.locator('.footer-mark').evaluate((el) => {
		const rgba = (c: string) => {
			const m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
			if (!m) throw new Error(`unparsed colour ${c}`);
			return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
		};
		const s = getComputedStyle(el);
		const bg = rgba(getComputedStyle(el.closest('main')!).backgroundColor);
		const fg = rgba(s.color);
		const a = fg[3] * parseFloat(s.opacity);
		const blended = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
		const lum = (rgb: number[]) => {
			const [r, g, b] = rgb.map((v) => {
				const c = v / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const [hi, lo] = [lum(blended), lum(bg)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	});
}

test('the three-path splash keeps the theme and language toggles in its one header on a phone', async ({
	page
}) => {
	await withSiteSettings(page, async () => {
		await saveSite(page, { landingLayout: 'threePath' }, isSplash);

		await page.setViewportSize({ width: 390, height: 844 });
		const res = await page.goto('/');
		expect(res?.status()).toBe(200);
		await expect(page.locator('main.splash')).toHaveCount(1);
		await waitForNavHeight(page);

		// The footer mark is 11px text, so it needs 4.5:1 in both themes.
		const theme = page.getByRole('banner').getByRole('button', { name: THEME_NAME });
		for (let pass = 0; pass < 2; pass++) {
			const mode = await page.locator('html').getAttribute('data-theme');
			expect(await footerMarkContrast(page), `the footer mark in the ${mode} theme`).toBeGreaterThanOrEqual(4.5);
			await theme.click();
			await expect(page.locator('html')).not.toHaveAttribute('data-theme', mode ?? '');
		}

		await expectHeaderTogglesWork(page);
	});
});

// WCAG 1.4.10: a long one-word site name wraps in the splash's heading, the
// artist card's description and the footer mark, and a long one-word subtitle
// wraps too, instead of widening the page past a 320px screen. The wrapped
// lines of the heading, subtitle and footer mark stay centred in their column.
// The test saves the owner name empty, which is the product default (the e2e
// seed sets one), so the heading shows the site name. At 200% text the footer
// mark doubles with it (WCAG 1.4.4).
test('the three-path splash fits 320px with a long one-word site name', async ({ page }, testInfo) => {
	const siteName = 'Supercalifragilisticexpialidociousfox';
	// 45 characters with no break opportunity, like a pasted URL.
	const splashSubtitle = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
	await withSiteSettings(page, async () => {
		await saveSite(
			page,
			{ landingLayout: 'threePath', siteName, ownerName: '', splashSubtitle },
			(html) => isSplash(html) && html.includes(siteName) && html.includes(splashSubtitle)
		);

		await page.setViewportSize({ width: 320, height: 800 });
		await page.goto('/');
		// The splash sets its heading in capitals.
		await expect(page.locator('main.splash h1')).toHaveText(siteName.toUpperCase());
		await expect(page.locator('.footer-mark')).toHaveText(siteName);
		await expect(page.locator('main.splash .subtitle')).toHaveText(splashSubtitle);

		// Each line box of the element's text, measured through a range because
		// an unbroken word overflows its element's box rather than growing it.
		const layout = await page.evaluate((name) => {
			const lines = (el: Element) => {
				const range = document.createRange();
				range.selectNodeContents(el);
				return [...range.getClientRects()]
					.filter((r) => r.width > 0)
					.map((r) => ({ left: r.left, right: r.right }));
			};
			const column = (el: Element) => {
				const r = el.getBoundingClientRect();
				return { left: r.left, right: r.right };
			};
			const hub = document.querySelector('main.splash .hub')!;
			const splash = document.querySelector('main.splash')!;
			// The artist and photos card descriptions carry the name. Check the first one shown.
			const desc = [...document.querySelectorAll('main.splash .card-desc')].find((el) =>
				el.textContent!.includes(name)
			);
			return {
				heading: { lines: lines(document.querySelector('main.splash h1')!), column: column(hub) },
				subtitle: { lines: lines(document.querySelector('main.splash .subtitle')!), column: column(hub) },
				mark: { lines: lines(document.querySelector('.footer-mark')!), column: column(splash) },
				// Its text column sits inside the card box, left of the chevron.
				desc: desc ? { lines: lines(desc), card: column(desc.closest('.text')!) } : null
			};
		}, siteName);
		for (const [what, el] of [
			['heading', layout.heading],
			['subtitle', layout.subtitle],
			['footer mark', layout.mark]
		] as const) {
			expect(el.lines.length, `the ${what} wraps onto several lines`).toBeGreaterThan(1);
			const centre = (el.column.left + el.column.right) / 2;
			for (const [i, line] of el.lines.entries()) {
				expect(line.left, `line ${i + 1} of the ${what} starts on screen`).toBeGreaterThanOrEqual(0);
				expect(line.right, `line ${i + 1} of the ${what} ends on screen`).toBeLessThanOrEqual(320);
				expect(
					Math.abs((line.left + line.right) / 2 - centre),
					`line ${i + 1} of the ${what} is centred in its column`
				).toBeLessThanOrEqual(1);
			}
		}
		expect(layout.desc, 'a card description carries the site name').not.toBeNull();
		for (const [i, line] of layout.desc!.lines.entries()) {
			expect(line.left, `line ${i + 1} of the card description starts inside the card's text column`).toBeGreaterThanOrEqual(
				layout.desc!.card.left
			);
			expect(line.right, `line ${i + 1} of the card description ends inside the card's text column, clear of the chevron`).toBeLessThanOrEqual(
				layout.desc!.card.right
			);
		}

		const measure = () =>
			page.evaluate(() => {
				return {
					docWidth: document.documentElement.scrollWidth,
					vw: innerWidth,
					markSize: parseFloat(getComputedStyle(document.querySelector('.footer-mark')!).fontSize)
				};
			});
		const m = await measure();
		expect(m.docWidth).toBeLessThanOrEqual(m.vw);
		await page.screenshot({ path: testInfo.outputPath('splash-long-name-320.png'), fullPage: true });

		await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
		expect((await measure()).markSize).toBeCloseTo(m.markSize * 2, 1);
	});
});
