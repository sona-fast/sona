import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { waitForHydration } from './admin-login';
import { overlayColors } from './contrast';

// The sticker detail modal over the pack page, and the direct-visit page it
// falls back to. Runs on its own server: one published pack (e2e-pack) of six
// stickers, where 😊 tags stickers 1, 3, 4 and 5 and stickers 4 and 5 are NSFW
// (tests/e2e/fixtures/sticker-modal.sql). Read-only throughout.
//
// The fixture's image URLs 404 on the dev server, so every test serves a small
// SVG for them. The art then has edges to see in the kept screenshots; no
// assertion reads pixels.

const PACK = 'e2e-pack';
const PACK_URL = `/stickers/${PACK}`;
const SMILE = '😊';

const ART_COLORS = ['#f5a524', '#e5484d', '#3e63dd', '#ffffff', '#30a46c', '#8e4ec6'];

async function serveArt(page: Page) {
	await page.route('**/e2e/sticker-*', (route) => {
		const n = ['one', 'two', 'three', 'four', 'five', 'six'].findIndex((w) =>
			route.request().url().includes(`sticker-${w}`)
		);
		const fill = ART_COLORS[Math.max(0, n)];
		return route.fulfill({
			contentType: 'image/svg+xml',
			body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200" fill="${fill}" stroke="#fff" stroke-width="24"/><text x="256" y="300" font-size="140" text-anchor="middle" font-family="sans-serif" fill="#111">${n + 1}</text></svg>`
		});
	});
}

async function openPack(page: Page, query = '') {
	await serveArt(page);
	await page.goto(`${PACK_URL}${query}`);
	await waitForHydration(page);
}

const dialog = (page: Page) => page.locator('dialog.sticker-modal');
const counter = (page: Page) => dialog(page).getByRole('status');
const card = (page: Page, id: number) => page.locator(`.sticker-grid [data-sticker-id="${id}"]`);
const prevButton = (page: Page) => dialog(page).getByRole('button', { name: 'Previous sticker' });
const nextButton = (page: Page) => dialog(page).getByRole('button', { name: 'Next sticker' });

async function openSticker(page: Page, id: number) {
	// Click the card's emoji row, not its middle: on an NSFW card the middle is
	// the reveal overlay, whose first press reveals the art in place.
	await card(page, id).locator('.card-body').click();
	await expect(dialog(page)).toBeVisible();
	// The lift has finished (it runs when the browser doesn't report reduced
	// motion), so measurements and clicks see the card where it rests. The
	// fade is left to shot(): no assertion reads opacity.
	await expect.poll(() => dialog(page).evaluate((d) => getComputedStyle(d.querySelector('.stage')!).transform)).toBe('none');
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
	// With the modal open, wait out the open fade so the kept screenshot shows
	// the final frame. Near 1 rather than exactly 1, with a long timeout: on a
	// loaded machine the transition has been seen to sit at 0.97 for seconds.
	if (await dialog(page).isVisible()) {
		await expect
			.poll(
				() =>
					dialog(page).evaluate((d) =>
						Math.min(Number(getComputedStyle(d).opacity), Number(getComputedStyle(d, '::backdrop').opacity))
					),
				{ timeout: 15_000 }
			)
			.toBeGreaterThanOrEqual(0.99);
	}
	await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** The root's computed overflow: 'hidden' while the modal locks scrolling. */
const rootOverflow = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).overflow);

test('a card click opens the modal over the grid and the URL names the sticker', async ({ page }, testInfo) => {
	await openPack(page);
	await openSticker(page, 3);

	await expect(page).toHaveURL(`${PACK_URL}/3`);
	await expect(page.getByRole('dialog', { name: 'Sticker 3 of 6' })).toBeVisible();
	await expect(counter(page)).toHaveText('3 of 6');
	// Focus starts on Close.
	await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
	// The emoji chips are chips, without the site's link underline.
	await expect(dialog(page).locator('.emoji-chip').first()).toHaveCSS('text-decoration-line', 'none');
	// The pack page is still underneath: the grid wasn't swapped for the detail page.
	await expect(page.getByRole('heading', { level: 1, name: 'E2E Sticker Pack' })).toBeAttached();
	// And the page behind doesn't scroll.
	expect(await rootOverflow(page)).toBe('hidden');
	await shot(page, testInfo, 'desktop-open');
});

test('a modifier click leaves the card a plain link', async ({ page, context }) => {
	await openPack(page);
	const [tab] = await Promise.all([
		context.waitForEvent('page'),
		card(page, 2).click({ modifiers: ['ControlOrMeta'] })
	]);
	await tab.waitForURL(`**${PACK_URL}/2`);
	await expect(dialog(page)).toBeHidden();
	await expect(page).toHaveURL(PACK_URL);
});

const CLOSERS: { name: string; close: (page: Page) => Promise<void> }[] = [
	{ name: 'Escape', close: (page) => page.keyboard.press('Escape') },
	{ name: 'the Close button', close: (page) => dialog(page).getByRole('button', { name: 'Close' }).click() },
	// The top-left corner of the viewport is backdrop on a desktop window.
	{ name: 'a backdrop click', close: (page) => page.mouse.click(10, 10) },
	{ name: 'browser Back', close: async (page) => void (await page.goBack()) }
];

for (const { name, close } of CLOSERS) {
	test(`${name} closes the modal, restores the pack URL, and focuses the last sticker's card`, async ({ page }) => {
		await openPack(page);
		await openSticker(page, 1);
		// Page twice, so a close that went back one entry per step would show here.
		await nextButton(page).click();
		await nextButton(page).click();
		await expect(counter(page)).toHaveText('3 of 6');
		await expect(page).toHaveURL(`${PACK_URL}/3`);

		await close(page);

		await expect(dialog(page)).toBeHidden();
		await expect(page).toHaveURL(PACK_URL);
		await expect(card(page, 3)).toBeFocused();
		expect(await rootOverflow(page)).not.toBe('hidden');
	});
}

// Two presses land before the first close's history pop does. Each must not
// pop an entry of its own, or the second one leaves the pack page.
const DOUBLE_CLOSERS: { name: string; close: (page: Page) => Promise<void> }[] = [
	{ name: 'the Close button', close: (page) => dialog(page).getByRole('button', { name: 'Close' }).dblclick() },
	{ name: 'the backdrop', close: (page) => page.mouse.dblclick(10, 10) }
];

for (const { name, close } of DOUBLE_CLOSERS) {
	test(`a double-click on ${name} closes the modal once and stays on the pack page`, async ({ page }) => {
		await openPack(page);
		await openSticker(page, 2);
		await close(page);
		await expect(dialog(page)).toBeHidden();
		await expect(page).toHaveURL(PACK_URL);
		await expect(page.getByRole('heading', { level: 1, name: 'E2E Sticker Pack' })).toBeVisible();
	});
}

test('a right-click on the backdrop does not arm the next key press to close the modal', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);
	// A right-click sends pointerdown and pointerup to the backdrop but no
	// click, so its press is still on record when Enter clicks Next.
	await page.mouse.click(10, 10, { button: 'right' });
	await nextButton(page).focus();
	await page.keyboard.press('Enter');
	await expect(counter(page)).toHaveText('3 of 6');
	await expect(dialog(page)).toBeVisible();
	await expect(page).toHaveURL(`${PACK_URL}/3`);
});

test('a click inside the card does not close the modal', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);
	await dialog(page).locator('.artist-name').click();
	await expect(dialog(page)).toBeVisible();
	await expect(page).toHaveURL(`${PACK_URL}/2`);
});

test('a press dragged between the card and the backdrop does not close the modal, either way', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);

	// Down in the card, up on the backdrop: a text selection dragged out.
	const name = (await dialog(page).locator('.artist-name').boundingBox())!;
	await page.mouse.move(name.x + 4, name.y + name.height / 2);
	await page.mouse.down();
	await page.mouse.move(10, 10, { steps: 5 });
	await page.mouse.up();
	await expect(dialog(page)).toBeVisible();
	await expect(page).toHaveURL(`${PACK_URL}/2`);

	// Down on the backdrop, up in the card. The browser sends that click to the
	// dialog, the nearest element both ends share, so it looks like a backdrop
	// click unless the release is checked too.
	await page.mouse.move(10, 10);
	await page.mouse.down();
	await page.mouse.move(name.x + 4, name.y + name.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(dialog(page)).toBeVisible();
	await expect(page).toHaveURL(`${PACK_URL}/2`);
});

test('a dialog the browser closes on its own still unlocks the page and returns focus', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 1);
	await nextButton(page).click();
	await nextButton(page).click();
	await expect(counter(page)).toHaveText('3 of 6');

	// What Chrome's close watcher does after repeated Escape presses: the dialog
	// closes without a cancel event the page could route through history.
	await dialog(page).evaluate((d: HTMLDialogElement) => d.close());

	await expect(page).toHaveURL(PACK_URL);
	await expect(dialog(page)).toBeHidden();
	await expect(card(page, 3)).toBeFocused();
	expect(await rootOverflow(page)).not.toBe('hidden');
});

test('Tab walks the card in order: Close, the emoji chips, the pack link, then Previous and Next', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);
	const close = dialog(page).getByRole('button', { name: 'Close' });
	await expect(close).toBeFocused();

	await page.keyboard.press('Tab');
	await expect(dialog(page).locator('.emoji-chip').first()).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog(page).locator('.pack-link')).toBeFocused();

	// Past the artist's links and the download controls, whatever their number.
	for (let i = 0; i < 12; i++) {
		if (await prevButton(page).evaluate((el) => el === document.activeElement)) break;
		await page.keyboard.press('Tab');
	}
	await expect(prevButton(page)).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(nextButton(page)).toBeFocused();

	await page.keyboard.press('Shift+Tab');
	await expect(prevButton(page)).toBeFocused();
	await dialog(page).locator('.emoji-chip').first().focus();
	await page.keyboard.press('Shift+Tab');
	await expect(close).toBeFocused();
});

test('after a mouse click moves focus out of the card, the arrows still page', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 1);
	await nextButton(page).click();
	await expect(counter(page)).toHaveText('2 of 6');
	// A mouse click doesn't focus a button on macOS, so focus can sit on
	// <body> with the modal open.
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('3 of 6');
	await page.keyboard.press('ArrowLeft');
	await expect(counter(page)).toHaveText('2 of 6');
});

test('in right-to-left text the arrows follow the drawing: Right goes back, Left goes on', async ({ page }) => {
	await openPack(page);
	await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
	await openSticker(page, 3);
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('2 of 6');
	await page.keyboard.press('ArrowLeft');
	await expect(counter(page)).toHaveText('3 of 6');
});

test('focus returns to a card paged past the visible rows, scrolled into view', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 640 });
	await openPack(page);
	await openSticker(page, 1);
	for (let i = 0; i < 5; i++) await nextButton(page).click();
	await expect(counter(page)).toHaveText('6 of 6');
	await page.keyboard.press('Escape');

	await expect(card(page, 6)).toBeFocused();
	await expect(card(page, 6)).toBeInViewport();
});

test('paging walks the filtered grid, stops at both ends without wrapping, and keeps focus on the pressed button', async ({
	page
}, testInfo) => {
	await openPack(page, `?emoji=${encodeURIComponent(SMILE)}`);
	await expect(page.locator('.sticker-grid .card')).toHaveCount(4);
	await openSticker(page, 1);

	await expect(counter(page)).toHaveText('1 of 4');
	// The filter emoji sits beside the counter, labelled for a screen reader.
	await expect(dialog(page).locator('.filter-emoji')).toHaveText(`Filtered by ${SMILE}`);
	await shot(page, testInfo, 'desktop-first-filtered');

	// First sticker: Previous is unavailable, stays focusable, and does nothing.
	// Pressed from the keyboard, since keeping focus on it is for keyboard
	// users (a mouse click doesn't focus a button on macOS).
	await expect(prevButton(page)).toHaveAttribute('aria-disabled', 'true');
	await prevButton(page).focus();
	await page.keyboard.press('Enter');
	await expect(prevButton(page)).toBeFocused();
	await expect(counter(page)).toHaveText('1 of 4');
	await page.keyboard.press('ArrowLeft');
	await expect(counter(page)).toHaveText('1 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/1`);

	// Arrows and buttons step through 1, 3, 4, 5: the filtered order, not 1-6.
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('2 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/3`);
	await expect(page.getByRole('dialog', { name: 'Sticker 2 of 4' })).toBeVisible();
	await nextButton(page).focus();
	await page.keyboard.press('Enter');
	await expect(counter(page)).toHaveText('3 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/4`);
	await expect(nextButton(page)).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('4 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/5`);

	// Last sticker: Next is unavailable and paging doesn't wrap to the first.
	await expect(nextButton(page)).toHaveAttribute('aria-disabled', 'true');
	await expect(prevButton(page)).not.toHaveAttribute('aria-disabled', 'true');
	await expect(nextButton(page)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(nextButton(page)).toBeFocused();
	// force: Playwright won't click an aria-disabled control; a visitor can.
	await nextButton(page).click({ force: true });
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('4 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/5`);

	await page.keyboard.press('ArrowLeft');
	await expect(counter(page)).toHaveText('3 of 4');

	// Closing goes back to the filtered grid.
	await page.keyboard.press('Escape');
	await expect(page).toHaveURL(`${PACK_URL}?emoji=${encodeURIComponent(SMILE)}`);
	await expect(card(page, 4)).toBeFocused();
});

test('arrows stand down in the download menu, in a text field, and with a modifier held', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);

	// The format caret, and the open format list.
	const caret = dialog(page).getByRole('button', { name: 'Choose download format' });
	await caret.focus();
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('2 of 6');
	await caret.click();
	const firstFormat = dialog(page).locator('.dl-list a').first();
	await expect(firstFormat).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(counter(page)).toHaveText('2 of 6');

	// Escape with the list open closes the list only.
	await page.keyboard.press('Escape');
	await expect(dialog(page).locator('.dl-list')).toBeHidden();
	await expect(dialog(page)).toBeVisible();
	await expect(caret).toBeFocused();

	// Shift+Arrow extends a selection; it isn't a paging key.
	await dialog(page).getByRole('button', { name: 'Close' }).focus();
	await page.keyboard.press('Shift+ArrowRight');
	await expect(counter(page)).toHaveText('2 of 6');

	// The card has no text field today; one added later must keep its arrows.
	await dialog(page)
		.locator('.detail-body')
		.evaluate((body) => {
			const input = document.createElement('input');
			input.setAttribute('aria-label', 'probe');
			input.value = 'abc';
			body.prepend(input);
		});
	// One direction only: Left then Right would page out and back and hide a
	// guard that let arrows through.
	await dialog(page).getByRole('textbox', { name: 'probe' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('2 of 6');

	// Back on a button, a bare arrow pages.
	await dialog(page).getByRole('button', { name: 'Close' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('3 of 6');
});

test('a held arrow key moves one sticker, not one per auto-repeat', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 1);
	// Playwright marks every keydown after the first as repeat until keyup.
	await page.keyboard.down('ArrowRight');
	await page.keyboard.down('ArrowRight');
	await page.keyboard.down('ArrowRight');
	await page.keyboard.down('ArrowRight');
	await page.keyboard.up('ArrowRight');
	await expect(counter(page)).toHaveText('2 of 6');
	await expect(page).toHaveURL(`${PACK_URL}/2`);
});

test('arrows do nothing on the pack page while the modal is closed', async ({ page }) => {
	await openPack(page);
	const unmoved = async () => {
		await expect(page).toHaveURL(PACK_URL);
		await expect(dialog(page)).toBeHidden();
	};

	// Focus on a card, then on <body>.
	await card(page, 2).focus();
	await page.keyboard.press('ArrowRight');
	await unmoved();
	await page.keyboard.press('ArrowLeft');
	await unmoved();
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press('ArrowRight');
	await unmoved();

	// And after a close, with focus back on the card.
	await openSticker(page, 3);
	await page.keyboard.press('Escape');
	await unmoved();
	await expect(card(page, 3)).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await unmoved();
});

test('the open sticker warms the next sticker\'s art, and not the one after', async ({ page }) => {
	// Full-size art only: the grid shows the -thumb images. The pack header's
	// mosaic already loads stickers 1 to 4, so sticker 4 is opened: its next
	// neighbour, 5, is fetched only if the modal warms it, and 6 must not be.
	const requested = new Set<string>();
	page.on('request', (r) => {
		const name = /\/e2e\/(sticker-[a-z]+)\.webp/.exec(r.url())?.[1];
		if (name) requested.add(name);
	});
	await openPack(page);
	await openSticker(page, 4);
	await expect.poll(() => requested.has('sticker-five')).toBe(true);
	// Both neighbours are warmed in the same pass, so 6 would be in by now.
	expect(requested.has('sticker-six')).toBe(false);
});

test('every NSFW sticker starts blurred: a reveal does not carry over to the next one', async ({ page }, testInfo) => {
	await openPack(page);
	await openSticker(page, 4);
	const reveal = dialog(page).getByRole('button', { name: 'NSFW Show anyway' });
	await expect(reveal).toBeVisible();
	await expect(dialog(page).locator('.sticker-display > .media')).toHaveClass(/blurred/);
	await shot(page, testInfo, 'desktop-nsfw');

	await reveal.click();
	await expect(reveal).toBeHidden();
	await expect(dialog(page).locator('.sticker-display > .media')).not.toHaveClass(/blurred/);
	// The overlay unmounted under the focus; focus stays in the dialog, so the
	// arrows still page.
	await page.keyboard.press('ArrowRight');
	await expect(counter(page)).toHaveText('5 of 6');
	// Read once, not polled: the new sticker is fully blurred on the frame it
	// appears, rather than animating its blur in over the sharp art.
	expect(
		await dialog(page)
			.locator('.sticker-display > .media')
			.evaluate((el) => getComputedStyle(el).filter)
	).toBe('blur(24px)');
	await expect(dialog(page).getByRole('button', { name: 'NSFW Show anyway' })).toBeVisible();
	await expect(dialog(page).locator('.sticker-display > .media')).toHaveClass(/blurred/);

	// And back to the one revealed before: blurred again too.
	await prevButton(page).click();
	await expect(counter(page)).toHaveText('4 of 6');
	await expect(dialog(page).getByRole('button', { name: 'NSFW Show anyway' })).toBeVisible();
});

test('a reveal from the keyboard leaves focus on the art, so the next Tab reaches the emoji chips', async ({
	page
}, testInfo) => {
	await openPack(page);
	await openSticker(page, 4);
	await page.keyboard.press('Tab');
	const reveal = dialog(page).getByRole('button', { name: 'NSFW Show anyway' });
	await expect(reveal).toBeFocused();
	// Kept so the overlay's ring, drawn inside the clipped art area, can be checked.
	await shot(page, testInfo, 'nsfw-overlay-focus');
	await page.keyboard.press('Enter');
	await expect(reveal).toBeHidden();
	// The art area holds focus, with a visible ring.
	await expect(dialog(page).locator('.sticker-display')).toBeFocused();
	expect(await dialog(page).locator('.sticker-display').evaluate((el) => el.matches(':focus-visible'))).toBe(true);
	await shot(page, testInfo, 'revealed-art-focus');

	await page.keyboard.press('Tab');
	await expect(dialog(page).locator('.emoji-chip').first()).toBeFocused();
});

test('a revealed NSFW sticker is blurred again when the modal is reopened on it', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 4);
	await dialog(page).getByRole('button', { name: 'NSFW Show anyway' }).click();
	await expect(dialog(page).locator('.sticker-display > .media')).not.toHaveClass(/blurred/);
	await page.keyboard.press('Escape');
	await expect(dialog(page)).toBeHidden();
	await expect(page).toHaveURL(PACK_URL);

	await openSticker(page, 4);
	await expect(dialog(page).getByRole('button', { name: 'NSFW Show anyway' })).toBeVisible();
	await expect(dialog(page).locator('.sticker-display > .media')).toHaveClass(/blurred/);
});

test('the NSFW overlay text reads at 4.5:1 over white art, in the modal and on a grid card', async ({ page }) => {
	await openPack(page);
	const grid = await overlayColors(page, `.sticker-grid [data-sticker-id="4"] .nsfw-overlay`);
	await openSticker(page, 4);
	const modal = await overlayColors(page, 'dialog.sticker-modal .nsfw-overlay');

	for (const [where, { scrim, texts }] of Object.entries({ grid, modal })) {
		expect(texts.map((t) => t.text), `${where}: both overlay lines`).toEqual(['NSFW', 'Show anyway']);
		for (const { text, rgb } of texts) {
			expect(contrast(rgb, scrim), `${where}: "${text}" on the scrim over white`).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test('the download button counts once with a keepalive beacon, in the modal and on the direct page', async ({ page }) => {
	await page.addInitScript(() => {
		const calls: { url: string; keepalive: boolean }[] = [];
		(window as unknown as { __beacons: typeof calls }).__beacons = calls;
		const original = window.fetch;
		window.fetch = (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.includes('/api/metrics/download')) calls.push({ url, keepalive: init?.keepalive === true });
			return original(input, init);
		};
	});
	await page.route('**/api/metrics/download', (route) => route.fulfill({ status: 204 }));
	const beacons = () => page.evaluate(() => (window as unknown as { __beacons: { keepalive: boolean }[] }).__beacons);

	await openPack(page);
	await openSticker(page, 2);
	await Promise.all([page.waitForEvent('download'), dialog(page).locator('.dl-primary').click()]);
	await expect.poll(beacons).toEqual([expect.objectContaining({ keepalive: true })]);

	// A new document, so a fresh list.
	await page.goto(`${PACK_URL}/2`);
	await waitForHydration(page);
	await Promise.all([page.waitForEvent('download'), page.locator('.dl-primary').click()]);
	await expect.poll(beacons).toEqual([expect.objectContaining({ keepalive: true })]);
});

test('a failing download beacon does not stop the download', async ({ page }) => {
	let posts = 0;
	await page.route('**/api/metrics/download', (route) => {
		posts++;
		return route.fulfill({ status: 500 });
	});
	await openPack(page);
	await openSticker(page, 2);
	// A download is a navigation the page's routes don't see, so the browser's
	// download event is the evidence it went out.
	const [download] = await Promise.all([page.waitForEvent('download'), dialog(page).locator('.dl-primary').click()]);
	expect(new URL(download.url()).pathname).toBe(`${PACK_URL}/2/download`);
	await expect.poll(() => posts).toBe(1);
	await expect(dialog(page)).toBeVisible();
});

test('a history entry for a sticker the filter now hides pages through the whole pack', async ({ page }) => {
	await openPack(page);
	await openSticker(page, 2);
	await page.keyboard.press('Escape');
	await expect(page).toHaveURL(PACK_URL);
	// Filter in place: the filter replaces this history entry, so the modal's
	// entry for sticker 2 is still ahead of it.
	await page.locator('.emoji-rail .emoji-chip', { hasText: SMILE }).click();
	await expect(page.locator('.sticker-grid .card')).toHaveCount(4);

	await page.goForward();
	await expect(dialog(page)).toBeVisible();
	await expect(counter(page)).toHaveText('2 of 6');
	await expect(dialog(page).locator('.filter-emoji')).toHaveCount(0);
	await nextButton(page).click();
	await expect(counter(page)).toHaveText('3 of 6');
	await expect(page).toHaveURL(`${PACK_URL}/3`);
	// Step back to sticker 2, which has no card in the filtered grid: closing
	// on it still puts focus in the grid, on its first card.
	await prevButton(page).click();
	await expect(counter(page)).toHaveText('2 of 6');
	await page.keyboard.press('Escape');
	await expect(dialog(page)).toBeHidden();
	await expect(card(page, 1)).toBeFocused();
	await page.goForward();
	await expect(counter(page)).toHaveText('2 of 6');
	await nextButton(page).click();
	await expect(counter(page)).toHaveText('3 of 6');

	// The fallback ends with the modal: opened again from the filtered grid,
	// paging walks the filter.
	await page.keyboard.press('Escape');
	await expect(dialog(page)).toBeHidden();
	await expect(page.locator('.sticker-grid .card')).toHaveCount(4);
	await openSticker(page, 3);
	await expect(counter(page)).toHaveText('2 of 4');
	await expect(dialog(page).locator('.filter-emoji')).toHaveText(`Filtered by ${SMILE}`);
	await nextButton(page).click();
	await expect(counter(page)).toHaveText('3 of 4');
	await expect(page).toHaveURL(`${PACK_URL}/4`);
});

test('the pack link inside the modal closes it', async ({ page }) => {
	await openPack(page, `?emoji=${encodeURIComponent(SMILE)}`);
	await openSticker(page, 3);
	await dialog(page).locator('.pack-link').click();
	await expect(page).toHaveURL(PACK_URL);
	await expect(dialog(page)).toBeHidden();
	await expect(page.locator('.sticker-grid .card')).toHaveCount(6);
	expect(await rootOverflow(page)).not.toBe('hidden');
});

test('an emoji link inside the modal leaves the pack and the next page still scrolls', async ({ page }) => {
	// Short enough that the sticker index overflows the window.
	await page.setViewportSize({ width: 1280, height: 400 });
	await openPack(page);
	await openSticker(page, 3);
	await dialog(page).locator('.emoji-chip').first().click();

	await expect(page).toHaveURL(/\/stickers\?emoji=/);
	await expect(dialog(page)).toHaveCount(0);
	expect(await rootOverflow(page)).not.toBe('hidden');
	const before = await page.evaluate(() => window.scrollY);
	await page.evaluate(() => window.scrollBy(0, 400));
	await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
});

test('a direct visit renders the full page with Previous and Next as working links', async ({ page }, testInfo) => {
	await serveArt(page);
	await page.goto(`${PACK_URL}/3`);

	await expect(dialog(page)).toHaveCount(0);
	await expect(page.locator('.back-link')).toHaveAttribute('href', PACK_URL);
	await expect(page.locator('.counter')).toHaveText('3 of 6');
	await expect(page.getByRole('button', { name: 'Close' })).toHaveCount(0);
	// The art is the page's main image: fetched at once, ahead of the rest.
	const art = page.locator('.sticker-display img');
	await expect(art).toHaveAttribute('loading', 'eager');
	await expect(art).toHaveAttribute('fetchpriority', 'high');
	const prev = page.getByRole('link', { name: 'Previous sticker' });
	const next = page.getByRole('link', { name: 'Next sticker' });
	await expect(prev).toHaveAttribute('href', `${PACK_URL}/2`);
	await expect(next).toHaveAttribute('href', `${PACK_URL}/4`);
	await shot(page, testInfo, 'direct-visit');

	await next.click();
	await expect(page).toHaveURL(`${PACK_URL}/4`);
	await expect(page.locator('.counter')).toHaveText('4 of 6');
	// Ordinary links push history: Back returns to sticker 3.
	await page.goBack();
	await expect(page.locator('.counter')).toHaveText('3 of 6');

	// The ends: no link to follow, shown as unavailable.
	await page.goto(`${PACK_URL}/1`);
	const firstPrev = page.getByRole('link', { name: 'Previous sticker' });
	await expect(firstPrev).toHaveAttribute('aria-disabled', 'true');
	await expect(firstPrev).not.toHaveAttribute('href');
	await page.goto(`${PACK_URL}/6`);
	const lastNext = page.getByRole('link', { name: 'Next sticker' });
	await expect(lastNext).toHaveAttribute('aria-disabled', 'true');
	await expect(lastNext).not.toHaveAttribute('href');
});

test('a direct visit pages without JavaScript', async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto(`${PACK_URL}/2`);
	await page.getByRole('link', { name: 'Next sticker' }).click();
	await expect(page).toHaveURL(`${PACK_URL}/3`);
	await expect(page.locator('.counter')).toHaveText('3 of 6');
	await context.close();
});

test('on a 390px phone the modal is a full-screen sheet with Previous and Next in a bottom bar', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openPack(page);
	await openSticker(page, 3);

	const viewport = page.viewportSize()!;
	// Polled: the sheet rises into place over 200ms unless motion is reduced.
	await expect
		.poll(async () => {
			const box = await dialog(page).locator('.detail-card').boundingBox();
			return box && { x: box.x, y: box.y, width: box.width };
		})
		.toEqual({ x: 0, y: 0, width: viewport.width });

	// The bar's buttons carry visible text, sit at the bottom of the screen,
	// and are at least 48px tall.
	const prev = dialog(page).getByRole('button', { name: 'Previous', exact: true });
	const next = dialog(page).getByRole('button', { name: 'Next', exact: true });
	await expect(prev).toBeVisible();
	await expect(next).toBeVisible();
	const nextBox = (await next.boundingBox())!;
	expect(nextBox.height).toBeGreaterThanOrEqual(48);
	expect(nextBox.y + nextBox.height).toBeGreaterThan(viewport.height - 80);
	expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(viewport.height);
	// The sheet's content starts 16px from the screen edge, as in the mocks.
	expect((await counter(page).boundingBox())!.x).toBe(16);
	expect((await dialog(page).locator('.emoji-chip').first().boundingBox())!.x).toBe(16);
	await shot(page, testInfo, 'phone-sheet');

	await next.click();
	await expect(counter(page)).toHaveText('4 of 6');
	expect(
		await dialog(page)
			.locator('.sticker-display > .media')
			.evaluate((el) => getComputedStyle(el).filter)
	).toBe('blur(24px)');
	await shot(page, testInfo, 'phone-sheet-nsfw');
	await prev.click();
	await expect(counter(page)).toHaveText('3 of 6');
});

for (const size of [
	{ width: 320, height: 640 },
	{ width: 390, height: 844 },
	{ width: 640, height: 400 }
]) {
	test(`at ${size.width}x${size.height} the sheet fits the screen: Close at the top, the bar pinned at the bottom`, async ({
		page
	}) => {
		await page.setViewportSize(size);
		await openPack(page);
		await openSticker(page, 3);

		// Only the card scrolls; the sheet itself is exactly the viewport.
		const bar = dialog(page).locator('.pager');
		await expect(bar).toBeInViewport({ ratio: 1 });
		const barBox = (await bar.boundingBox())!;
		expect(barBox.y + barBox.height).toBeLessThanOrEqual(size.height);
		const closeBox = (await dialog(page).getByRole('button', { name: 'Close' }).boundingBox())!;
		expect(closeBox.y).toBeGreaterThanOrEqual(0);
		expect(await dialog(page).evaluate((d) => d.scrollHeight <= d.clientHeight)).toBe(true);
	});
}

test('just above the phone breakpoint, Previous and Next sit beside the card and inside the window', async ({ page }) => {
	await page.setViewportSize({ width: 769, height: 900 });
	await openPack(page);
	await openSticker(page, 3);
	const cardBox = (await dialog(page).locator('.detail-card').boundingBox())!;
	const prevBox = (await prevButton(page).boundingBox())!;
	const nextBox = (await nextButton(page).boundingBox())!;
	await expect(prevButton(page)).toBeInViewport({ ratio: 1 });
	await expect(nextButton(page)).toBeInViewport({ ratio: 1 });
	// About 21px from the card on each side, as the mocks draw it.
	expect(cardBox.x - (prevBox.x + prevBox.width)).toBeCloseTo(21, 0);
	expect(nextBox.x - (cardBox.x + cardBox.width)).toBeCloseTo(21, 0);
});

// WCAG relative luminance contrast between two rgb() strings.
function contrast(a: string, b: string): number {
	const lum = (rgb: string) => {
		const [r, g, bl] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((c) => {
			const s = Number(c) / 255;
			return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** The two colours a checkerboard element actually paints: its background
 * colour and the colour of the gradient squares over it. */
async function checkerColors(page: Page, selector: string) {
	return page.locator(selector).first().evaluate((el) => {
		const style = getComputedStyle(el);
		return { base: style.backgroundColor, square: style.backgroundImage.match(/rgba?\([^)]*\)/)?.[0] ?? '' };
	});
}

test('in the light theme, white art stands off both checkerboard squares wherever sticker art sits', async ({
	page
}, testInfo) => {
	await page.context().addCookies([{ name: 'sona-mode', value: 'light', domain: 'localhost', path: '/' }]);
	await openPack(page);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

	const grid = await checkerColors(page, '.sticker-grid .tile');
	// The pack header's cover mosaic; the box around it paints the board.
	const header = await checkerColors(page, '.pack-header .header-cover');
	await openSticker(page, 4);
	const modal = await checkerColors(page, 'dialog.sticker-modal .sticker-display');
	await shot(page, testInfo, 'light-modal');
	await page.goto('/stickers');
	const index = await checkerColors(page, '.pack-cover');

	for (const [where, { base, square }] of Object.entries({ grid, header, modal, index })) {
		expect(square, `${where}: the gradient square colour resolved`).not.toBe('');
		expect(contrast('rgb(255, 255, 255)', base), `${where}: white on the base square`).toBeGreaterThanOrEqual(1.4);
		expect(contrast('rgb(255, 255, 255)', square), `${where}: white on the other square`).toBeGreaterThanOrEqual(1.4);
	}
});

test.describe('with classic scrollbars', () => {
	// Headless Chromium hides scrollbars by default (--hide-scrollbars), which
	// is what macOS overlay scrollbars look like to layout. Windows and Linux
	// draw classic ones that take width, so these tests launch their own
	// browser without the flag. (launchOptions can't be set per describe.)
	let classic: Browser;
	test.beforeAll(async ({ playwright }) => {
		classic = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	});
	test.afterAll(async () => {
		await classic?.close();
	});
	// Each test's context closes even when an assertion fails part way.
	let context: BrowserContext | undefined;
	test.afterEach(async () => {
		await context?.close();
		context = undefined;
	});

	async function classicPage(height: number, testInfo: TestInfo) {
		context = await classic.newContext({
			baseURL: testInfo.project.use.baseURL,
			// Wider than the 1280px container, so the page content is centred
			// and moves when the width it is centred in changes.
			viewport: { width: 1600, height }
		});
		return context.newPage();
	}

	// Where the page's content sits across: the centred pack header and grid,
	// and the header's right-hand controls.
	const lefts = (page: Page) =>
		page.evaluate(() =>
			['.pack-header', '.sticker-grid', 'header nav'].map((s) => {
				const r = document.querySelector(s)!.getBoundingClientRect();
				return [r.left, r.right];
			})
		);
	const rootStyle = (page: Page) =>
		page.evaluate(() => ({
			overflow: document.documentElement.style.overflow,
			scrollbarGutter: document.documentElement.style.scrollbarGutter
		}));
	const scrollbarWidth = (page: Page) => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);

	test('opening and closing the modal does not shift the page sideways', async ({}, testInfo) => {
		// Short enough that the pack page scrolls, so it has a scrollbar to lose.
		const page = await classicPage(400, testInfo);
		await openPack(page);
		expect(await scrollbarWidth(page), 'the page shows a classic scrollbar, or this test proves nothing').toBeGreaterThan(0);
		const before = await lefts(page);
		const styleBefore = await rootStyle(page);

		await openSticker(page, 3);
		expect(await rootOverflow(page)).toBe('hidden');
		expect(await lefts(page)).toEqual(before);
		await shot(page, testInfo, 'classic-scrollbar-open');

		await page.keyboard.press('Escape');
		await expect(dialog(page)).toBeHidden();
		// The root's inline style is exactly what it was before the modal.
		expect(await rootStyle(page)).toEqual(styleBefore);
		expect(await lefts(page)).toEqual(before);
	});

	test('on a page too short to scroll, opening the modal adds no gutter', async ({}, testInfo) => {
		const page = await classicPage(4000, testInfo);
		await openPack(page);
		expect(await scrollbarWidth(page)).toBe(0);
		const before = await lefts(page);

		await openSticker(page, 3);
		expect(await lefts(page)).toEqual(before);
		expect((await rootStyle(page)).scrollbarGutter).toBe('');
	});

	test('an emoji link inside the modal leaves the root style as it found it on the next page', async ({}, testInfo) => {
		// Short enough that the pack page scrolls, so the modal adds a gutter.
		const page = await classicPage(400, testInfo);
		await openPack(page);
		const styleBefore = await rootStyle(page);

		await openSticker(page, 3);
		expect(await rootOverflow(page)).toBe('hidden');
		// The lock did set a gutter, so the restore below has something to undo.
		expect((await rootStyle(page)).scrollbarGutter).toBe('stable');
		await dialog(page).locator('.emoji-chip').first().click();

		await expect(page).toHaveURL(/\/stickers\?emoji=/);
		await expect(dialog(page)).toHaveCount(0);
		expect(await rootStyle(page)).toEqual(styleBefore);
	});
});
