import { test, expect, type Page } from '@playwright/test';
import { failOnPageErrors } from './page-errors';

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
const comboInput = (page: Page) => page.locator('input.combobox-input');

// In `vite dev`, a change made before hydration does nothing. The artist
// combobox answers ArrowDown only once Svelte has attached its handlers, so
// keep pressing until it does (the same probe gallery-artist-combobox uses),
// then close the list again.
async function openHydrated(page: Page) {
	await page.goto('/gallery');
	await expect(async () => {
		await comboInput(page).focus();
		await comboInput(page).press('ArrowDown');
		await expect(comboInput(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0', {
			timeout: 1500
		});
	}).toPass({ timeout: 45_000 });
	await comboInput(page).press('Escape');
	await comboInput(page).blur();
}

test.describe('gallery filter change', () => {
	// Short enough that the seeded grid scrolls; wide enough that the filter
	// selects show (they hide below 768px).
	test.use({ viewport: { width: 1280, height: 420 } });
	test.beforeEach(() => test.slow());

	test('updates in place: no reload, no fade, same scroll, same focus, same cards', async ({ page }) => {
		// Count whole-page View Transitions from the first script on.
		await page.addInitScript(() => {
			const w = window as unknown as { __transitions: number };
			w.__transitions = 0;
			const start = document.startViewTransition?.bind(document);
			if (start) {
				document.startViewTransition = ((cb: never) => {
					w.__transitions++;
					return start(cb);
				}) as typeof document.startViewTransition;
			}
		});
		await openHydrated(page);
		await expect(cardLinks(page).first()).toHaveAttribute('href', '/gallery/mature-ref-sheet');

		// Tag the window, and remember each card's img element by the piece it shows.
		await page.evaluate(() => {
			const w = window as unknown as { __marker: string; __imgs: Record<string, [Element, string]> };
			w.__marker = 'still here';
			w.__imgs = {};
			for (const a of document.querySelectorAll('.grid a.card')) {
				const img = a.querySelector('img')!;
				w.__imgs[a.getAttribute('href')!] = [img, img.getAttribute('src')!];
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
		await expect(cardLinks(page).first()).toHaveAttribute('href', '/gallery/parent-piece');

		// (a) No document load: the window is the same one, and no HTML was fetched.
		expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('still here');
		expect(documents).toEqual([]);
		// No whole-page fade either.
		expect(await page.evaluate(() => (window as unknown as { __transitions: number }).__transitions)).toBe(0);
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
					const href = a.getAttribute('href')!;
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
		await openHydrated(page);
		const hrefs = () => cardLinks(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
		const blurredHrefs = () =>
			cardLinks(page).evaluateAll((as) =>
				as.filter((a) => a.querySelector('img.blurred')).map((a) => a.getAttribute('href')!)
			);
		const mature = page.locator('.grid a.card[href="/gallery/mature-ref-sheet"]');

		expect(await hrefs()).toHaveLength(3);
		expect((await hrefs())[0]).toBe('/gallery/mature-ref-sheet');
		const nsfwBefore = await blurredHrefs();
		expect(nsfwBefore).toContain('/gallery/mature-ref-sheet');

		await mature.locator('.nsfw-overlay').click();
		await expect(page).toHaveURL(/\/gallery(\?|$)/);
		await expect(mature.locator('img')).not.toHaveClass(/\bblurred\b/);

		await sortSelect(page).selectOption('oldest');
		await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
		await expect(cardLinks(page).first()).toHaveAttribute('href', '/gallery/parent-piece');

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

	test('announces the new result count, since focus stays on the filter', async ({ page }) => {
		await openHydrated(page);
		const status = page.locator('p.count[role="status"]');
		await expect(status).toHaveText('3 artworks');

		const tagSelect = page.getByRole('combobox', { name: 'Tag', exact: true });
		await tagSelect.focus();
		await tagSelect.selectOption('reference');
		await expect(page).toHaveURL(/[?&]tag=reference(&|$)/);
		await expect(tagSelect).toBeFocused();
		await expect(status).toHaveText('1 artwork');
	});
});

// The card's srcset candidates (see cardImage in src/lib/img.ts).
const CARD_WIDTHS = [400, 800];

// The first card is the newest published piece, mature-ref-sheet, seeded at
// 1200x900 in tests/e2e/fixtures/seed.sql. Its square cover slot paints it at
// the slot height times this aspect, so that is the width it needs.
const FIRST_CARD_ASPECT = 1200 / 900;

// Rewriting srcset before hydration makes Svelte log
// hydration_attribute_changed and may put the SSR value back, so wait for
// hydration first. The artist combobox probe needs the filter selects, which
// are hidden below 768px; the search box shows at every width. Before
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

// cdnImage hands back the raw URL in dev, so every srcset candidate here is the
// same file and currentSrc can't show which one the browser chose. Swap the
// candidates for distinct URLs, keep the card's own `sizes`, and let the
// browser pick: that is the width a real visitor's browser would download.
async function pickedCardWidth(page: Page) {
	await page.route('**/e2e-card-w*.png', (route) =>
		route.fulfill({ path: 'tests/e2e/fixtures/e2e-thumb.png', contentType: 'image/png' })
	);
	await gotoHydrated(page);
	await expect(cardLinks(page).first()).toHaveAttribute('href', '/gallery/mature-ref-sheet');
	const img = page.locator('.grid a.card img').first();
	await expect(img).toHaveAttribute('sizes', /\S/);
	const srcset = (await img.getAttribute('srcset')) ?? '';
	const widths = [...srcset.matchAll(/\s(\d+)w(?:,|$)/g)].map((m) => Number(m[1]));
	expect(widths).toEqual(CARD_WIDTHS);

	await img.evaluate((el: HTMLImageElement, ws: number[]) => {
		el.srcset = ws.map((w) => `/e2e-card-w${w}.png ${w}w`).join(', ');
	}, widths);
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
			const { picked, needed } = await pickedCardWidth(page);
			expect(picked).toBeGreaterThanOrEqual(needed);
			expect(picked).toBe(400);
			await page.screenshot({ path: test.info().outputPath('gallery-desktop-1x.png') });
		});
	});

	for (const deviceScaleFactor of [2, 3]) {
		test.describe(`phone, ${deviceScaleFactor}x`, () => {
			test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor });

			test('a phone card never downloads a variant narrower than it paints', async ({ page }) => {
				const { picked, needed } = await pickedCardWidth(page);
				expect(picked).toBeGreaterThanOrEqual(needed);
				await page.screenshot({ path: test.info().outputPath(`gallery-phone-${deviceScaleFactor}x.png`) });
			});
		});
	}
});
