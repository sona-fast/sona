import { test, expect, type Locator, type Page } from '@playwright/test';
import { navRowCount, serveScaled, waitForNavHeight } from './site-chrome-helpers';
import { countViewTransitions, inPlaceState, markWindow } from './in-place';
import { waitForHydration } from './admin-login';

// The ungated half of the nav content-gating rule, and the only end-to-end proof
// that a sticker pack renders at all.
//
// nav-gating.spec.ts covers the other half on the shared server, whose fixture
// deliberately has ZERO packs: that is what makes the gallery tab bar render
// its gated state. A published pack in that fixture
// would delete the coverage, so this spec gets its own seeded database and dev
// server, with tests/e2e/fixtures/stickers.sql layered on the shared fixture
// (see tests/e2e/paths.ts). One published pack, two SFW stickers, both credited
// to the seeded artist.
//
// Read-only throughout: no login, no writes, and the sticker image URLs are
// same-origin placeholders that 404 harmlessly, so nothing here touches the
// network or asserts pixels.

const PACK_SLUG = 'e2e-pack';
const PACK_NAME = 'E2E Sticker Pack';

test('/stickers lists the seeded pack', async ({ page }) => {
	await page.goto('/stickers');

	const card = page.locator('.pack-grid .pack-card');
	await expect(card).toHaveCount(1);
	await expect(card.locator('.pack-name-link')).toHaveText(PACK_NAME);
	await expect(card.locator(`a[href="/stickers/${PACK_SLUG}"]`).first()).toBeVisible();

	// The count comes from a grouped query over the stickers table, not from the
	// pack row, so it fails if the two stickers never attached to the pack.
	await expect(card.locator('.sticker-count')).toContainText('2');
});

test('the pack page shows both stickers', async ({ page }) => {
	await page.goto(`/stickers/${PACK_SLUG}`);

	await expect(page.getByRole('heading', { level: 1, name: PACK_NAME })).toBeVisible();
	await expect(page.locator('.sticker-grid .card')).toHaveCount(2);

	// Each card links to its own sticker detail route, so the grid is rendering
	// rows rather than repeating one.
	await expect(page.locator(`.sticker-grid a[href="/stickers/${PACK_SLUG}/1"]`)).toHaveCount(1);
	await expect(page.locator(`.sticker-grid a[href="/stickers/${PACK_SLUG}/2"]`)).toHaveCount(1);
});

// Stickers and VR avatars are tabs of the gallery, not top-nav items. This is
// the server where the Stickers tab shows, so the gallery's tab bar carries
// Artwork, Stickers and VR Avatars (the shared fixture's published avatar),
// and the same bar, with its own tab current, heads /stickers and /vr.
// nav-gating.spec.ts covers the zero-pack half: no Stickers tab at all.
const galleryTabBar = (page: Page) => page.getByRole('navigation', { name: 'Gallery', exact: true });

/** The bar's tab labels, the one marked current, and where it sits. */
async function tabBarState(page: Page) {
	const bar = galleryTabBar(page);
	await expect(bar).toBeVisible();
	return {
		labels: await bar.getByRole('link').allTextContents().then((t) => t.map((l) => l.trim())),
		current: (await bar.locator('a[aria-current="page"]').allTextContents()).map((l) => l.trim()),
		box: await bar.boundingBox()
	};
}

test('the gallery tab bar takes a visitor to /stickers and /vr under the same bar', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/gallery');
	const onGallery = await tabBarState(page);
	expect(onGallery.labels).toEqual(['Artwork', 'Stickers', 'VR Avatars']);
	expect(onGallery.current).toEqual(['Artwork']);
	// Links that navigate, so not a tablist.
	await expect(page.getByRole('tablist')).toHaveCount(0);

	const header = page.locator('.header nav');
	const galleryLink = header.getByRole('link', { name: 'Gallery', exact: true });
	await expect(galleryLink).toHaveAttribute('aria-current', 'page');

	await galleryTabBar(page).getByRole('link', { name: 'Stickers' }).click();
	await expect(page).toHaveURL(/\/stickers$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Stickers' })).toBeVisible();
	const onStickers = await tabBarState(page);
	expect(onStickers.labels).toEqual(onGallery.labels);
	expect(onStickers.current).toEqual(['Stickers']);
	// The bar does not jump between its pages.
	expect(onStickers.box).toEqual(onGallery.box);
	// Gallery stays the current section in the header, and the header has no
	// Stickers or VR link of its own.
	await expect(galleryLink).toHaveAttribute('aria-current', 'true');
	await expect(galleryLink).toHaveClass(/\bactive\b/);
	await expect(header.locator('a[href="/stickers"], a[href="/vr"]')).toHaveCount(0);

	await galleryTabBar(page).getByRole('link', { name: 'VR Avatars' }).click();
	await expect(page).toHaveURL(/\/vr$/);
	await expect(page.getByRole('heading', { level: 1, name: 'VR avatars' })).toBeVisible();
	const onVr = await tabBarState(page);
	expect(onVr.labels).toEqual(onGallery.labels);
	expect(onVr.current).toEqual(['VR Avatars']);
	expect(onVr.box).toEqual(onGallery.box);
	await expect(galleryLink).toHaveAttribute('aria-current', 'true');

	await galleryTabBar(page).getByRole('link', { name: 'Artwork' }).click();
	await expect(page).toHaveURL(/\/gallery$/);
	expect((await tabBarState(page)).current).toEqual(['Artwork']);
});

test('the current tab links to the page as it is, filter included', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`/stickers?emoji=${encodeURIComponent('🦊')}`);
	const current = galleryTabBar(page).locator('a[aria-current="page"]');
	await expect(current).toHaveText('Stickers');
	const here = await page.evaluate(() => location.pathname + location.search);
	expect(here).toContain('emoji=');
	await expect(current).toHaveAttribute('href', here);

	// Clicking it keeps the filter.
	await current.click();
	await expect(page).toHaveURL((url) => url.pathname + url.search === here);
});

test('the tab bar is reached with Tab in reading order, current tab included', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/stickers');
	const links = galleryTabBar(page).getByRole('link');
	await links.first().focus();
	for (const name of ['Stickers', 'VR Avatars']) {
		await page.keyboard.press('Tab');
		await expect(galleryTabBar(page).getByRole('link', { name })).toBeFocused();
	}
});

test('a sticker pack page keeps its back link and shows no tab bar, like a gallery piece', async ({ page }) => {
	await page.goto(`/stickers/${PACK_SLUG}`);
	await expect(page.locator('a.back-link[href="/stickers"]')).toBeVisible();
	await expect(galleryTabBar(page)).toHaveCount(0);
	await expect(page.locator('.header nav').getByRole('link', { name: 'Gallery', exact: true })).toHaveAttribute(
		'aria-current',
		'true'
	);
});

test('the Japanese tab bar and nav name the sections in Japanese', async ({ page }) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.goto('/stickers');
	const bar = page.getByRole('navigation', { name: 'ギャラリー', exact: true });
	await expect(bar.getByRole('link')).toHaveText(['イラスト', 'ステッカー', 'VRアバター']);
	await expect(bar.locator('a[aria-current="page"]')).toHaveText('ステッカー');
	await expect(page.locator('.header nav a[href="/stickers"]')).toHaveCount(0);
});

test('on a phone the bottom nav has no Stickers tab and marks Gallery on /stickers', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	const onGallery = (await tabBarState(page)).box;
	await page.goto('/stickers');
	expect((await tabBarState(page)).box?.y, 'the bar moved between /gallery and /stickers').toBe(onGallery?.y);
	const mobileNav = page.locator('nav.mobile-nav');
	await expect(mobileNav.getByRole('link')).toHaveText(['Home', 'Gallery', 'About']);
	await expect(mobileNav.getByRole('link', { name: 'Gallery' })).toHaveAttribute('aria-current', 'true');
	// The gallery's tab bar stands in for the bottom nav's old Stickers tab,
	// and fits the screen.
	const box = (await tabBarState(page)).box!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const localTabBar = (page: Page, locale: string) =>
	page.getByRole('navigation', { name: locale === 'ja' ? 'ギャラリー' : 'Gallery', exact: true });

// On narrow phones the pages' second lines differ in length: /stickers'
// subtitle wraps (Japanese at 320px), /gallery's and /vr's counts do not. The
// bar sits above those lines, so it stays put when they wrap. The fixture's
// owner name is a short 'E2E'; a real one, like the name swapped in below,
// wraps the subtitle at 360px in Japanese and 320px in English too.
const POSITION_CASES = [
	{ locale: 'ja', width: 320 },
	{ locale: 'ja', width: 360 },
	{ locale: 'en', width: 320 }
];
for (const { locale, width } of POSITION_CASES) {
	test(`the ${locale} gallery bar sits at the same height on /gallery, /stickers and /vr at ${width}px`, async ({
		page
	}) => {
		await page.setViewportSize({ width, height: 800 });
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		const tops: Record<string, number | undefined> = {};
		for (const url of ['/gallery', '/stickers', '/vr']) {
			await page.goto(url);
			const bar = localTabBar(page, locale);
			await expect(bar).toBeVisible();
			if (url === '/stickers') {
				const subtitle = page.locator('main p', { hasText: 'Telegram' });
				await subtitle.evaluate((p) => (p.textContent = p.textContent!.replace('E2E', 'Kestrel Moonfeather')));
				await expect(subtitle).toContainText('Kestrel Moonfeather');
			}
			tops[url] = (await bar.boundingBox())?.y;
		}
		expect(tops['/stickers'], `the bar moved: ${JSON.stringify(tops)}`).toBe(tops['/gallery']);
		expect(tops['/vr'], `the bar moved: ${JSON.stringify(tops)}`).toBe(tops['/gallery']);
	});
}

/** Where each tab of the gallery bar sits, whether its label broke onto a
 * second line or spilled out of the tab, and whether the page scrolls sideways. */
async function measureTabBar(bar: Locator) {
	return bar.evaluate((bar) => {
		const tabs = [...bar.querySelectorAll<HTMLElement>('.tab')].map((tab) => {
			const r = tab.getBoundingClientRect();
			// One client rect per rendered line of the label.
			const range = document.createRange();
			range.selectNodeContents(tab);
			const lines = new Set([...range.getClientRects()].map((l) => Math.round(l.top))).size;
			const spills = tab.scrollWidth > tab.clientWidth;
			return { left: r.left, right: r.right, top: Math.round(r.top), width: r.width, lines, spills };
		});
		const b = bar.getBoundingClientRect();
		return { tabs, bar: { left: b.left, right: b.right }, docWidth: document.documentElement.scrollWidth, vw: innerWidth };
	});
}

function expectTabBarFits(m: Awaited<ReturnType<typeof measureTabBar>>) {
	expect(m.docWidth, 'the page scrolls sideways').toBeLessThanOrEqual(m.vw);
	expect(m.bar.left).toBeGreaterThanOrEqual(0);
	expect(m.bar.right).toBeLessThanOrEqual(m.vw);
	for (const t of m.tabs) {
		expect(t.left).toBeGreaterThanOrEqual(0);
		expect(t.right).toBeLessThanOrEqual(m.vw);
		expect(t.lines, 'a label breaks inside its tab').toBe(1);
		expect(t.spills, 'a label spills out of its tab').toBe(false);
	}
}

/** Rows of the bar, top to bottom, as the number of tabs on each. */
const rowsOf = (m: Awaited<ReturnType<typeof measureTabBar>>) => {
	const rows = new Map<number, number>();
	for (const t of m.tabs) rows.set(t.top, (rows.get(t.top) ?? 0) + 1);
	return [...rows.entries()].sort(([a], [b]) => a - b).map(([, n]) => n);
};

// With all four sections the bar is at its widest. This server has no
// fursuit photos (FurTrack is off here, and only the passport server turns it
// on, where a sticker pack would change the homepage's stamps), so the test
// copies the real Stickers tab into a Fursuit Photos tab after Artwork. The
// bar's own CSS lays it out, as it would a rendered fourth tab. On a phone the
// four tabs do not fit one row, so they form an even two-by-two grid: no
// label breaks, nothing leaves the screen, and no tab sits alone on a row.
const FOUR_TAB_CASES = [
	{ width: 320, rows: [2, 2] },
	{ width: 360, rows: [2, 2] },
	{ width: 390, rows: [2, 2] },
	{ width: 1280, rows: [4] }
];
for (const locale of ['en', 'ja']) {
	for (const { width, rows } of FOUR_TAB_CASES) {
		test(`the ${locale} gallery bar with four tabs fits a ${width}px screen`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 800 });
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
			await page.goto('/gallery');
			await waitForHydration(page);
			const bar = localTabBar(page, locale);
			await bar.evaluate((el, label) => {
				const fursuit = el.querySelector('a[href="/stickers"]')!.cloneNode(true) as HTMLElement;
				fursuit.textContent = label;
				fursuit.setAttribute('href', '/gallery?view=fursuit');
				el.querySelector('.tab')!.after(fursuit);
			}, locale === 'ja' ? '着ぐるみ写真' : 'Fursuit Photos');
			await expect(bar.locator('.tab')).toHaveCount(4);

			const m = await measureTabBar(bar);
			expectTabBarFits(m);
			expect(rowsOf(m)).toEqual(rows);
			if (rows.length > 1) {
				// Two even columns.
				const widths = m.tabs.map((t) => Math.round(t.width));
				expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
			}
			await bar.screenshot({ path: testInfo.outputPath(`gallery-tabs-4-${width}-${locale}.png`) });
		});
	}
}

// Three tabs (Artwork, Stickers, VR Avatars). At the narrowest screen: two
// rows, the last tab across the second, with no label broken. From a 360px
// phone up, one row.
const THREE_TAB_CASES = [
	{ width: 320, rows: [2, 1] },
	{ width: 360, rows: [3] },
	{ width: 390, rows: [3] },
	{ width: 1280, rows: [3] }
];
for (const locale of ['en', 'ja']) {
	for (const { width, rows } of THREE_TAB_CASES) {
		test(`the ${locale} gallery bar with three tabs fits a ${width}px screen`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 800 });
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
			await page.goto('/gallery');
			const bar = localTabBar(page, locale);
			await expect(bar.locator('.tab')).toHaveCount(3);
			const m = await measureTabBar(bar);
			expectTabBarFits(m);
			expect(rowsOf(m)).toEqual(rows);
			if (rows.length > 1) {
				// The last tab spans the whole second row.
				const [first, second, third] = m.tabs;
				expect(third.left).toBeCloseTo(first.left, 0);
				expect(third.right).toBeCloseTo(second.right, 0);
			}
			await bar.screenshot({ path: testInfo.outputPath(`gallery-tabs-3-${width}-${locale}.png`) });
		});
	}
}

// Two tabs, as on a site whose only other section is VR avatars: the test
// takes the Stickers tab out of the bar. They keep one row while it fits,
// and stack once the bar is narrower than 16em, here by narrowing the bar's
// box rather than the screen.
const TWO_TAB_CASES = [
	{ barWidth: 240, rows: [2] },
	{ barWidth: 220, rows: [1, 1] }
];
for (const locale of ['en', 'ja']) {
	for (const { barWidth, rows } of TWO_TAB_CASES) {
		test(`the ${locale} gallery bar with two tabs fits a ${barWidth}px box`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: 320, height: 800 });
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
			await page.goto('/gallery');
			await waitForHydration(page);
			const bar = localTabBar(page, locale);
			await bar.evaluate((el, w) => {
				el.querySelector('a[href="/stickers"]')!.remove();
				(el.parentElement as HTMLElement).style.width = `${w}px`;
			}, barWidth);
			await expect(bar.locator('.tab')).toHaveCount(2);
			const m = await measureTabBar(bar);
			expectTabBarFits(m);
			expect(m.bar.right - m.bar.left, 'the bar outgrows its box').toBeLessThanOrEqual(barWidth);
			expect(rowsOf(m)).toEqual(rows);
			await bar.screenshot({ path: testInfo.outputPath(`gallery-tabs-2-${barWidth}-${locale}.png`) });
		});
	}
}

// Text-only zoom (Firefox and Safari) scales px font sizes, so 200% text
// turns the bar's 14px labels into 28px ones. The test sets that size on the
// bar itself, which is what such zoom does to it. Two columns can't hold the
// longest label at that size on a 320px screen, so every tab gets a row.
for (const locale of ['en', 'ja']) {
	for (const count of [3, 4]) {
		test(`the ${locale} gallery bar with ${count} tabs fits a 320px screen at 200% text`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize({ width: 320, height: 800 });
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
			await page.goto('/gallery');
			await waitForHydration(page);
			const bar = localTabBar(page, locale);
			await bar.evaluate(
				(el, { label, count }) => {
					if (count === 4) {
						const fursuit = el.querySelector('a[href="/stickers"]')!.cloneNode(true) as HTMLElement;
						fursuit.textContent = label;
						fursuit.setAttribute('href', '/gallery?view=fursuit');
						el.querySelector('.tab')!.after(fursuit);
					}
					(el.parentElement as HTMLElement).style.fontSize = '28px';
				},
				{ label: locale === 'ja' ? '着ぐるみ写真' : 'Fursuit Photos', count }
			);
			await expect(bar.locator('.tab')).toHaveCount(count);
			expect(await bar.locator('.tab').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('28px');
			const m = await measureTabBar(bar);
			expectTabBarFits(m);
			expect(rowsOf(m)).toEqual(Array(count).fill(1));
			await bar.screenshot({ path: testInfo.outputPath(`gallery-tabs-${count}-320-200pct-${locale}.png`) });
		});
	}
}

// WCAG 1.4.4 and 1.4.10 on the bottom nav, which holds three tabs: Home,
// Gallery and About. With enlarged text the labels must actually grow (a px
// size ignores the reader's setting), every tab and label must stay inside
// the viewport, and the page's last line must still clear the bar. English
// fits one row at 320px up to 300%; Japanese breaks its labels at 200% and
// wraps the last tab onto a row of its own at 300%.
const NAV_CASES = [
	{ locale: 'en', scale: 2, rows: 1, oneLineLabels: true },
	{ locale: 'en', scale: 3, rows: 1, oneLineLabels: true },
	{ locale: 'ja', scale: 2, rows: 1, oneLineLabels: false },
	{ locale: 'ja', scale: 3, rows: 2, oneLineLabels: false }
];

for (const { locale, scale, rows, oneLineLabels } of NAV_CASES) {
	test(`the ${locale} bottom nav fits a 320px screen at ${scale * 100}% text in ${rows === 1 ? 'one row' : 'two rows'}`, async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		await page.goto('/gallery');
		const nav = page.locator('nav.mobile-nav');
		await expect(nav.locator('.tab')).toHaveCount(3);
		const baseSize = await nav.locator('.tab span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

		await page.addStyleTag({ content: `html { font-size: ${scale * 100}% !important; }` });
		const bigSize = await nav.locator('.tab span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(bigSize).toBeCloseTo(baseSize * scale, 1);

		await waitForNavHeight(page);

		const m = await nav.evaluate((el) => {
			const tabs = [...el.querySelectorAll<HTMLElement>('.tab')].map((tab) => {
				const t = tab.getBoundingClientRect();
				const label = tab.querySelector('span')!;
				const l = label.getBoundingClientRect();
				// One client rect per rendered line of the label's text.
				const range = document.createRange();
				range.selectNodeContents(label);
				const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
				return {
					t: { left: t.left, right: t.right, top: t.top, height: t.height },
					l: { left: l.left, right: l.right },
					lines,
					spills: label.scrollWidth > label.clientWidth
				};
			});
			const lowest = Math.max(...[...el.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect().bottom));
			return { tabs, docWidth: document.documentElement.scrollWidth, vw: innerWidth, edgeGap: innerHeight - lowest };
		});
		expect(m.tabs).toHaveLength(3);
		expect(m.docWidth).toBeLessThanOrEqual(m.vw);
		// The last row, and the active mark in it, keeps clear of the screen's edge.
		expect(m.edgeGap, 'space under the last row of tabs').toBeGreaterThanOrEqual(8);
		for (const { t, l, lines, spills } of m.tabs) {
			expect(t.left).toBeGreaterThanOrEqual(0);
			expect(t.right).toBeLessThanOrEqual(m.vw);
			expect(l.left).toBeGreaterThanOrEqual(t.left);
			expect(l.right).toBeLessThanOrEqual(t.right);
			expect(spills, 'the label spills out of its own box').toBe(false);
			expect(t.height).toBeGreaterThanOrEqual(44);
			// English labels never break; the bar wraps whole tabs instead.
			if (oneLineLabels) expect(lines).toBe(1);
		}
		const perRow = new Map<number, number>();
		for (const { t } of m.tabs) perRow.set(Math.round(t.top), (perRow.get(Math.round(t.top)) ?? 0) + 1);
		expect(perRow.size).toBe(rows);

		// The last line of the page still clears the bar.
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const clear = await page.evaluate(() => {
			const credit = document.querySelector('.mobile-credit')!;
			const last = [...credit.children].at(-1)!.getBoundingClientRect();
			return { lastBottom: last.bottom, navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top };
		});
		expect(clear.lastBottom).toBeLessThanOrEqual(clear.navTop);

		await page.screenshot({ path: testInfo.outputPath(`mobile-nav-320-${scale * 100}pct-${locale}.png`) });
	});
}

// At a normal text size on a common phone, the tabs and the header both
// fit: one row of tabs, and the header's name and toggles on one line.
for (const locale of ['en', 'ja']) {
	test(`the ${locale} bottom nav is one row under a one-line header at 390px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		await page.goto('/gallery');
		await waitForNavHeight(page);
		const rows = await navRowCount(page);
		expect(rows).toBe(1);
		const banner = page.getByRole('banner');
		await expect(banner).toBeVisible();
		expect((await banner.boundingBox())!.height).toBeLessThan(80);
		await page.screenshot({ path: testInfo.outputPath(`mobile-nav-390-${locale}.png`) });
	});
}

/** Scroll to the bottom and measure the lowest in-flow content in the main
 * landmark against the top of the bottom nav. The main's own bottom padding is
 * the clearance, so its children are what must end above the bar. */
async function lastContentAgainstNav(page: Page) {
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	return page.evaluate(() => {
		const main = document.querySelector('main#main-content')!;
		let lastBottom = 0;
		let last = '';
		for (const el of main.querySelectorAll<HTMLElement>('*')) {
			const s = getComputedStyle(el);
			if (s.position === 'fixed' || s.position === 'sticky' || s.display === 'none') continue;
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && r.bottom > lastBottom) {
				lastBottom = r.bottom;
				last = `${el.tagName.toLowerCase()}.${el.className} "${el.textContent?.trim().slice(0, 40)}"`;
			}
		}
		return { lastBottom, last, navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top };
	});
}

// The (paths) layout clears the bar with the same variable as the gallery's
// credit, so /connect's last line must clear the wrapped bar as well. Japanese
// at 300%, the one size where the three tabs wrap.
test('the connect page clears the wrapped bottom nav at 320px and 300% text', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.goto('/connect');
	await page.addStyleTag({ content: 'html { font-size: 300% !important; }' });
	await waitForNavHeight(page);
	const { lastBottom, last, navTop } = await lastContentAgainstNav(page);
	expect(lastBottom).toBeGreaterThan(0);
	expect(lastBottom, `${last} ends under the bar`).toBeLessThanOrEqual(navTop);
});

// Before hydration, or with JavaScript off, the bar never publishes its height
// and the clearance falls back to its floor. The floor is in rem, so it grows
// with the reader's text; a px floor let the wrapped bar cover the last lines.
// The enlarged root size is served in the HTML, because no script runs here to
// add it afterwards.
test.describe('with JavaScript off', () => {
	test.use({ javaScriptEnabled: false });

	for (const url of ['/gallery', '/connect']) {
		test(`${url} clears the wrapped bottom nav at 320px and 300% text`, async ({ page }) => {
			await page.setViewportSize({ width: 320, height: 800 });
			// Japanese at 300%, the one size where the three tabs wrap.
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
			await serveScaled(page, url, 3);
			await page.goto(url);
			const rows = await navRowCount(page);
			expect(rows, 'the bar wraps at this size, or this test proves nothing').toBeGreaterThan(1);
			const m = await page.evaluate(() => {
				const root = getComputedStyle(document.documentElement);
				return {
					navHeight: (document.querySelector('nav.mobile-nav') as HTMLElement).offsetHeight,
					scrollPadding: parseFloat(root.scrollPaddingBottom),
					rootSize: parseFloat(root.fontSize)
				};
			});
			// The clearance floor (6.5rem) has to hold the bar with a 20px gap to
			// spare. The bar's height depends on the Japanese fallback font the
			// machine has: CI's made it 183px, a Mac's about 159px. If a font
			// change grows the bar past this, raise the floor in app.css and the
			// scroll-padding fallback in MobileNav.svelte together.
			expect(
				m.navHeight + 20,
				'the wrapped bar outgrew the no-script clearance floor; a fallback font change can do this'
			).toBeLessThanOrEqual(6.5 * m.rootSize);
			// A focused control at the foot of the page stops above the wrapped bar.
			expect(m.scrollPadding, 'the scroll-padding fallback is shorter than the bar').toBeGreaterThanOrEqual(
				m.navHeight + 6
			);
			const { lastBottom, last, navTop } = await lastContentAgainstNav(page);
			expect(lastBottom).toBeGreaterThan(0);
			expect(lastBottom, `${last} ends under the bar`).toBeLessThanOrEqual(navTop);
			// The floor leaves a visible gap above the bar, not a touch.
			expect(navTop - lastBottom, `${last} ends too close to the bar`).toBeGreaterThanOrEqual(20);
		});
	}
});

// Sticker filters update the page in place, like the gallery's
// (gallery-filters.spec.ts): no reload, no whole-page fade, no jump to the
// top, focus stays on the chip, and on the pack page a card that survives the
// filter keeps its element. Clicking before hydration does nothing, so each
// click retries until the URL takes the filter. Because focus stays on the
// chip, a screen reader learns about the results from a status region: the
// unfiltered summary, then the result count with the active filter, then the
// unfiltered summary again once the filters clear.
test.describe('sticker filters', () => {
	test.use({ viewport: { width: 1280, height: 360 } });
	test.beforeEach(async ({ page }) => {
		test.slow();
		await countViewTransitions(page);
	});

	async function clickChipInPlace(page: Page, emoji: string) {
		const chip = page.locator('button.emoji-chip', { hasText: emoji });
		let y = 0;
		await expect(async () => {
			// Scrolled down, with the chip still 100px into the viewport so the
			// click itself doesn't have to scroll.
			await markWindow(page);
			y = await chip.evaluate((el) => {
				scrollTo(0, Math.max(40, el.getBoundingClientRect().top + scrollY - 100));
				return scrollY;
			});
			expect(y).toBeGreaterThan(0);
			await chip.click();
			await expect(page).toHaveURL(/[?&]emoji=/, { timeout: 10_000 });
		}).toPass({ timeout: 60_000 });
		await expect(chip).toHaveClass(/\bactive\b/);
		expect(await inPlaceState(page)).toEqual({ sameWindow: true, transitions: 0 });
		expect(await page.evaluate(() => scrollY)).toBe(y);
		await expect(chip).toBeFocused();
	}

	test('the pack page emoji filter keeps scroll, focus, and the surviving card', async ({ page }) => {
		await page.goto(`/stickers/${PACK_SLUG}`);
		const second = page.locator(`.sticker-grid a[href="/stickers/${PACK_SLUG}/2"]`);
		const status = page.locator('[role="status"].sr-only');
		await expect(page.locator('.sticker-grid .card')).toHaveCount(2);
		await expect(status).toHaveText('2 stickers');
		await second.evaluate((el) => ((window as unknown as { __card: Element }).__card = el));

		await clickChipInPlace(page, '🎉');
		await expect(page.locator('.sticker-grid .card')).toHaveCount(1);
		expect(await second.evaluate((el) => el === (window as unknown as { __card: Element }).__card)).toBe(true);
		await expect(status).toHaveText('1 sticker, Emoji: 🎉');

		await page.getByRole('button', { name: 'Clear filters' }).click();
		await expect(page).not.toHaveURL(/[?&]emoji=/);
		await expect(page.locator('.sticker-grid .card')).toHaveCount(2);
		await expect(status).toHaveText('2 stickers');
	});

	test('the /stickers emoji filter keeps scroll and focus', async ({ page }) => {
		await page.goto('/stickers');
		const status = page.locator('[role="status"].sr-only');
		await expect(status).toHaveText('1 sticker pack');
		await clickChipInPlace(page, '🦊');
		await expect(page.locator('.sticker-grid .card')).toHaveCount(1);
		await expect(status).toHaveText('1 sticker, Emoji: 🦊, in 1 pack');

		await page.getByRole('button', { name: 'Clear filters' }).click();
		await expect(page).not.toHaveURL(/[?&]emoji=/);
		await expect(page.locator('.pack-grid .pack-card')).toHaveCount(1);
		await expect(status).toHaveText('1 sticker pack');
	});
});
