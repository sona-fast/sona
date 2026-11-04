import { test, expect, type Page } from '@playwright/test';
import { failOnPageErrors } from './page-errors';
import { countViewTransitions, inPlaceState, markWindow } from './in-place';
import { waitForHydration } from './admin-login';
import { contrastRatio, overlayColors } from './contrast';

// A gallery filter change has to feel like the page updating in place, not a
// reload. A visitor reported "the page refreshes on many of the dropdowns".
// The document never actually reloaded; four things together made it look
// like it did:
//   1. a whole-page View Transition faded the document out and back in,
//   2. the navigation scrolled back to the top,
//   3. focus left the select for the body,
//   4. the unkeyed grid reused card elements by position and swapped their
//      src, so every card flashed to a different image.
// The card test covers the second report: a ~290px card downloaded the
// 800px transform. Seed: tests/e2e/fixtures/seed.sql, which publishes three
// top-level images (parent-piece, ref-sheet, mature-ref-sheet), newest first;
// mature-ref-sheet is the one NSFW card, and only ref-sheet is tagged
// 'reference'.

failOnPageErrors();

const sortSelect = (page: Page) => page.getByRole('combobox', { name: 'Sort by' });
const cardLinks = (page: Page) => page.locator('.grid a.card');
// Card links carry the grid's filters and sort as a query (SONA-179), so match
// the piece by path.
const cardHref = (slug: string) => new RegExp(`^/gallery/${slug}(\\?|$)`);

// In `vite dev`, a change made before hydration does nothing, and rewriting
// srcset before it makes Svelte log hydration_attribute_changed. The search
// box shows at every width (the filter selects hide below 768px). Before
// hydration a change there does nothing (there is no form); after it, the
// change navigates to ?q=. Each attempt types a new value, so a retry still
// fires `change`. Clearing it again brings back the full grid.
async function gotoHydrated(page: Page) {
	await page.goto('/gallery');
	const search = page.locator('input[type="search"]');
	let attempt = 0;
	await expect(async () => {
		attempt++;
		await search.fill(`e2e-probe-${attempt}`);
		await search.press('Enter');
		await expect(page).toHaveURL(new RegExp(`[?&]q=e2e-probe-${attempt}(&|$)`), { timeout: 1500 });
	}).toPass({ timeout: 45_000 });
	await search.fill('');
	await search.press('Enter');
	await expect(page).not.toHaveURL(/[?&]q=/);
	await expect(cardLinks(page)).toHaveCount(3);
}

test.describe('gallery filter change', () => {
	// Short enough that the seeded grid scrolls; wide enough that the filter
	// selects show (they hide below 768px).
	test.use({ viewport: { width: 1280, height: 420 } });
	test.beforeEach(() => test.slow());

	test('updates in place: no reload, no fade, same scroll, same focus, same cards', async ({ page }) => {
		await countViewTransitions(page);
		await gotoHydrated(page);
		await expect(cardLinks(page).first()).toHaveAttribute('href', cardHref('mature-ref-sheet'));

		// Tag the window, and remember each card's img element by the piece it shows.
		await markWindow(page);
		await page.evaluate(() => {
			const w = window as unknown as { __imgs: Record<string, [Element, string]> };
			w.__imgs = {};
			for (const a of document.querySelectorAll('.grid a.card')) {
				const img = a.querySelector('img')!;
				w.__imgs[new URL((a as HTMLAnchorElement).href).pathname] = [img, img.getAttribute('src')!];
			}
		});
		const before = await page.evaluate(() => Object.keys((window as unknown as { __imgs: object }).__imgs));
		expect(before).toHaveLength(3);

		await sortSelect(page).focus();
		await page.evaluate(() => window.scrollTo(0, 150));
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(150);
		const documents: string[] = [];
		page.on('request', (r) => {
			if (r.resourceType() === 'document') documents.push(r.url());
		});

		await sortSelect(page).selectOption('oldest');
		await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
		await expect(cardLinks(page).first()).toHaveAttribute('href', cardHref('parent-piece'));

		// (a) No document load: the window is the same one, and no HTML was
		// fetched. No whole-page fade either.
		expect(await inPlaceState(page)).toEqual({ sameWindow: true, transitions: 0 });
		expect(documents).toEqual([]);
		// (b) The page stays where the visitor scrolled it.
		expect(await page.evaluate(() => window.scrollY)).toBe(150);
		// (c) Focus stays on the select they just changed.
		await expect(sortSelect(page)).toBeFocused();
		// (d) Every card that was there before keeps its own img element and src,
		// so none of them flashes to another image.
		const kept = await page.evaluate(() => {
			const w = window as unknown as { __imgs: Record<string, [Element, string]> };
			return Object.fromEntries(
				[...document.querySelectorAll('.grid a.card')].map((a) => {
					const href = new URL((a as HTMLAnchorElement).href).pathname;
					const img = a.querySelector('img')!;
					const [was, src] = w.__imgs[href] ?? [];
					return [href, { sameElement: img === was, sameSrc: img.getAttribute('src') === src }];
				})
			);
		});
		expect(kept).toEqual(
			Object.fromEntries(before.map((href) => [href, { sameElement: true, sameSrc: true }]))
		);

		// Kept with the test output so a pass can be checked afterwards. (Not
		// settledShot: the footer badge's ember animation loops forever.)
		await page.screenshot({ path: test.info().outputPath('gallery-after-sort.png') });
	});

	test('an NSFW reveal stays with its image when the sort moves it', async ({ page }) => {
		await gotoHydrated(page);
		const hrefs = () => cardLinks(page).evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
		const blurredHrefs = () =>
			cardLinks(page).evaluateAll((as) =>
				as.filter((a) => a.querySelector('img.blurred')).map((a) => new URL((a as HTMLAnchorElement).href).pathname)
			);
		const mature = page.locator('.grid a.card[href^="/gallery/mature-ref-sheet"]');

		expect(await hrefs()).toHaveLength(3);
		expect((await hrefs())[0]).toBe('/gallery/mature-ref-sheet');
		const nsfwBefore = await blurredHrefs();
		expect(nsfwBefore).toContain('/gallery/mature-ref-sheet');

		await mature.locator('.nsfw-overlay').click();
		await expect(page).toHaveURL(/\/gallery(\?|$)/);
		await expect(mature.locator('img')).not.toHaveClass(/\bblurred\b/);

		await sortSelect(page).selectOption('oldest');
		await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
		await expect(cardLinks(page).first()).toHaveAttribute('href', cardHref('parent-piece'));

		// The revealed card moved, and is still revealed.
		expect((await hrefs()).indexOf('/gallery/mature-ref-sheet')).toBeGreaterThan(0);
		await expect(mature.locator('img')).not.toHaveClass(/\bblurred\b/);
		await expect(mature.locator('.nsfw-overlay')).toHaveCount(0);
		// And no other NSFW card took the reveal: every one still blurred.
		expect((await blurredHrefs()).sort()).toEqual(
			nsfwBefore.filter((h) => h !== '/gallery/mature-ref-sheet').sort()
		);

		await page.screenshot({ path: test.info().outputPath('gallery-reveal-after-sort.png') });
	});

	// Focus stays on the filter, so a screen reader hears the change from a
	// status region. It names the sort and the filters as well as the count,
	// so a change that keeps the count (a sort) still changes what it says.
	test('announces the results, the filters, and the sort, since focus stays on the filter', async ({ page }) => {
		await gotoHydrated(page);
		const status = page.locator('[role="status"].sr-only');
		await expect(status).toHaveText(/^3 artworks, Sort by: /);
		const before = await status.textContent();

		await sortSelect(page).focus();
		await sortSelect(page).selectOption('oldest');
		await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
		await expect(status).toHaveText('3 artworks, Sort by: Oldest upload');
		expect(await status.textContent()).not.toBe(before);

		const tagSelect = page.getByRole('combobox', { name: 'Tag', exact: true });
		await tagSelect.focus();
		await tagSelect.selectOption('reference');
		await expect(page).toHaveURL(/[?&]tag=reference(&|$)/);
		await expect(tagSelect).toBeFocused();
		await expect(status).toHaveText('1 artwork, Tag: reference, Sort by: Oldest upload');
		// The visible count is plain text, not a second live region.
		await expect(page.locator('p.count')).toHaveText('1 artwork');
		await expect(page.locator('p.count')).not.toHaveAttribute('role');
	});
});

// The worst case for the NSFW card's overlay is white art under the 60% scrim:
// both lines have to read at 4.5:1 there, so neither may be faded.
test('the NSFW card overlay text reads at 4.5:1 over white art', async ({ page }) => {
	await page.goto('/gallery');
	const { scrim, texts } = await overlayColors(page, '.grid a.card[href^="/gallery/mature-ref-sheet"] .nsfw-overlay');
	expect(texts.map((t) => t.text)).toEqual(['NSFW', 'Show anyway']);
	for (const { text, rgb } of texts) {
		expect(contrastRatio(rgb, scrim), `"${text}" on the scrim over white`).toBeGreaterThanOrEqual(4.5);
	}
});

// The card's srcset candidates (see cardImage in src/lib/img.ts).
const CARD_WIDTHS = [400, 800];

// On both /gallery and the home page's recent grid, the first card is the
// newest published top-level piece, mature-ref-sheet, seeded at 1200x900 in
// tests/e2e/fixtures/seed.sql. Its square cover slot paints it at the slot
// height times this aspect, so that is the width it needs.
const FIRST_CARD_ASPECT = 1200 / 900;

// cdnImage hands back the raw URL in dev, so every srcset candidate here is the
// same file and currentSrc can't show which one the browser chose. Swap the
// candidates for distinct URLs, keep the card's own `sizes`, and let the
// browser pick: that is the width a real visitor's browser would download.
//
// The home page has no search box to probe, so it waits on the bottom nav's
// hydration signal instead (see waitForHydration).
async function pickedCardWidth(page: Page, path: '/gallery' | '/') {
	await page.route('**/e2e-card-w*.png', (route) =>
		route.fulfill({ path: 'tests/e2e/fixtures/e2e-thumb.png', contentType: 'image/png' })
	);
	if (path === '/gallery') {
		await gotoHydrated(page);
	} else {
		await page.goto(path);
		await waitForHydration(page);
	}
	await expect(cardLinks(page).first()).toHaveAttribute('href', cardHref('mature-ref-sheet'));
	const img = page.locator('.grid a.card img').first();
	await expect(img).toHaveAttribute('sizes', /\S/);
	const srcset = (await img.getAttribute('srcset')) ?? '';
	const widths = [...srcset.matchAll(/\s(\d+)w(?:,|$)/g)].map((m) => Number(m[1]));
	expect(widths).toEqual(CARD_WIDTHS);

	await img.evaluate((el: HTMLImageElement, ws: number[]) => {
		el.srcset = ws.map((w) => `/e2e-card-w${w}.png ${w}w`).join(', ');
	}, widths);
	// The cards are lazy, and the home grid sits below the banner.
	await img.scrollIntoViewIfNeeded();
	await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.currentSrc)).toMatch(/e2e-card-w\d+\.png/);
	return img.evaluate(
		(el: HTMLImageElement, aspect: number) => ({
			picked: Number(/e2e-card-w(\d+)\.png/.exec(el.currentSrc)![1]),
			needed: el.getBoundingClientRect().width * Math.max(1, aspect) * devicePixelRatio
		}),
		FIRST_CARD_ASPECT
	);
}

test.describe('artwork card image size', () => {
	test.beforeEach(() => test.slow());

	test.describe('desktop, 1x', () => {
		test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

		test('a ~293px card downloads the 400 variant, not 800', async ({ page }) => {
			const { picked, needed } = await pickedCardWidth(page, '/gallery');
			expect(picked).toBeGreaterThanOrEqual(needed);
			expect(picked).toBe(400);
			await page.screenshot({ path: test.info().outputPath('gallery-desktop-1x.png') });
		});
	});

	for (const deviceScaleFactor of [2, 3]) {
		test.describe(`phone, ${deviceScaleFactor}x`, () => {
			test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor });

			test('a phone card never downloads a variant narrower than it paints', async ({ page }) => {
				const { picked, needed } = await pickedCardWidth(page, '/gallery');
				expect(picked).toBeGreaterThanOrEqual(needed);
				await page.screenshot({ path: test.info().outputPath(`gallery-phone-${deviceScaleFactor}x.png`) });
			});
		});
	}

	// At 1x a two-column phone card needs about 233px, so it should get 400.
	// Sized as one column (100vw × 1.34, about 523px) it would get 800, which
	// the 2x and 3x phones above pick either way. Gallery slot: (390 − 32 − 10)
	// / 2 = 174px; home: (390 − 32 − 12) / 2 = 173px.
	test.describe('phone, 1x, two columns', () => {
		test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

		for (const [name, path] of [['the gallery', '/gallery'], ['the home page', '/']] as const) {
			test(`a card on ${name} downloads the 400 variant`, async ({ page }) => {
				const { picked, needed } = await pickedCardWidth(page, path);
				expect(picked).toBeGreaterThanOrEqual(needed);
				expect(picked).toBe(400);
				await page.screenshot({ path: test.info().outputPath(`card-phone-1x-${path === '/' ? 'home' : 'gallery'}.png`) });
			});
		}
	});
});
