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
	test('ArrowDown moves the active option and Enter picks it', async ({ page }) => {
		// Hydration-retry headroom for openHydrated.
		test.slow();
		await openHydrated(page);
		await expect(listbox(page)).toBeVisible();

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
		// Hydration-retry headroom for openHydrated.
		test.slow();
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
	});

	test('Enter on "All Artists" clears the filter, and Enter with the list closed does nothing', async ({ page }) => {
		// Hydration-retry headroom for openHydrated.
		test.slow();
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
		// Hydration-retry headroom for openHydrated.
		test.slow();
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
		// Hydration-retry headroom for openHydrated.
		test.slow();
		await openHydrated(page);

		await input(page).pressSequentially('zzzz-no-such-artist');
		await expect(listbox(page)).toContainText('No matching artists');
		await expect(option(page, 1)).toHaveCount(0);

		await input(page).press('Enter');
		await page.waitForTimeout(500);
		await expect(page).not.toHaveURL(/[?&]artist=/);
		expect(errors).toEqual([]);
	});

	test('pointer movement sets the active option; a parked pointer does not', async ({ page }) => {
		// Hydration-retry headroom for openHydrated.
		test.slow();
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
});
