import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Admin-settings palette flow (#55): the hex inputs normalize/revert, and the
// ref-sheet picker dialog opens (and closes on Escape — the shared focus-trap
// action). The seed publishes a 'reference'-tagged image whose URL 404s
// harmlessly (no external network), so the dialog shows its load-error
// fallback — these specs assert dialog/input behavior, never canvas pixels.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

// The "new color" hex input in the palette editor (Sona section, Site tab).
const newHexInput = (page: Page) => page.getByLabel('Hex value for the new color');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Pick from your reference sheet' });

test.describe('admin settings palette', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
	});

	// The onchange normalization is a client handler, so a change fired before
	// hydration is a no-op (the typed value just sticks). Like the gallery spec,
	// retrying the whole interaction until the handler responds is the
	// deterministic fix; once it lands the page stays hydrated.

	test('a valid hex typed into a swatch input normalizes to #RRGGBB', async ({ page }) => {
		await expect(async () => {
			await newHexInput(page).fill('abc');
			await newHexInput(page).blur();
			await expect(newHexInput(page)).toHaveValue('#AABBCC', { timeout: 1500 });
		}).toPass();
	});

	test('an invalid hex value reverts to the previous value', async ({ page }) => {
		await expect(async () => {
			await newHexInput(page).fill('not-a-color');
			await newHexInput(page).blur();
			// Reverts to the seeded default of the new-color slot.
			await expect(newHexInput(page)).toHaveValue('#888888', { timeout: 1500 });
		}).toPass();
	});

	test('the picker button opens the ref-sheet dialog, and Escape closes it', async ({ page }) => {
		// The seed has a published reference-tagged image, so the button renders
		// (instead of the publish-a-ref-sheet hint).
		const openBtn = page.getByRole('button', { name: 'Pick from ref sheet' });
		await expect(openBtn).toBeVisible();

		await expect(async () => {
			await openBtn.click();
			await expect(dialog(page)).toBeVisible({ timeout: 1500 });
		}).toPass();

		// The seeded sheet URL 404s → the dialog degrades to its hex-fields hint
		// instead of a canvas. The slot chips are still there.
		await expect(dialog(page).getByText(/Couldn't load the reference sheet/)).toBeVisible();
		await expect(dialog(page).getByRole('button', { name: 'New color' })).toBeVisible();

		// Escape closes and the trigger is still focusable (focus-trap returns it).
		await page.keyboard.press('Escape');
		await expect(dialog(page)).toHaveCount(0);
		await expect(openBtn).toBeFocused();
	});
});
