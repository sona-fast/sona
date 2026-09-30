import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying } from './admin-login';
import { waitForNavHeight } from './site-chrome-helpers';

// Linking a convention to its FurTrack event on /admin/conventions, end to end
// (SONA-230): a row's Save, the result announced in the page's live regions, a
// refused save putting the select back, a link whose photos are gone, the
// visible label on the mobile list, the manual add form keeping what was
// typed when the link is refused, the add panel opening in view, and the
// list's delete asking first.
//
// Runs on its own seeded server, the conventions-event project
// (playwright.config.ts), because it saves links and the shared servers are
// read-only by convention. The overlay (fixtures/admin-conventions-event.sql)
// seeds photos tagged LINKED and OTHER below, and four conventions: Row One,
// unlinked; Row Two, linked to OTHER; Orphan, linked to E2E Orphaned Tag 2023,
// which no photo carries; and Spare, which the delete test removes. Serial:
// the refused save on Row Two needs the link the first test saves on Row One.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml.
const PASSWORD = 'e2e-admin-password';
const SHOTS = path.join(process.cwd(), '.ship', 'sona-230');
// A full convention name with its year, long enough that a select squeezed
// by anything else on the row clips it.
const LINKED = 'E2E Linked Tag Midwest Further Confusion 2024';
const OTHER = 'E2E Other Tag 2025';

test.describe.configure({ mode: 'serial' });

// The mobile list carries a select with the same name for each row, so every
// lookup is scoped to its own list.
const desktopSelect = (page: Page, con: string) =>
	page.locator('table').getByRole('combobox', { name: `FurTrack event for ${con}`, exact: true });
const mobileSelect = (page: Page, con: string) =>
	page.locator('.mobile-list').getByRole('combobox', { name: `FurTrack event for ${con}`, exact: true });
const tableRow = (page: Page, con: string) => page.locator('tbody tr').filter({ hasText: con });

/** The document's scroll width and the width it shows: equal when nothing
 *  widens the page. */
const pageWidth = (page: Page) =>
	page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth
	}));

/** The height of an element's text as laid out: one line's height when it
 *  fits on one line, more when it wraps. A .btn has a fixed height, so its
 *  own box stays the same when its label wraps inside it. */
const textHeight = (el: Locator) =>
	el.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		return range.getBoundingClientRect().height;
	});

/** Picks a tag and waits for the row's Save to show. The select's change
 *  handler is a client handler, so a pick that lands before hydration leaves
 *  Save hidden: retry until it shows. */
async function pick(select: Locator, save: Locator, value: string) {
	await expect(async () => {
		await select.selectOption(value);
		await expect(save).toBeVisible({ timeout: 1500 });
	}).toPass();
}

/** Picks a tag and saves it. On a cold dev server a reload can land after
 *  the pick and put the select back, leaving Save hidden: retry the pick and
 *  the click together. */
async function pickAndSave(select: Locator, save: Locator, value: string) {
	await expect(async () => {
		await pick(select, save, value);
		await save.click({ timeout: 1500 });
	}).toPass();
}

/** Clicks a trigger until the target it opens shows: the trigger's handler
 *  runs on the client, so a click before hydration does nothing. */
async function clickUntilVisible(trigger: Locator, target: Locator) {
	await expect(async () => {
		if (!(await target.isVisible())) await trigger.click();
		await expect(target).toBeVisible({ timeout: 1500 });
	}).toPass();
	return target;
}

/** Opens the manual add form from the header's Add, retrying for the same
 *  reason, and returns its Name field. */
async function openManual(page: Page) {
	const name = page.getByRole('textbox', { name: 'Name', exact: true });
	const manual = page.getByRole('button', { name: "+ Can't find it? Add manually" });
	await expect(async () => {
		if (!(await manual.isVisible())) {
			await page.locator('.page-header').getByRole('button', { name: 'Add Convention' }).click();
		}
		await manual.click({ timeout: 1500 });
		await expect(name).toBeVisible({ timeout: 1500 });
	}).toPass();
	return name;
}

/** Puts the spare row back if an earlier attempt already deleted it, so a
 *  retry of this serial file has a row to delete and a list as long as the
 *  first attempt's. */
async function ensureSpare(page: Page) {
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(tableRow(page, 'E2E Row One Con')).toHaveCount(1);
	if ((await tableRow(page, 'E2E Spare Con').count()) > 0) return;
	const name = await openManual(page);
	await name.fill('E2E Spare Con');
	await page.getByLabel('Start date').fill('2022-05-06');
	await page.getByRole('button', { name: 'Add manually', exact: true }).click();
	await expect(tableRow(page, 'E2E Spare Con')).toHaveCount(1);
	await page.reload();
}

/** The select's width and the width it needs to show its chosen option in
 *  full: a copy holding only that option, at its own natural width. */
function widths(select: Locator) {
	return select.evaluate((el: HTMLSelectElement) => {
		const probe = el.cloneNode(true) as HTMLSelectElement;
		probe.removeAttribute('id');
		for (const option of [...probe.options]) if (option.value !== el.value) option.remove();
		probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;max-width:none;min-width:0;flex:none';
		el.parentElement!.appendChild(probe);
		const needed = probe.getBoundingClientRect().width;
		probe.remove();
		return { actual: el.getBoundingClientRect().width, needed };
	});
}

/** Saves a row's link unless it already has that value, and says whether it
 *  had to. A retry of this serial file starts over on the same database. */
async function ensureSaved(page: Page, con: string, value: string) {
	const select = desktopSelect(page, con);
	if ((await select.inputValue()) === value) return false;
	const save = tableRow(page, con).locator('.event-save');
	await pickAndSave(select, save, value);
	await expect(page.getByRole('status')).toContainText(con);
	return true;
}

test.beforeEach(async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/conventions');
});

test('links a row, announces it, and refuses a tag another row has', async ({ page }) => {
	// Put the rows in their starting state rather than assume it: on a retry
	// this test has already linked Row One, and the delete test may have
	// removed Spare. Reload after, so the live regions start empty.
	await ensureSpare(page);
	const one = desktopSelect(page, 'E2E Row One Con');
	await expect(one).toBeVisible();
	const resetOne = await ensureSaved(page, 'E2E Row One Con', '');
	const resetTwo = await ensureSaved(page, 'E2E Row Two Con', OTHER);
	if (resetOne || resetTwo) await page.reload();

	const status = page.getByRole('status');
	const alert = page.getByRole('alert');
	// Both live regions are in the page before anything happens, so a result
	// that lands in them is announced.
	await expect(status).toHaveCount(1);
	await expect(alert).toHaveCount(1);
	await expect(status).toBeEmpty();
	await expect(alert).toBeEmpty();

	// Save stays out of sight, holding its place, until the pick changes.
	const oneSave = tableRow(page, 'E2E Row One Con').locator('.event-save');
	await expect(one).toHaveValue('');
	await expect(oneSave).toBeHidden();
	await expect(oneSave).toHaveCSS('visibility', 'hidden');

	await pickAndSave(one, oneSave, LINKED);
	await expect(status).toHaveText(`Linked E2E Row One Con to the FurTrack event “${LINKED}”.`);
	await expect(alert).toBeEmpty();
	// Saved: Save hides again and focus stays on the row.
	await expect(oneSave).toBeHidden();
	await expect(one).toBeFocused();

	// The column stops at 240px so a long tag cannot push the row actions out
	// of the table; the open picker still shows the tag whole. A short tag
	// fits inside that width.
	const desktop = await widths(one);
	expect(desktop.needed).toBeGreaterThan(240);
	expect(desktop.actual).toBeCloseTo(240, 0);
	const short = await widths(desktopSelect(page, 'E2E Row Two Con'));
	expect(short.actual).toBeGreaterThanOrEqual(short.needed - 0.5);

	await page.reload();
	await expect(desktopSelect(page, 'E2E Row One Con')).toHaveValue(LINKED);

	// A link whose photos are gone still shows as the row's value.
	await expect(desktopSelect(page, 'E2E Orphan Con')).toHaveValue('E2E Orphaned Tag 2023');

	// Row Two asks for the tag Row One now has: refused, announced, tied to
	// the select, and the select goes back to the tag Row Two really has.
	const two = desktopSelect(page, 'E2E Row Two Con');
	const twoSave = tableRow(page, 'E2E Row Two Con').locator('.event-save');
	await expect(two).toHaveValue(OTHER);
	await pickAndSave(two, twoSave, LINKED);
	const refusal = 'That FurTrack event is already linked to E2E Row One Con. Set E2E Row One Con to None first.';
	await expect(alert).toHaveText(refusal);
	await expect(alert).toBeVisible();
	await expect(two).toHaveValue(OTHER);
	await expect(two).toHaveAccessibleDescription(refusal);
	await expect(twoSave).toBeHidden();
	// Save hides while it has focus, so focus moves to the row's select, not
	// the page.
	await expect(two).toBeFocused();
	await page.screenshot({ path: path.join(SHOTS, 'admin-conventions-event-desktop.png'), fullPage: true });
});

test('keeps every row action in reach beside a long tag', async ({ page }) => {
	const wrapper = page.locator('.table-wrapper');
	const list = page.locator('.mobile-list');

	/** Every row's delete and the live row's Show QR in one layout: visible,
	 *  inside the given box, and able to take a click. */
	async function actionsInReach(scope: Locator, box: { x: number; width: number }) {
		const deletes = await scope.getByRole('button', { name: /^Delete / }).all();
		const targets = [scope.getByRole('link', { name: 'Show QR' }), ...deletes];
		expect(deletes.length).toBeGreaterThan(3);
		for (const target of targets) {
			await expect(target).toBeVisible();
			const b = (await target.boundingBox())!;
			expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5);
			expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
			await target.click({ trial: true });
		}
	}

	// Wide enough for every column: the table shows and fits without scrolling.
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(wrapper).toBeVisible();
	await expect(list).toBeHidden();
	const fit = await wrapper.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
	expect(fit.scroll).toBe(fit.client);
	await actionsInReach(wrapper, (await wrapper.boundingBox())!);
	// Each date range that wraps breaks after its arrow, the same on every
	// row: the start date and the arrow share a line, and every range is as
	// tall as the next.
	const dates = await wrapper.locator('td.dates').all();
	expect(dates.length).toBeGreaterThan(3);
	const rangeHeights = await Promise.all(dates.map(textHeight));
	for (const [i, cell] of dates.entries()) {
		// One line's height is the first character's; the cell's line-height
		// is "normal", which has no number to read.
		const { lineHeight, startAndArrow } = await cell.evaluate((el) => {
			const text = el.firstChild!;
			const height = (end: number) => {
				const range = document.createRange();
				range.setStart(text, 0);
				range.setEnd(text, end);
				return range.getBoundingClientRect().height;
			};
			return { lineHeight: height(1), startAndArrow: height(text.textContent!.indexOf('→') + 1) };
		});
		const label = `dates "${await cell.textContent()}"`;
		expect(startAndArrow, `${label} start and arrow height`).toBeLessThan(lineHeight * 1.5);
		expect(rangeHeights[i], `${label} text height`).toBeCloseTo(rangeHeights[0], 0);
	}
	// The scrolling table is one named tab stop, the same in every browser.
	const region = page.getByRole('region', { name: 'Conventions', exact: true });
	await expect(region).toBeVisible();
	await region.focus();
	await expect(region).toBeFocused();
	// Each delete says which convention it removes.
	const rowDelete = tableRow(page, 'E2E Row One Con').getByRole('button', { name: 'Delete E2E Row One Con', exact: true });
	await expect(rowDelete).toBeVisible();
	// Focused, it draws the page's own focus ring rather than the browser's.
	await rowDelete.focus();
	await expect(rowDelete).toHaveCSS('outline-style', 'solid');
	await expect(rowDelete).toHaveCSS('outline-width', '2px');

	// The title and the header's Add and Sync, each on one line at full width.
	const header = page.locator('.page-header');
	const headerParts = [
		header.getByRole('heading', { level: 1 }),
		header.getByRole('button', { name: /Add Convention/ }),
		header.getByRole('button', { name: /Sync from cons\.fyi/ })
	];
	const oneLine = await Promise.all(headerParts.map(textHeight));

	// Narrower than the columns need, down to just above a phone: the list
	// replaces the table, so no edge cuts through a row's status or actions,
	// and it keeps the width it has at 1024 rather than running the whole
	// page. Add and Sync stay in the header, at the top of the page, and show
	// once. The title, its count, and each label stay on one line inside the
	// page: at 800 the title and the pair do not fit one row, so the pair
	// drops under the title.
	const visibleAdd = page.getByRole('button', { name: /Add Convention/ }).filter({ visible: true });
	const visibleSync = page.getByRole('button', { name: /Sync from cons\.fyi/ }).filter({ visible: true });
	for (const width of [1240, 1024, 900, 800, 780]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(list, `list at ${width}px`).toBeVisible();
		await expect(wrapper, `table at ${width}px`).toBeHidden();
		const listBox = (await list.boundingBox())!;
		expect(listBox.width, `list width at ${width}px`).toBeLessThanOrEqual(760.5);
		// Where the title and the pair share a row, the pair ends over the
		// list's trash column, not out at the page's edge.
		if (width >= 900) {
			const add = (await headerParts[1].boundingBox())!;
			expect(Math.abs(add.x + add.width - (listBox.x + listBox.width)), `header Add end at ${width}px`).toBeLessThanOrEqual(1);
		}
		const doc = await pageWidth(page);
		expect(doc.scroll, `page width at ${width}px`).toBe(doc.client);
		await actionsInReach(list, { x: 0, width: doc.client });
		await expect(visibleAdd, `Add at ${width}px`).toHaveCount(1);
		await expect(visibleSync, `Sync at ${width}px`).toHaveCount(1);
		for (const [i, part] of headerParts.entries()) {
			await expect(part, `header part ${i} at ${width}px`).toBeVisible();
			expect(await textHeight(part), `header part ${i} text height at ${width}px`).toBeCloseTo(oneLine[i], 0);
			const b = (await part.boundingBox())!;
			expect(b.x + b.width, `header part ${i} right edge at ${width}px`).toBeLessThanOrEqual(doc.client + 0.5);
		}
	}

	// Text at twice its size (text-only zoom, emulated by setting each header
	// element's font size to twice the size it had, since the page sets them
	// in px; every size is read before any is written, so a child that
	// inherits its size is doubled once, not twice): the pair wraps rather
	// than widening the page, and each label stays on one line.
	await page.setViewportSize({ width: 800, height: 900 });
	await header.evaluate((el) => {
		const nodes = [el, ...el.querySelectorAll<HTMLElement>('*')];
		const sizes = nodes.map((node) => parseFloat(getComputedStyle(node).fontSize));
		nodes.forEach((node, i) => (node.style.fontSize = `${sizes[i] * 2}px`));
	});
	const zoomed = await pageWidth(page);
	expect(zoomed.scroll, 'page width at 200% text').toBe(zoomed.client);
	for (const [i, part] of headerParts.slice(1).entries()) {
		const lineHeight = await part.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
		// A wrapped label is two lines tall; one line stays under one and a half.
		expect(await textHeight(part), `header button ${i} text height at 200% text`).toBeLessThan(lineHeight * 1.5);
	}
	await page.reload();

	// A phone: the header drops its pair and the list's own Add and Sync show.
	for (const width of [768, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(visibleAdd, `Add at ${width}px`).toHaveCount(1);
		await expect(visibleSync, `Sync at ${width}px`).toHaveCount(1);
		await expect(list.getByRole('button', { name: /Add Convention/ }), `list Add at ${width}px`).toBeVisible();
		await expect(list.getByRole('button', { name: /Sync from cons\.fyi/ }), `list Sync at ${width}px`).toBeVisible();
	}

	// At 1024 the select stops at a readable width instead of running the
	// whole line, and a pending change puts Save beside it, not under it.
	await page.setViewportSize({ width: 1024, height: 900 });
	const select = mobileSelect(page, 'E2E Row Two Con');
	const save = list.locator('.mobile-item').filter({ hasText: 'E2E Row Two Con' }).locator('.event-save');
	const line = await select.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
	expect(line).toBeGreaterThan(480);
	expect((await select.boundingBox())!.width).toBeCloseTo(480, 0);
	// The live row's wash runs past the row's edges rather than indenting it,
	// so its select lines up with every other row's.
	const liveLeft = (await mobileSelect(page, 'E2E Live Con').boundingBox())!.x;
	expect(Math.abs(liveLeft - (await select.boundingBox())!.x)).toBeLessThanOrEqual(1);
	// On the right it ends where every other row and its divider end.
	const liveRow = (await list.locator('.mobile-item.is-live').boundingBox())!;
	const rowTwo = (await list.locator('.mobile-item').filter({ hasText: 'E2E Row Two Con' }).boundingBox())!;
	expect(Math.abs(liveRow.x + liveRow.width - (rowTwo.x + rowTwo.width))).toBeLessThanOrEqual(1);
	await pick(select, save, LINKED);
	const s = (await select.boundingBox())!;
	const b = (await save.boundingBox())!;
	expect(b.x).toBeGreaterThanOrEqual(s.x + s.width);
	expect(b.y).toBeLessThan(s.y + s.height);
	await page.screenshot({ path: path.join(SHOTS, 'admin-conventions-event-1024.png'), fullPage: true });
});

test('keeps the manual add form open with what was typed when the link is refused', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const name = await openManual(page);

	await name.fill('E2E Typed Con');
	await page.getByLabel('Start date').fill('2026-12-04');
	await page.locator('.add-form').getByRole('combobox', { name: 'FurTrack event', exact: true }).selectOption(OTHER);
	await page.getByRole('button', { name: 'Add manually', exact: true }).click();

	await expect(page.getByRole('alert')).toHaveText(
		`That FurTrack event is already linked to E2E Row Two Con. Set E2E Row Two Con to None first.`
	);
	await expect(name).toBeVisible();
	await expect(name).toHaveValue('E2E Typed Con');
	await expect(page.locator('tbody tr').filter({ hasText: 'E2E Typed Con' })).toHaveCount(0);
});

test('labels the FurTrack event on the mobile list, at a width that fits the tag', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const item = page.locator('.mobile-item').filter({ hasText: 'E2E Row One Con' });
	await expect(item.getByText('FurTrack event', { exact: true })).toBeVisible();
	// The name starts with the visible label and says which convention it is.
	const select = mobileSelect(page, 'E2E Row One Con');
	await expect(select).toBeVisible();
	await expect(select).toHaveValue(LINKED);
	await expect(item.locator('.event-save')).toBeHidden();
	// A tag too long for the line ends in an ellipsis, not a bare cut.
	await expect(select).toHaveCSS('text-overflow', 'ellipsis');
	const mobile = await widths(select);
	expect(mobile.actual).toBeGreaterThanOrEqual(mobile.needed - 0.5);

	const two = mobileSelect(page, 'E2E Row Two Con');
	const twoSave = page.locator('.mobile-item').filter({ hasText: 'E2E Row Two Con' }).locator('.event-save');
	// With nothing to save, Save takes no room: the select runs to the row's
	// edge and nothing holds an empty line open under it.
	await expect(twoSave).toBeHidden();
	const edges = await two.evaluate((el) => {
		const select = el.getBoundingClientRect();
		const row = el.parentElement!.getBoundingClientRect();
		return { right: row.right - select.right, bottom: row.bottom - select.bottom };
	});
	expect(Math.abs(edges.right)).toBeLessThan(1);
	expect(Math.abs(edges.bottom)).toBeLessThan(1);
	// A refused save removes Save from the layout while it has focus, so focus
	// moves to the row's select, not the page.
	await pickAndSave(two, twoSave, LINKED);
	await expect(page.getByRole('alert')).toContainText('already linked to E2E Row One Con');
	await expect(twoSave).toBeHidden();
	await expect(two).toBeFocused();
	await expect(two).toHaveValue(OTHER);
	await page.screenshot({ path: path.join(SHOTS, 'admin-conventions-event-390.png'), fullPage: true });

	// No card, the live one included, widens the page past a narrow phone:
	// the select gives up width instead. The live row's wash runs edge to
	// edge, with no sliver of page on either side.
	const live = page.locator('.mobile-item.is-live');
	for (const width of [390, 375, 360, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(live).toBeVisible();
		const doc = await pageWidth(page);
		expect(doc.scroll, `page width at ${width}px`).toBe(doc.client);
		const card = (await live.boundingBox())!;
		expect(card.x, `live card left at ${width}px`).toBeLessThanOrEqual(0.5);
		expect(card.x + card.width, `live card right at ${width}px`).toBeCloseTo(doc.client, 0);
	}
	await page.screenshot({ path: path.join(SHOTS, 'admin-conventions-event-320.png'), fullPage: true });
});

/** Where the screen stops showing the page: the top of the phone's fixed
 *  bottom nav where it shows, else the foot of the viewport. */
async function visibleBottom(page: Page) {
	const nav = page.locator('.mobile-nav');
	return (await nav.isVisible()) ? (await nav.boundingBox())!.y : page.viewportSize()!.height;
}

/** The panel's top and its last control are both on screen, clear of the
 *  phone's bottom nav, and focus is in its first control, so the Add that
 *  opened it did not open it out of sight. */
async function expectPanelInView(page: Page, panel: Locator, add: Locator) {
	await expect(page.getByRole('combobox', { name: 'Add from cons.fyi', exact: true })).toBeFocused();
	const box = (await panel.boundingBox())!;
	expect(box.y).toBeGreaterThanOrEqual(-0.5);
	const last = (await panel.getByRole('button', { name: "+ Can't find it? Add manually" }).boundingBox())!;
	expect(last.y + last.height).toBeLessThanOrEqual((await visibleBottom(page)) + 0.5);
	await expect(add).toHaveAttribute('aria-expanded', 'true');
}

test('opens the add panel in view with focus on its first control', async ({ page }) => {
	// A short laptop screen: Add is the header's, and the panel opens under it.
	await page.setViewportSize({ width: 1024, height: 600 });
	const headerAdd = page.locator('.page-header').getByRole('button', { name: /Add Convention/ });
	const panel = page.locator('.add-panel');
	await expect(headerAdd).toHaveAttribute('aria-expanded', 'false');
	await expectPanelInView(page, await clickUntilVisible(headerAdd, panel), headerAdd);
	// The panel opened in view, so the page does not scroll: the Add that
	// closes it and reports its state stays on screen.
	const add = (await headerAdd.boundingBox())!;
	expect(add.y).toBeGreaterThanOrEqual(-0.5);
	expect(add.y + add.height).toBeLessThanOrEqual(600.5);
	// The same Add closes it.
	await headerAdd.click();
	await expect(panel).toBeHidden();
	await expect(headerAdd).toHaveAttribute('aria-expanded', 'false');
});

test('brings the add panel into view from the foot of a long list on a phone', async ({ page }) => {
	// A very short phone screen: the list's Add sits screens below the place
	// the panel opens in, and the panel (about 256px tall) still fits above
	// the space the page keeps clear for the bottom nav.
	await page.setViewportSize({ width: 390, height: 360 });
	const listAdd = page.locator('.mobile-list').getByRole('button', { name: /Add Convention/ });
	const panel = page.locator('.add-panel');
	// Tabbing to the list's Add while it sits on screen but behind the fixed
	// bottom nav scrolls it clear of the nav. Start from the control before
	// it, with the page scrolled so the Add is wholly behind the nav.
	const before = page.locator('.mobile-list .mobile-item').last().getByRole('combobox');
	await before.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
	await listAdd.evaluate((el) => {
		const r = el.getBoundingClientRect();
		window.scrollBy(0, r.bottom + 2 - window.innerHeight);
	});
	const navTop = await visibleBottom(page);
	expect((await listAdd.boundingBox())!.y).toBeGreaterThanOrEqual(navTop);
	await page.keyboard.press('Tab');
	await expect(listAdd).toBeFocused();
	const tabbed = (await listAdd.boundingBox())!;
	expect(tabbed.y + tabbed.height).toBeLessThanOrEqual(navTop + 0.5);
	// The nav's own padding does that, as tall as the bar plus 6px for the focus
	// ring once the bar has published its height, so it is on the page while
	// the nav shows.
	await waitForNavHeight(page);
	const kept = await page.evaluate(() => ({
		padding: getComputedStyle(document.documentElement).scrollPaddingBottom,
		nav: `${(document.querySelector('.mobile-nav') as HTMLElement).offsetHeight}px`
	}));
	expect(kept.padding).toBe(`${parseFloat(kept.nav) + 6}px`);
	await listAdd.scrollIntoViewIfNeeded();
	// The panel opens under the header, and the header is above the screen.
	const header = (await page.locator('.page-header').boundingBox())!;
	expect(header.y + header.height).toBeLessThanOrEqual(0);
	// Focusing the panel's first select scrolls that select into view on its
	// own, centred, which on this screen leaves the panel's foot below the
	// screen. The page's scrollIntoView is there for the panel as a whole, so
	// its top and bottom edges are both on screen.
	await expectPanelInView(page, await clickUntilVisible(listAdd, panel), listAdd);
	await page.screenshot({ path: path.join(SHOTS, 'admin-conventions-add-390.png') });
	// The list's Add closes the panel too, and keeps focus.
	await listAdd.click();
	await expect(panel).toBeHidden();
	await expect(listAdd).toHaveAttribute('aria-expanded', 'false');
	await expect(listAdd).toBeFocused();
});

test('shows the top of the add panel on a phone screen too short for all of it', async ({ page }) => {
	// Shorter still: the panel is taller than the space above the room kept
	// clear for the bottom nav, so it opens with its top, and the label of
	// its focused first control, at the top of the screen.
	await page.setViewportSize({ width: 390, height: 300 });
	const listAdd = page.locator('.mobile-list').getByRole('button', { name: /Add Convention/ });
	const panel = page.locator('.add-panel');
	await listAdd.scrollIntoViewIfNeeded();
	await clickUntilVisible(listAdd, panel);
	await expect(page.getByRole('combobox', { name: 'Add from cons.fyi', exact: true })).toBeFocused();
	const label = (await panel.locator('.pick-form label > span').first().boundingBox())!;
	expect(label.y).toBeGreaterThanOrEqual(0);
	expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(-0.5);
});

test("keeps what was typed in the add panel when the list's Add closes and reopens it", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const listAdd = page.locator('.mobile-list').getByRole('button', { name: /Add Convention/ });
	const panel = page.locator('.add-panel');
	await listAdd.scrollIntoViewIfNeeded();
	await clickUntilVisible(listAdd, panel);
	const name = await clickUntilVisible(
		panel.getByRole('button', { name: "+ Can't find it? Add manually" }),
		page.getByRole('textbox', { name: 'Name', exact: true })
	);
	await name.fill('Typed Draft Con');
	// From the foot of the list, the list's Add closes the panel and opens it
	// again, and the Name typed before is still there.
	await listAdd.scrollIntoViewIfNeeded();
	const open = (await panel.boundingBox())!;
	expect(open.y + open.height, 'open panel above the screen').toBeLessThanOrEqual(0);
	await listAdd.click();
	await expect(panel).toBeHidden();
	await expect(listAdd).toHaveAttribute('aria-expanded', 'false');
	await listAdd.click();
	await expect(panel).toBeVisible();
	await expect(listAdd).toHaveAttribute('aria-expanded', 'true');
	await expect(name).toHaveValue('Typed Draft Con');
});

test("asks before the list's delete removes a convention", async ({ page }) => {
	await ensureSpare(page);
	const list = page.locator('.mobile-list');
	const items = list.locator('.mobile-item');
	const confirm = page.getByRole('dialog', { name: 'Delete Convention' });

	// A laptop and a phone both show the list: Cancel leaves the row in place.
	for (const width of [1024, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const before = await items.count();
		const dialog = await clickUntilVisible(list.getByRole('button', { name: 'Delete E2E Row Two Con', exact: true }), confirm);
		await expect(dialog).toContainText('Delete "E2E Row Two Con" from your schedule?');
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(dialog).toBeHidden();
		await page.reload();
		await expect(items, `rows after Cancel at ${width}px`).toHaveCount(before);
		await expect(items.filter({ hasText: 'E2E Row Two Con' })).toHaveCount(1);
	}

	// Confirm removes the row, and it stays gone.
	const before = await items.count();
	const dialog = await clickUntilVisible(list.getByRole('button', { name: 'Delete E2E Spare Con', exact: true }), confirm);
	await expect(dialog).toContainText('Delete "E2E Spare Con" from your schedule?');
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(items.filter({ hasText: 'E2E Spare Con' })).toHaveCount(0);
	await page.reload();
	await expect(items).toHaveCount(before - 1);
	await expect(items.filter({ hasText: 'E2E Spare Con' })).toHaveCount(0);
});
