import { test, expect, type Page } from '@playwright/test';
import { waitForHydration } from './admin-login';
import { failOnPageErrors } from './page-errors';
import { settledShot } from './settled-shot';

// SONA-179: a piece opened from a collection pages through that collection,
// in the collection page's order, by the visible controls and by Left/Right
// arrows, and preloads the next piece in that order.
//
// Runs on its own read-only server (fixtures/collection-paging.sql on the
// shared seed). "E2E Collection" lists, newest first: Mature Ref Sheet (NSFW),
// Parent Piece SFW, Collection Piece. The gallery has Ref Sheet between the
// first two, so a walk that drifts back to the gallery order shows at once.

failOnPageErrors();

const h1 = (page: Page) => page.locator('.image-meta h1');
// The pager is named for what it walks: "Browse E2E Collection" in the
// collection, "Browse the gallery" elsewhere. Each case checks which.
const pager = (page: Page) => page.getByRole('navigation', { name: /^Browse / });
const position = (page: Page) => page.locator('.pager .pager-position');
const prevLink = (page: Page) => pager(page).getByRole('link', { name: /^Previous:/ });
const nextLink = (page: Page) => pager(page).getByRole('link', { name: /^Next:/ });
const inCollection = '?collection=e2e-collection';

/** Opens `path` fresh and waits for hydration, so the arrow-key listener and
 *  the client router are attached before the first keypress. Reduced motion
 *  for the same reason as detail-paging.spec.ts: settledShot needs it. */
async function open(page: Page, path: string) {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(path);
	await waitForHydration(page);
}

test('a piece opened from the collection pages through it with the buttons, and stops at its ends', async ({
	page
}, testInfo) => {
	await open(page, '/collections/e2e-collection');
	const cards = page.locator('.grid a.card');
	await expect(cards).toHaveCount(3);
	for (const href of await cards.evaluateAll((els) => els.map((el) => el.getAttribute('href')))) {
		expect(href).toMatch(/\?collection=e2e-collection$/);
	}

	// The newest piece is the first card; it is NSFW, so its overlay button
	// covers the image. Click the title instead.
	await cards.first().locator('.card-title').click();
	await expect(h1(page)).toHaveText('Mature Ref Sheet');
	await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet\?collection=e2e-collection$/);
	// First in the collection: no previous. Next skips Ref Sheet, which is in
	// the gallery but not in the collection.
	await expect(prevLink(page)).toHaveCount(0);
	await expect(nextLink(page)).toHaveAccessibleName('Next: Parent Piece SFW');
	await expect(pager(page)).toHaveAccessibleName('Browse E2E Collection');
	await expect(position(page)).toHaveText('1 of 3 in E2E Collection');

	await nextLink(page).click();
	await expect(h1(page)).toHaveText('Parent Piece SFW');
	await expect(page).toHaveURL(/\/gallery\/parent-piece\?collection=e2e-collection$/);
	await expect(prevLink(page)).toHaveAccessibleName('Previous: Mature Ref Sheet');
	await expect(nextLink(page)).toHaveAccessibleName('Next: Collection Piece');
	await expect(position(page)).toHaveText('2 of 3 in E2E Collection');
	await settledShot(page, testInfo.outputPath('collection-pager-middle.png'));

	await nextLink(page).click();
	await expect(h1(page)).toHaveText('Collection Piece');
	// Last in the collection: no next.
	await expect(nextLink(page)).toHaveCount(0);
	await expect(prevLink(page)).toHaveAccessibleName('Previous: Parent Piece SFW');
	// The draft, newer than this piece, is not counted.
	await expect(position(page)).toHaveText('3 of 3 in E2E Collection');
	await settledShot(page, testInfo.outputPath('collection-pager-last.png'));

	await prevLink(page).click();
	await expect(h1(page)).toHaveText('Parent Piece SFW');
	await prevLink(page).click();
	await expect(h1(page)).toHaveText('Mature Ref Sheet');
	await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet\?collection=e2e-collection$/);
});

test('arrow keys page through the collection both ways, and do nothing past its ends', async ({ page }) => {
	await open(page, `/gallery/mature-ref-sheet${inCollection}`);
	await page.keyboard.press('ArrowLeft');
	await expect(h1(page)).toHaveText('Mature Ref Sheet');

	await page.keyboard.press('ArrowRight');
	await expect(page).toHaveURL(/\/gallery\/parent-piece\?collection=e2e-collection$/);
	await expect(h1(page)).toHaveText('Parent Piece SFW');

	await page.keyboard.press('ArrowRight');
	await expect(page).toHaveURL(/\/gallery\/collection-piece\?collection=e2e-collection$/);
	await expect(h1(page)).toHaveText('Collection Piece');

	// Past the end: stays put.
	await page.keyboard.press('ArrowRight');
	await expect(h1(page)).toHaveText('Collection Piece');
	await expect(page).toHaveURL(/\/gallery\/collection-piece\?collection=e2e-collection$/);

	await page.keyboard.press('ArrowLeft');
	await expect(h1(page)).toHaveText('Parent Piece SFW');
	await page.keyboard.press('ArrowLeft');
	await expect(h1(page)).toHaveText('Mature Ref Sheet');
});

test('arrows do nothing while a text input has focus', async ({ page }) => {
	await open(page, `/gallery/mature-ref-sheet${inCollection}`);
	// The detail page has no text field of its own; add one, and record
	// whether anything consumed the key (the pager calls preventDefault when
	// it pages). Read synchronously after dispatch, so there's no wait window.
	await page.evaluate(() => {
		const input = document.createElement('input');
		input.type = 'text';
		input.id = 'e2e-paging-input';
		document.querySelector('main')!.prepend(input);
		window.addEventListener('keydown', (e) => {
			(window as unknown as { __consumed: boolean }).__consumed = e.defaultPrevented;
		});
	});
	await page.locator('#e2e-paging-input').focus();
	await page.keyboard.press('ArrowRight');
	expect(await page.evaluate(() => (window as unknown as { __consumed: boolean }).__consumed)).toBe(false);
	await expect(page).toHaveURL(/\/gallery\/mature-ref-sheet\?collection=e2e-collection$/);

	// Control: with focus off the field the same key pages one step.
	await page.evaluate(() => document.getElementById('e2e-paging-input')!.remove());
	await page.keyboard.press('ArrowRight');
	await expect(h1(page)).toHaveText('Parent Piece SFW');
});

test("preloads exactly the hero of the collection's next piece, and only that one", async ({ page }) => {
	const requested: string[] = [];
	page.on('request', (r) => requested.push(new URL(r.url()).pathname));

	// In the gallery, Mature Ref Sheet's next is Ref Sheet; in the collection
	// it's Parent Piece SFW. The preload must follow the collection.
	await open(page, `/gallery/mature-ref-sheet${inCollection}`);
	const preloads = page.locator('link[rel="preload"][as="image"]');
	await expect(preloads).toHaveCount(1);
	const preload = {
		href: await preloads.getAttribute('href'),
		srcset: await preloads.getAttribute('imagesrcset'),
		sizes: await preloads.getAttribute('imagesizes')
	};
	expect(preload.href).toContain('parentpiece');
	await expect.poll(() => requested).toContain(new URL(preload.href!, page.url()).pathname);

	await nextLink(page).click();
	await expect(h1(page)).toHaveText('Parent Piece SFW');
	const hero = page.locator('.image-preview img');
	expect({
		href: await hero.getAttribute('src'),
		srcset: await hero.getAttribute('srcset'),
		sizes: await hero.getAttribute('sizes')
	}).toEqual(preload);
	// Still one ahead: Collection Piece's hero, and nothing for the one after.
	await expect(preloads).toHaveCount(1);
	await expect(preloads).toHaveAttribute('href', /collectionpiece/);

	await nextLink(page).click();
	await expect(h1(page)).toHaveText('Collection Piece');
	await expect(preloads).toHaveCount(0);
});

test('a piece outside the collection falls back to the gallery order and drops the context', async ({ page }) => {
	// Ref Sheet isn't in E2E Collection: a stale or forged link pages it
	// through the gallery's default order instead.
	await open(page, `/gallery/ref-sheet${inCollection}`);
	await expect(h1(page)).toHaveText('Ref Sheet');
	await expect(prevLink(page)).toHaveAccessibleName('Previous: Mature Ref Sheet');
	await expect(nextLink(page)).toHaveAccessibleName('Next: Parent Piece SFW');
	await expect(nextLink(page)).toHaveAttribute('href', '/gallery/parent-piece');
	await expect(pager(page)).toHaveAccessibleName('Browse the gallery');
	await expect(position(page)).toHaveCount(0);

	await page.keyboard.press('ArrowRight');
	await expect(page).toHaveURL(/\/gallery\/parent-piece$/);
	// Back in the gallery: Collection Piece is next there too, but the
	// previous is now Ref Sheet, which the collection would have skipped.
	await expect(prevLink(page)).toHaveAccessibleName('Previous: Ref Sheet');
});

test('an unknown collection falls back to the gallery order', async ({ page }) => {
	await open(page, '/gallery/mature-ref-sheet?collection=no-such-collection');
	await expect(nextLink(page)).toHaveAccessibleName('Next: Ref Sheet');
	await expect(pager(page)).toHaveAccessibleName('Browse the gallery');
	await expect(position(page)).toHaveCount(0);
	await expect(nextLink(page)).toHaveAttribute('href', '/gallery/ref-sheet');
});

test('a piece opened from the home page keeps the gallery default order', async ({ page }) => {
	// A plain link, the kind the home page uses, carries no context.
	await open(page, '/gallery/mature-ref-sheet');
	await expect(nextLink(page)).toHaveAccessibleName('Next: Ref Sheet');
	await expect(nextLink(page)).toHaveAttribute('href', '/gallery/ref-sheet');
	await expect(pager(page)).toHaveAccessibleName('Browse the gallery');
	await expect(position(page)).toHaveCount(0);
});

test('the position line links to the collection and stays between the buttons at 390px', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(page, `/gallery/parent-piece${inCollection}`);
	await expect(position(page)).toHaveText('2 of 3 in E2E Collection');
	const link = position(page).getByRole('link', { name: 'E2E Collection' });
	await expect(link).toHaveAttribute('href', '/collections/e2e-collection');

	/** The three pager boxes, and how many rows of text the line takes. */
	const measure = async () => {
		const [prev, line, next] = await Promise.all(
			[prevLink(page), position(page), nextLink(page)].map(async (l) => (await l.boundingBox())!)
		);
		const rows = await position(page).evaluate((el) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
		});
		return { prev, line, next, rows };
	};

	// A name this long wraps, but inside the gap: the buttons keep one row
	// and their edges, and the line overlaps neither.
	await settledShot(page, testInfo.outputPath('collection-pager-position-390.png'));
	const long = await measure();
	expect(long.next.y).toBe(long.prev.y);
	expect(long.line.x).toBeGreaterThanOrEqual(long.prev.x + long.prev.width);
	expect(long.line.x + long.line.width).toBeLessThanOrEqual(long.next.x);

	// A short name, like the approved "4 of 7 in 2025", fits on one row
	// inside the buttons' height.
	await link.evaluate((a) => (a.textContent = '2025'));
	const short = await measure();
	expect(short.rows).toBe(1);
	expect(short.line.y).toBeGreaterThanOrEqual(short.prev.y);
	expect(short.line.y + short.line.height).toBeLessThanOrEqual(short.prev.y + short.prev.height);
	await settledShot(page, testInfo.outputPath('collection-pager-position-390-short.png'));

	await position(page).getByRole('link').click();
	await expect(page).toHaveURL(/\/collections\/e2e-collection$/);
});

test("a variant shows its parent's place in the collection", async ({ page }) => {
	// Variant Piece NSFW is a version of Parent Piece SFW, second in the
	// collection.
	await open(page, `/gallery/variant-piece${inCollection}`);
	await expect(h1(page)).toHaveText('Variant Piece NSFW');
	await expect(pager(page)).toHaveAccessibleName('Browse E2E Collection');
	await expect(position(page)).toHaveText('2 of 3 in E2E Collection');
});

test('the position line and the pager name read naturally in Japanese', async ({ page }, testInfo) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', url: testInfo.project.use.baseURL! }]);
	await open(page, `/gallery/parent-piece${inCollection}`);
	await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
	await expect(page.getByRole('navigation', { name: 'E2E Collectionを順に見る' })).toBeVisible();
	await expect(position(page)).toHaveText('E2E Collectionの3点中2点目');
	await expect(position(page).getByRole('link', { name: 'E2E Collection' })).toHaveAttribute(
		'href',
		'/collections/e2e-collection'
	);
	await settledShot(page, testInfo.outputPath('collection-pager-position-ja.png'));
});

test("a version names its original's collection, not the one its own row is filed in", async ({
	page
}, testInfo) => {
	// Variant Piece NSFW is filed in E2E Other Collection; its original,
	// Parent Piece SFW, is in E2E Collection.
	const breadcrumbLink = page.locator('.breadcrumb').getByRole('link', { name: 'E2E Collection' });
	const detailsLink = page.locator('.details').getByRole('link', { name: 'E2E Collection' });
	await open(page, '/gallery/variant-piece');
	await expect(h1(page)).toHaveText('Variant Piece NSFW');
	await expect(breadcrumbLink).toHaveAttribute('href', '/collections/e2e-collection');
	await expect(detailsLink).toHaveAttribute('href', '/collections/e2e-collection');
	await expect(page.getByText('E2E Other Collection')).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('version-collection.png'));

	// Its original still names its own collection.
	await open(page, '/gallery/parent-piece');
	await expect(breadcrumbLink).toHaveAttribute('href', '/collections/e2e-collection');
	await expect(detailsLink).toHaveAttribute('href', '/collections/e2e-collection');
});
