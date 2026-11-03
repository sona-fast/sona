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
// top-level images (parent-piece, ref-sheet, mature-ref-sheet), newest first.

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
});

// The widths every gallery image is already transformed at, so the card adds
// at most one new transform per image (see CARD_IMAGE in src/lib/img.ts).
const CARD_WIDTHS = [200, 400, 800];

// cdnImage hands back the raw URL in dev, so every srcset candidate here is the
// same file and currentSrc can't show which one the browser chose. Swap the
// candidates for distinct URLs, keep the card's own `sizes`, and let the
// browser pick: that is the width a real visitor's browser would download.
async function pickedCardWidth(page: Page) {
	await page.route('**/e2e-card-w*.png', (route) =>
		route.fulfill({ path: 'tests/e2e/fixtures/e2e-thumb.png', contentType: 'image/png' })
	);
	const img = page.locator('.grid a.card img').first();
	await expect(img).toHaveAttribute('sizes', /\S/);
	const srcset = (await img.getAttribute('srcset')) ?? '';
	const widths = [...srcset.matchAll(/\s(\d+)w(?:,|$)/g)].map((m) => Number(m[1]));
	expect(widths).toEqual(CARD_WIDTHS);

	await img.evaluate((el: HTMLImageElement, ws: number[]) => {
		el.srcset = ws.map((w) => `/e2e-card-w${w}.png ${w}w`).join(', ');
	}, widths);
	await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.currentSrc)).toMatch(/e2e-card-w\d+\.png/);
	return img.evaluate((el: HTMLImageElement) => ({
		picked: Number(/e2e-card-w(\d+)\.png/.exec(el.currentSrc)![1]),
		needed: el.getBoundingClientRect().width * devicePixelRatio
	}));
}

test.describe('artwork card image size', () => {
	test.describe('desktop', () => {
		test.use({ viewport: { width: 1280, height: 900 } });

		test('a ~290px card downloads the 400 variant, not 800', async ({ page }) => {
			await page.goto('/gallery');
			const { picked, needed } = await pickedCardWidth(page);
			expect(needed).toBeGreaterThan(200);
			expect(needed).toBeLessThanOrEqual(400);
			expect(picked).toBe(400);
		});
	});

	test.describe('phone', () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test('a two-column phone card downloads the 200 variant', async ({ page }) => {
			await page.goto('/gallery');
			const { picked, needed } = await pickedCardWidth(page);
			expect(needed).toBeLessThanOrEqual(200);
			expect(picked).toBe(200);
			await page.screenshot({ path: test.info().outputPath('gallery-phone.png') });
		});
	});
});
