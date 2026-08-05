import { test, expect } from '@playwright/test';

// Instagram site-social rendering (SONA-117): the seed fixture sets
// instagramUrl (https://www.instagram.com/taro), and these read-only assertions
// verify it surfaces on the public pages — the /connect link row, the /about
// social chip, and the footer icon. The admin save path (input name → action
// FormData key → normalization) is unit-covered by
// src/routes/admin/settings/page.server.test.ts, so this spec never submits
// ?/saveSite — which would race legal.spec.ts, since saveSite treats a
// present-but-blank field as a clear and each save would wipe the other
// spec's setting under fullyParallel.

test.describe('instagram site social', () => {
	test('the seeded Instagram URL renders a /connect link row', async ({ page }) => {
		await page.goto('/connect');
		const row = page.locator('a.link-row[href="https://www.instagram.com/taro"]');
		await expect(row).toBeVisible();
		await expect(row).toContainText('Instagram');
		await expect(row).toContainText('@taro');
	});

	test('the seeded Instagram URL renders an /about social chip', async ({ page }) => {
		await page.goto('/about');
		const chip = page.locator('a.social-item[href="https://www.instagram.com/taro"]');
		await expect(chip).toBeVisible();
		await expect(chip).toContainText('@taro');
		await expect(chip).toHaveAttribute('rel', 'noopener noreferrer');
	});

	test('the public footer renders an Instagram icon link', async ({ page }) => {
		// The footer lives in the (public) layout and is hidden below 768px; the
		// project's default Desktop Chrome viewport (1280x720) keeps it visible.
		// /about's social chip carries no aria-label, so this selector is unique.
		await page.goto('/about');
		const icon = page.locator('a[aria-label="Instagram"]');
		await expect(icon).toBeVisible();
		await expect(icon).toHaveAttribute('href', 'https://www.instagram.com/taro');
	});
});
