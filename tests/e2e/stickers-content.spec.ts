import { test, expect } from '@playwright/test';

// The ungated half of the nav content-gating rule, and the only end-to-end proof
// that a sticker pack renders at all.
//
// nav-gating.spec.ts covers the other half on the shared server, whose fixture
// deliberately has ZERO packs: that is what makes the header, the bottom nav and
// the gallery tab bar render their gated state. A published pack in that fixture
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

test('the Stickers link is ungated once a published pack exists', async ({ page }) => {
	await page.goto('/gallery');

	// The twin of nav-gating.spec.ts, which asserts these are absent on a fork
	// with no packs. Same three places, opposite expectation.
	await expect(page.locator('.header nav a[href="/stickers"]')).toBeVisible();
	await expect(page.locator('.tabs a[href="/stickers"]')).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	await expect(page.locator('.mobile-nav a[href="/stickers"]')).toBeVisible();
});

// WCAG 1.4.4 and 1.4.10 on the bottom nav. This server is the one where the
// Stickers tab shows, so the bar carries its widest set of five tabs. At 320px
// with 200% text the labels must actually grow (a px size ignores the reader's
// setting), every tab and label must stay inside the viewport, the bar must
// wrap onto more rows rather than push tabs off screen, and the page's last
// line must still clear the taller bar.
for (const { locale, stickers } of [
	{ locale: 'en', stickers: 'Stickers' },
	{ locale: 'ja', stickers: 'ステッカー' }
]) {
	test(`the ${locale} bottom nav wraps inside a 320px screen at 200% text`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		await page.goto('/gallery');
		const nav = page.locator('nav.mobile-nav');
		await expect(nav.getByRole('link', { name: stickers })).toBeVisible();
		const baseSize = await nav.locator('.tab span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

		await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
		const bigSize = await nav.locator('.tab span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(bigSize).toBeCloseTo(baseSize * 2, 1);

		// The bar publishes its height once hydrated; wait for it to match the
		// wrapped bar before measuring what depends on it.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const h = getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-height');
					return h === `${(document.querySelector('nav.mobile-nav') as HTMLElement).offsetHeight}px`;
				})
			)
			.toBe(true);

		const m = await nav.evaluate((el) => {
			const tabs = [...el.querySelectorAll<HTMLElement>('.tab')].map((tab) => {
				const t = tab.getBoundingClientRect();
				const label = tab.querySelector('span')!;
				const l = label.getBoundingClientRect();
				// One client rect per rendered line of the label's text.
				const range = document.createRange();
				range.selectNodeContents(label);
				const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
				return { t: { left: t.left, right: t.right, top: t.top }, l: { left: l.left, right: l.right }, lines };
			});
			return { tabs, docWidth: document.documentElement.scrollWidth, vw: innerWidth };
		});
		expect(m.tabs).toHaveLength(5);
		expect(m.docWidth).toBeLessThanOrEqual(m.vw);
		for (const { t, l, lines } of m.tabs) {
			expect(t.left).toBeGreaterThanOrEqual(0);
			expect(t.right).toBeLessThanOrEqual(m.vw);
			expect(l.left).toBeGreaterThanOrEqual(t.left);
			expect(l.right).toBeLessThanOrEqual(t.right);
			// A label never breaks mid-word; the bar wraps whole tabs instead.
			expect(lines).toBe(1);
		}
		const rows = new Set(m.tabs.map(({ t }) => Math.round(t.top))).size;
		expect(rows).toBeGreaterThan(1);

		// The last line of the page still clears the taller bar.
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const clear = await page.evaluate(() => {
			const credit = document.querySelector('.mobile-credit')!;
			const last = [...credit.children].at(-1)!.getBoundingClientRect();
			return { lastBottom: last.bottom, navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top };
		});
		expect(clear.lastBottom).toBeLessThanOrEqual(clear.navTop);

		await page.screenshot({ path: testInfo.outputPath(`mobile-nav-320-200pct-${locale}.png`) });
	});
}
