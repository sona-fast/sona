import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from './admin-login';
import { failOnPageErrors } from './page-errors';
import { settledShot } from './settled-shot';

// SONA-179: previous/next paging, by visible controls and by Left/Right arrows,
// on the art detail page (through the grid the visitor came from) and across
// one VR avatar's looks; plus the one-ahead preload of the next piece's hero.
//
// Runs on the SHARED read-only server: it only reads seeded rows
// (fixtures/seed.sql). The grid there holds three published, non-variant
// pieces, newest first: Mature Ref Sheet (07-05), Ref Sheet (07-03), Parent
// Piece SFW (07-01). The variant (image 2) never gets a card.

failOnPageErrors();

const h1 = (page: Page) => page.locator('.image-meta h1');
const pager = (page: Page) => page.getByRole('navigation', { name: 'Browse the gallery' });
const prevLink = (page: Page) => pager(page).getByRole('link', { name: /^Previous:/ });
const nextLink = (page: Page) => pager(page).getByRole('link', { name: /^Next:/ });

/** Opens `path` fresh and waits for the app to hydrate, so the arrow-key
 *  listener and the client router are attached before the first keypress.
 *  Reduced motion is asked for on the page: the config's `use.reducedMotion`
 *  reaches no browser (see tag-suggestions.spec.ts), and without it the
 *  footer badge's endless glow keeps settledShot from ever settling. */
async function open(page: Page, path: string) {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(path);
	await waitForHydration(page);
}

/**
 * Focuses a text input the test adds to the page, presses `key` there, and
 * reports whether anything consumed the key (the pager calls preventDefault
 * when it pages). The flag is read synchronously after dispatch, so there is
 * no wait-and-hope window. The detail pages have no text field of their own.
 */
async function pressInTextInput(page: Page, key: string): Promise<boolean> {
	await page.evaluate(() => {
		const input = document.createElement('input');
		input.type = 'text';
		input.id = 'e2e-paging-input';
		input.value = 'caret here';
		document.querySelector('main')!.prepend(input);
		window.addEventListener('keydown', (e) => {
			(window as unknown as { __pagingConsumed: boolean }).__pagingConsumed = e.defaultPrevented;
		});
	});
	await page.locator('#e2e-paging-input').focus();
	await page.keyboard.press(key);
	const consumed = await page.evaluate(() => (window as unknown as { __pagingConsumed: boolean }).__pagingConsumed);
	await page.evaluate(() => document.getElementById('e2e-paging-input')!.remove());
	return consumed;
}

/** Moves focus off whatever has it, back to the page itself. */
async function blurFocus(page: Page) {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('art detail paging', () => {
	test('arrow keys page through the grid in both directions', async ({ page }) => {
		await open(page, '/gallery/ref-sheet');
		await expect(h1(page)).toHaveText('Ref Sheet');

		await page.keyboard.press('ArrowRight');
		await expect(page).toHaveURL(/\/gallery\/parent-piece$/);
		await expect(h1(page)).toHaveText('Parent Piece SFW');

		await page.keyboard.press('ArrowLeft');
		await expect(page).toHaveURL(/\/gallery\/ref-sheet$/);
		await expect(h1(page)).toHaveText('Ref Sheet');

		await page.keyboard.press('ArrowLeft');
		await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet$/);
		await expect(h1(page)).toHaveText('Mature Ref Sheet');
	});

	test('the buttons page, and each end leaves out the side it has run out of', async ({ page }, testInfo) => {
		await open(page, '/gallery/mature-ref-sheet');
		// First card: no previous piece.
		await expect(nextLink(page)).toHaveAccessibleName('Next: Ref Sheet');
		await expect(prevLink(page)).toHaveCount(0);
		// An arrow toward the missing side does nothing.
		await page.keyboard.press('ArrowLeft');
		await expect(h1(page)).toHaveText('Mature Ref Sheet');

		await nextLink(page).click();
		await expect(h1(page)).toHaveText('Ref Sheet');
		await expect(prevLink(page)).toHaveAccessibleName('Previous: Mature Ref Sheet');
		await expect(nextLink(page)).toHaveAccessibleName('Next: Parent Piece SFW');
		await settledShot(page, testInfo.outputPath('art-detail-pager-middle.png'));

		await nextLink(page).click();
		await expect(h1(page)).toHaveText('Parent Piece SFW');
		// Last card: no next piece.
		await expect(nextLink(page)).toHaveCount(0);
		await expect(prevLink(page)).toBeVisible();

		await prevLink(page).click();
		await expect(h1(page)).toHaveText('Ref Sheet');
	});

	test('arrows do nothing while a text input has focus, or with a modifier held', async ({ page }) => {
		await open(page, '/gallery/mature-ref-sheet');

		expect(await pressInTextInput(page, 'ArrowRight')).toBe(false);
		await page.keyboard.press('Shift+ArrowRight');
		await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet$/);

		// Control: with focus back on the page the same key pages exactly one step,
		// so neither press above was queued behind it.
		await blurFocus(page);
		await page.keyboard.press('ArrowRight');
		await expect(h1(page)).toHaveText('Ref Sheet');
		await expect(page).toHaveURL(/\/gallery\/ref-sheet$/);
	});

	test('pages in the order of the grid the visitor came from, and keeps that context', async ({ page }) => {
		await open(page, '/gallery?sort=oldest');
		// Oldest first: Parent Piece SFW, Ref Sheet, Mature Ref Sheet.
		await page.getByRole('link', { name: /Ref Sheet/ }).filter({ hasNotText: 'Mature' }).first().click();
		await expect(h1(page)).toHaveText('Ref Sheet');
		await expect(page).toHaveURL(/\/gallery\/ref-sheet\?sort=oldest$/);
		await expect(prevLink(page)).toHaveAccessibleName('Previous: Parent Piece SFW');
		await expect(nextLink(page)).toHaveAccessibleName('Next: Mature Ref Sheet');

		await page.keyboard.press('ArrowRight');
		await expect(h1(page)).toHaveText('Mature Ref Sheet');
		// The context rides along, so the walk stays in the oldest-first grid.
		await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet\?sort=oldest$/);
		await expect(nextLink(page)).toHaveCount(0);
	});

	test('a variant tile keeps the grid context, and pages from its parent', async ({ page }) => {
		await open(page, '/gallery?sort=oldest');
		await page.getByRole('link', { name: /Parent Piece SFW/ }).first().click();
		await expect(page).toHaveURL(/\/gallery\/parent-piece\?sort=oldest$/);
		await page.locator('a.variant-tile[href^="/gallery/variant-piece"]').click();
		await expect(page).toHaveURL(/\/gallery\/variant-piece\?sort=oldest$/);
		// Still the oldest-first grid, where the parent is the first card.
		await expect(nextLink(page)).toHaveAccessibleName('Next: Ref Sheet');
		await expect(prevLink(page)).toHaveCount(0);
	});

	test('a filtered grid of one piece has nothing to page to', async ({ page }) => {
		await open(page, '/gallery?tag=reference');
		await page.getByRole('link', { name: /Ref Sheet/ }).first().click();
		await expect(page).toHaveURL(/\/gallery\/ref-sheet\?tag=reference$/);
		await expect(h1(page)).toHaveText('Ref Sheet');
		await expect(pager(page)).toHaveCount(0);
	});

	test('preloads exactly the hero the next page renders, and only that one', async ({ page }) => {
		const requested: string[] = [];
		page.on('request', (r) => requested.push(new URL(r.url()).pathname));

		await open(page, '/gallery/ref-sheet');
		const preloads = page.locator('link[rel="preload"][as="image"]');
		await expect(preloads).toHaveCount(1);
		const preload = {
			href: await preloads.getAttribute('href'),
			srcset: await preloads.getAttribute('imagesrcset'),
			sizes: await preloads.getAttribute('imagesizes')
		};
		// The browser actually fetched it, ahead of any navigation.
		await expect.poll(() => requested).toContain(new URL(preload.href!, page.url()).pathname);

		await nextLink(page).click();
		await expect(h1(page)).toHaveText('Parent Piece SFW');
		const hero = page.locator('.image-preview img');
		expect({
			href: await hero.getAttribute('src'),
			srcset: await hero.getAttribute('srcset'),
			sizes: await hero.getAttribute('sizes')
		}).toEqual(preload);

		// The last piece has nothing ahead, so nothing is preloaded.
		await expect(preloads).toHaveCount(0);
	});
});

test.describe('VR looks paging', () => {
	// VR pages stay serial and small like the other VR specs: SwiftShader
	// starves parallel workers.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: { width: 900, height: 800 } });

	const looksPager = (page: Page) => page.getByRole('group', { name: 'Browse the media' });
	const prevBtn = (page: Page) => looksPager(page).getByRole('button', { name: 'Previous media' });
	const nextBtn = (page: Page) => looksPager(page).getByRole('button', { name: 'Next media' });
	const position = (page: Page) => looksPager(page).getByRole('status');
	const currentThumb = (page: Page) => page.locator('.media-strip .media-thumb[aria-current="true"]');

	test('arrow keys step through the looks in strip order, both ways', async ({ page }) => {
		// e2e-avatar: poster, then a shot, then a clip.
		await open(page, '/vr/e2e-avatar');
		await expect(position(page)).toHaveText('1 of 3');
		await expect(currentThumb(page)).toHaveAccessibleName('Poster');

		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('2 of 3');
		await expect(currentThumb(page)).toHaveAccessibleName('E2E VR Avatar — media 1');
		await expect(page.locator('.media-frame img')).toHaveAttribute('src', /vr-media-shot/);

		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('3 of 3');
		await expect(page.locator('.media-frame video')).toHaveAttribute('src', /vr-media-clip/);
		// Past the end: stays put.
		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('3 of 3');

		await page.keyboard.press('ArrowLeft');
		await expect(position(page)).toHaveText('2 of 3');
		await page.keyboard.press('ArrowLeft');
		await expect(position(page)).toHaveText('1 of 3');
		await expect(currentThumb(page)).toHaveAccessibleName('Poster');
	});

	test('the buttons step too, and are disabled at the ends', async ({ page }, testInfo) => {
		await open(page, '/vr/e2e-avatar');
		await expect(prevBtn(page)).toBeDisabled();
		await expect(nextBtn(page)).toBeEnabled();

		await nextBtn(page).click();
		await expect(position(page)).toHaveText('2 of 3');
		await expect(prevBtn(page)).toBeEnabled();
		await settledShot(page, testInfo.outputPath('vr-looks-pager-middle.png'));

		await nextBtn(page).click();
		await expect(position(page)).toHaveText('3 of 3');
		await expect(nextBtn(page)).toBeDisabled();
		// A disabled end doesn't drop focus to the page.
		await expect(nextBtn(page)).toBeFocused();
		// Activating it there (Playwright won't click a disabled control, a
		// keyboard user still can) does nothing.
		await page.keyboard.press('Enter');
		await expect(position(page)).toHaveText('3 of 3');

		await prevBtn(page).click();
		await expect(position(page)).toHaveText('2 of 3');
	});

	test('arrows do nothing while a text input has focus', async ({ page }) => {
		await open(page, '/vr/e2e-avatar');
		expect(await pressInTextInput(page, 'ArrowRight')).toBe(false);
		await expect(position(page)).toHaveText('1 of 3');

		await blurFocus(page);
		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('2 of 3');
	});

	test('a posterless avatar pages from the look it opens on', async ({ page }) => {
		// e2e-posterless: a clip, then a shot; it opens on the shot (the first image).
		await open(page, '/vr/e2e-posterless');
		await expect(position(page)).toHaveText('2 of 2');
		await expect(nextBtn(page)).toBeDisabled();

		await page.keyboard.press('ArrowLeft');
		await expect(position(page)).toHaveText('1 of 2');
		await expect(page.locator('.media-frame video')).toHaveAttribute('src', /vr-media-posterless-clip/);
		await expect(prevBtn(page)).toBeDisabled();
	});

	test('arrows stand down while the 3D stage is up, and page again after it closes', async ({ page }) => {
		// e2e-avatar's model is a stub that fails to parse, which would drop the
		// stage straight back to the poster. Holding the model download open
		// keeps the viewer active (loading) for as long as the test needs.
		await page.route('**/vr/e2e-avatar/model', () => new Promise<void>(() => {}));
		await open(page, '/vr/e2e-avatar');
		await expect(position(page)).toHaveText('1 of 3');

		await page.getByRole('button', { name: 'View in 3D' }).click();
		await expect(page.locator('.loading-panel')).toBeVisible();
		await expect(prevBtn(page)).toHaveAttribute('aria-disabled', 'true');
		await expect(nextBtn(page)).toHaveAttribute('aria-disabled', 'true');
		// Focus sits on Exit 3D, a plain button, so only the page's own guard
		// can keep this arrow from paging.
		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('1 of 3');
		// Playwright won't click an aria-disabled control; a pointer user still can.
		await nextBtn(page).click({ force: true });
		await expect(position(page)).toHaveText('1 of 3');

		await page.getByRole('button', { name: 'Exit 3D' }).click();
		await expect(page.locator('.loading-panel')).toHaveCount(0);
		await expect(nextBtn(page)).toHaveAttribute('aria-disabled', 'false');
		await blurFocus(page);
		await page.keyboard.press('ArrowRight');
		await expect(position(page)).toHaveText('2 of 3');
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	for (const locale of ['en', 'ja'] as const) {
		test(`each pager button's accessible name contains its visible label (${locale})`, async ({ page }, testInfo) => {
			// WCAG 2.5.3: a voice user says what they see.
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, url: testInfo.project.use.baseURL! }]);
			await open(page, '/vr/e2e-avatar');
			await expect(page.locator('html')).toHaveAttribute('lang', locale);
			const buttons = page.locator('.look-pager').getByRole('button');
			await expect(buttons).toHaveCount(2);
			for (const button of await buttons.all()) {
				const visible = (await button.innerText()).trim();
				expect(visible).not.toBe('');
				await expect(button).toHaveAccessibleName(new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
			}
		});
	}
});
