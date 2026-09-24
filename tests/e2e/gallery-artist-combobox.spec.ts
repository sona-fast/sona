import { test, expect, type Page } from '@playwright/test';

// Keyboard coverage for the gallery's artist filter combobox. Arrow keys move an
// active option (announced through aria-activedescendant) and Enter picks it, so
// a keyboard user can choose any option, not only the first match. Seed:
// tests/e2e/fixtures/seed.sql. Only 'Test Artist' has published top-level
// images, so the list is "All Artists" (option 0) then 'Test Artist' (option 1).

const ARTIST = 'Test Artist';

const input = (page: Page) => page.locator('input.combobox-input');
const listbox = (page: Page) => page.locator('#artist-combobox-list');
const option = (page: Page, i: number) => page.locator(`#artist-combobox-opt-${i}`);

// In `vite dev`, hydration lags the initial load, so a key pressed right after
// page.goto can land before Svelte attaches the input's handlers and do nothing.
// Load once, then keep pressing ArrowDown until it activates option 0; from
// then on the page is hydrated. (Reloading on every attempt never gives a cold
// dev server enough time to hydrate.) Bounded below the test.slow() budget so a
// dead loop fails with its real assertion error instead of the test clock.
async function openHydrated(page: Page, path = '/gallery') {
	await page.goto(path);
	await expect(async () => {
		await input(page).focus();
		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0', {
			timeout: 1500
		});
	}).toPass({ timeout: 45_000 });
}

test.describe('gallery artist combobox keyboard', () => {
	// Hydration-retry headroom for openHydrated.
	test.beforeEach(() => {
		test.slow();
	});

	test('ArrowDown moves the active option and Enter picks it', async ({ page }) => {
		await openHydrated(page);
		await expect(listbox(page)).toBeVisible();
		await expect(input(page)).toHaveAttribute('aria-autocomplete', 'list');
		// The li wrappers are presentational so screen readers count only options.
		await expect(page.locator('#artist-combobox-list > li:not([role="presentation"])')).toHaveCount(0);

		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');
		await expect(option(page, 1)).toHaveText(ARTIST);
		await expect(option(page, 1)).toHaveAttribute('aria-selected', 'true');
		await expect(option(page, 1)).toHaveClass(/\bactive\b/);
		await expect(option(page, 0)).toHaveAttribute('aria-selected', 'false');
		await expect(option(page, 0)).not.toHaveClass(/\bactive\b/);

		await input(page).press('Enter');
		await expect(page).toHaveURL(/[?&]artist=Test(\+|%20)Artist(&|$)/);
		await expect(input(page)).toHaveValue(ARTIST);
		await expect(listbox(page)).toHaveCount(0);
	});

	test('arrows stop at both ends and Escape closes the list', async ({ page }) => {
		await openHydrated(page);

		// ArrowUp at the first option stays there.
		await input(page).press('ArrowUp');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');
		await expect(option(page, 0)).toHaveAttribute('aria-selected', 'true');

		// ArrowDown past the last option stays on it.
		await input(page).press('ArrowDown');
		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');

		await input(page).press('Escape');
		await expect(listbox(page)).toHaveCount(0);
		await expect(input(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(input(page)).not.toHaveAttribute('aria-activedescendant');
		await expect(page).not.toHaveURL(/[?&]artist=/);
		// Escape keeps focus in the combobox, and ArrowUp doesn't reopen the list.
		await expect(input(page)).toBeFocused();
		await input(page).press('ArrowUp');
		await expect(listbox(page)).toHaveCount(0);

		// ArrowDown reopens the closed list on the first option.
		await input(page).press('ArrowDown');
		await expect(listbox(page)).toBeVisible();
		await expect(input(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');

		// A click on the still-focused input reopens the list after Escape.
		await input(page).press('Escape');
		await expect(listbox(page)).toHaveCount(0);
		await input(page).click();
		await expect(listbox(page)).toBeVisible();

		// Tab leaves the combobox and closes the list. Shrink the list first so it
		// overflows: a scroll container with no focusable children is itself a Tab
		// stop unless it carries tabindex=-1, and the two-option seed never scrolls.
		await page.addStyleTag({ content: '#artist-combobox-list{max-height:60px}' });
		await input(page).press('Tab');
		await expect(input(page)).not.toBeFocused();
		await expect(listbox(page)).toHaveCount(0);
		await expect(page.locator('#artist-combobox-list')).toHaveCount(0);

		// Closing on focusout doesn't swallow a mouse pick. Safari blurs the input
		// with no relatedTarget on an option press; dispatch that shape and make
		// sure the list survives it before the click lands.
		await input(page).click();
		await expect(listbox(page)).toBeVisible();
		await input(page).dispatchEvent('focusout', { bubbles: true, relatedTarget: null });
		await expect(listbox(page)).toBeVisible();
		await option(page, 1).click();
		await expect(page).toHaveURL(/[?&]artist=Test(\+|%20)Artist(&|$)/);
	});

	test('Enter on "All Artists" clears the filter, and Enter with the list closed does nothing', async ({ page }) => {
		await openHydrated(page, '/gallery?artist=Test+Artist');

		// Option 0 is active, so Enter must pick it, not the first-match fallback.
		await input(page).press('Enter');
		await expect(page).not.toHaveURL(/[?&]artist=/);
		await expect(input(page)).toHaveValue('');
		await expect(listbox(page)).toHaveCount(0);

		// With the list closed and the query empty, Enter must not apply the
		// first artist. The navigation can move focus, so focus the input (which
		// opens the list) and close it with Escape, keeping focus in the input.
		// Give a stray navigation time to land.
		await input(page).focus();
		await input(page).press('Escape');
		await expect(listbox(page)).toHaveCount(0);
		await expect(input(page)).toBeFocused();
		await input(page).press('Enter');
		await page.waitForTimeout(500);
		await expect(page).not.toHaveURL(/[?&]artist=/);
		await expect(input(page)).toHaveValue('');
	});

	test('typing resets the active option and Enter falls back to the first match', async ({ page }) => {
		await openHydrated(page);

		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');
		await input(page).pressSequentially('Test');
		await expect(input(page)).not.toHaveAttribute('aria-activedescendant');

		await input(page).press('Enter');
		await expect(page).toHaveURL(/[?&]artist=Test(\+|%20)Artist(&|$)/);
		await expect(input(page)).toHaveValue(ARTIST);

		// After a pick, reopening starts from the top, not a leftover index.
		await input(page).blur();
		await input(page).focus();
		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');
	});

	test('Enter with no matching artists leaves the URL alone', async ({ page }) => {
		const errors: Error[] = [];
		page.on('pageerror', (err) => errors.push(err));
		await openHydrated(page);

		await input(page).pressSequentially('zzzz-no-such-artist');
		await expect(listbox(page)).toContainText('No matching artists');
		await expect(option(page, 1)).toHaveCount(0);

		// A stray pick would close the list and replace the typed text.
		await input(page).press('Enter');
		await expect(input(page)).toHaveValue('zzzz-no-such-artist');
		await expect(listbox(page)).toContainText('No matching artists');
		expect(errors).toEqual([]);
	});

	test('pointer movement sets the active option; a parked pointer does not', async ({ page }) => {
		await openHydrated(page);

		const box = await option(page, 1).boundingBox();
		if (!box) throw new Error('option 1 has no bounding box');
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.move(x + 1, y);
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');

		// The keyboard moves the active option away from the parked pointer, and
		// only the active row is highlighted: no hover style on the other one.
		await input(page).press('ArrowUp');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');
		await expect(page.locator('.combobox-option.active')).toHaveCount(1);
		await expect(option(page, 1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(option(page, 1)).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
		await expect(option(page, 0)).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');

		// Moving the pointer again activates the row under it, and Enter picks it.
		await page.mouse.move(x, y);
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');
		await input(page).press('Enter');
		await expect(page).toHaveURL(/[?&]artist=Test(\+|%20)Artist(&|$)/);
	});

	test('arrow keys scroll the active option into view; a scroll under a parked pointer keeps it', async ({ page }) => {
		await openHydrated(page);
		// Two options never overflow the 260px list; shrink it so it scrolls (the
		// rows are 37px, so 60px shows one whole row but not both).
		await page.addStyleTag({ content: '#artist-combobox-list{max-height:60px}' });

		const inView = (i: number) =>
			listbox(page).evaluate((list, id) => {
				const opt = document.getElementById(id)!;
				const l = list.getBoundingClientRect();
				const o = opt.getBoundingClientRect();
				return o.top >= l.top && o.bottom <= l.bottom;
			}, `artist-combobox-opt-${i}`);
		const idAtPoint = (px: number, py: number) =>
			page.evaluate(([ex, ey]) => document.elementFromPoint(ex, ey)?.id, [px, py]);

		// Park the pointer near the top of option 0.
		const box = await option(page, 0).boundingBox();
		if (!box) throw new Error('option 0 has no bounding box');
		const x = box.x + box.width / 2;
		const y = box.y + 6;
		await page.mouse.move(x - 1, y);
		await page.mouse.move(x, y);
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');
		await expect.poll(() => inView(1)).toBe(false);

		// ArrowDown scrolls option 1 into view, and option 0 stays under the pointer.
		await input(page).press('ArrowDown');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');
		await expect.poll(() => inView(1)).toBe(true);
		await expect.poll(() => idAtPoint(x, y)).toBe('artist-combobox-opt-0');

		// A desktop browser sends a move event, at unchanged coordinates, when
		// content scrolls under a still pointer; headless Chromium doesn't, so
		// dispatch it. Only a real coordinate change may move the active option.
		await page.evaluate(([px, py]) => {
			document
				.elementFromPoint(px, py)!
				.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: py, bubbles: true }));
		}, [x, y]);
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-1');

		// ArrowUp scrolls option 0 back into view.
		await expect.poll(() => inView(0)).toBe(false);
		await input(page).press('ArrowUp');
		await expect(input(page)).toHaveAttribute('aria-activedescendant', 'artist-combobox-opt-0');
		await expect.poll(() => inView(0)).toBe(true);
	});
});
