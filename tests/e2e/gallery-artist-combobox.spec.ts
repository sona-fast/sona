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
async function openHydrated(page: Page) {
	await page.goto('/gallery');
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
	});
});
