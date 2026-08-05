import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Settings ?tab= deep links (SONA-114): the admin-wide key-expiry notice links
// to /admin/settings?tab=account, so the tab must resolve from the URL — no
// click, no hydration dependence (activeTab derives from the URL during SSR).
// Unknown values fall back to Site. The observability-gate-OFF fallback case
// lives in ut-stat.spec.ts, whose dedicated server is the only e2e env without
// OBSERVABILITY_ENABLED (this shared server has it on — see wrangler.e2e.toml).
//
// Read-only: no test here mutates the shared e2e DB.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

const activeTab = (page: Page) => page.locator('.settings-tabs');

test.describe('admin settings ?tab= deep links', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page, PASSWORD);
	});

	test('?tab=account lands on the Account tab without clicking', async ({ page }) => {
		await page.goto('/admin/settings?tab=account');

		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'account');
		// The Account panel's supporter-key field is actually visible, not just marked.
		await expect(page.locator('input[name="supporterKey"]')).toBeVisible();
	});

	test('?tab=bogus falls back to the Site tab', async ({ page }) => {
		await page.goto('/admin/settings?tab=bogus');

		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'site');
	});

	test('?tab=observability resolves while the gate is on', async ({ page }) => {
		// This server runs with OBSERVABILITY_ENABLED=true; the gate-off fallback
		// is asserted in ut-stat.spec.ts (and unit-tested in tabs.test.ts).
		await page.goto('/admin/settings?tab=observability');

		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'observability');
	});
});
