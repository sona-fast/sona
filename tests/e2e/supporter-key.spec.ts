import { test, expect, type Page } from '@playwright/test';

// Supporter-key settings flow (SONA-105): the Account tab's empty state renders
// (explainer + Key field), a garbage key is rejected with the invalid error AND
// the correct aria wiring (aria-invalid + aria-describedby → the error's id), and
// a real-signature-but-expired key is rejected with the distinct expired error.
//
// The expired token below was signed by the REAL production private key (which
// lives only on sona.fast) — reaching the expired error, not the invalid one,
// exercises signature verification against the baked-in public key end to end.
// It's exp 1752710400 (in the past), so it's useless to a freeloader; the unit
// test supporter-key.test.ts documents it as the key-rotation tripwire.
//
// Neither submission persists (both fail validation before setRawSetting), so
// this spec doesn't mutate the shared e2e DB.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// Real-key-signed, already-expired token (see supporter-key.test.ts).
const EXPIRED_TOKEN =
	'eyJ2IjoxLCJsb2dpbiI6Imtub3duLWFuc3dlciIsInRpZXIiOjgsImV4cCI6MTc1MjcxMDQwMH0.fr25p4GX1PXoTdqBTBTYQImZGdGKo13I5GDil_KXNi2dDVxBQaNiLQ5sGoVcapBmjPxV-0ADYAKCaFP-_CDTDA';

async function login(page: Page) {
	await page.goto('/admin/login');
	await page.fill('input[name="password"]', PASSWORD);
	// Plain form POST — works pre-hydration, then redirects to /admin/images.
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
}

const keyInput = (page: Page) => page.locator('input[name="supporterKey"]');
const saveButton = (page: Page) =>
	page.locator('form[action="?/saveSupporterKey"] button[type="submit"]');
const fieldError = (page: Page) => page.locator('.field-error#supporter-key-error');

// The account sections are hidden by CSS until the Account tab is active, and the
// tab toggle is client JS — so the click only "takes" once hydrated. Retry the
// whole click-until-visible like the palette spec's hydration-sensitive steps.
async function openAccountTab(page: Page) {
	await expect(async () => {
		await page.getByRole('button', { name: 'Account', exact: true }).click();
		await expect(keyInput(page)).toBeVisible({ timeout: 1500 });
	}).toPass();
}

test.describe('admin settings supporter key', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
		await openAccountTab(page);
	});

	test('the empty state renders the explainer and the Key field', async ({ page }) => {
		await expect(page.getByText(/New features ship in an early-access window/)).toBeVisible();
		await expect(keyInput(page)).toBeVisible();
		// The eyebrow follows the fork's theme conventions, not sona.fast marketing
		// chrome: no "//" slash prefix (that device belongs to the marketing site).
		const eyebrow = page.locator('.key-eyebrow').first();
		await expect(eyebrow).toBeVisible();
		await expect(eyebrow).not.toContainText('//');
	});

	test('a garbage key shows the invalid error with the correct aria wiring', async ({ page }) => {
		await keyInput(page).fill('not-a-real-key');
		await saveButton(page).click();

		await expect(fieldError(page)).toHaveText(
			/That key didn't validate — make sure you copied the whole thing\./
		);
		// The aria-wiring the test gate demanded: the input points screen readers at
		// the just-rendered error via aria-describedby, and marks itself invalid.
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
		await expect(keyInput(page)).toHaveAttribute('aria-describedby', 'supporter-key-error');
	});

	test('a real-signature-but-expired key shows the distinct expired error', async ({ page }) => {
		await keyInput(page).fill(EXPIRED_TOKEN);
		await saveButton(page).click();

		// Distinct from the invalid copy — proves the signature verified against the
		// baked public key (reached the expiry check, not bad-signature).
		await expect(fieldError(page)).toHaveText(/That key expired .* re-mint at sona\.fast\/supporter-key\./);
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
	});
});
