import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Instagram site-social flow (SONA-117): a bare handle typed into the admin
// settings Instagram field is normalized server-side to the canonical
// https://www.instagram.com/<handle> URL and shows up as a /connect link row.
// Mutates the shared DB's instagramUrl (unset in the seed) — no other spec
// asserts on the social links, so this doesn't race them.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

test.describe('instagram site social', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings'); // opens on the "site" tab
	});

	test('a bare handle saved in settings renders an Instagram row on /connect', async ({ page }) => {
		// Submit only once the page has hydrated: before hydration the form is a
		// plain POST and the browser navigates away. The tab switch is a client
		// handler, so it only works once hydrated — retry it as the hydration gate
		// (same idiom as palette-settings.spec.ts / legal.spec.ts).
		await expect(async () => {
			await page.getByRole('button', { name: 'Storage', exact: true }).click();
			await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
		}).toPass();
		await page.getByRole('button', { name: 'Site', exact: true }).click();

		await page.fill('input[name="instagram"]', 'taro');
		// The action normalizes and writes the setting server-side before
		// returning, so once the POST resolves the URL is persisted.
		const [resp] = await Promise.all([
			page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('/admin/settings')
			),
			page.getByRole('button', { name: 'Save site settings' }).click()
		]);
		expect(resp.ok()).toBeTruthy();

		await page.goto('/connect');
		const row = page.locator('a.link-row[href="https://www.instagram.com/taro"]');
		await expect(row).toBeVisible();
		await expect(row).toContainText('Instagram');
		await expect(row).toContainText('@taro');
	});
});
