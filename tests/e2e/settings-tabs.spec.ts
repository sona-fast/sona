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
		// The Account tab button itself is marked current for assistive tech…
		await expect(
			page.getByRole('button', { name: 'Account', exact: true })
		).toHaveAttribute('aria-current', 'true');
		// …and it's the only tab button carrying aria-current.
		await expect(activeTab(page).locator('button[aria-current]')).toHaveCount(1);
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

	test('clicking a tab overrides ?tab=, drops it from the URL, and the pick holds', async ({ page }) => {
		await page.goto('/admin/settings?tab=account');
		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'account');

		// The tab buttons are client JS, so the click only "takes" once hydrated —
		// retry click-until-active like supporter-key.spec.ts's openAccountTab.
		await expect(async () => {
			await page.getByRole('button', { name: 'Site', exact: true }).click();
			await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'site', { timeout: 1500 });
		}).toPass();
		// The manual pick shallow-drops the now-stale param (replaceState).
		await expect(page).not.toHaveURL(/[?&]tab=/);

		// A second click: manual control persists, still no ?tab= in the URL.
		await page.getByRole('button', { name: 'Storage', exact: true }).click();
		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'storage');
		await expect(page).not.toHaveURL(/[?&]tab=/);
	});

	test('a same-route client-side navigation to ?tab=account switches tabs', async ({ page }) => {
		await page.goto('/admin/settings');
		await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'site');

		// The admin-wide expiry notice links to ?tab=account from anywhere in the
		// admin area — including from /admin/settings itself, where SvelteKit
		// intercepts the anchor as a same-route client-side navigation. activeTab
		// derives reactively from the URL, so the tab must switch without a reload.
		// (The retry covers hydration: before it, the anchor is a full navigation,
		// which this test would also pass — the toPass loop settles on the
		// hydrated case.)
		await expect(async () => {
			await page.evaluate(() => {
				const a = document.createElement('a');
				a.href = '/admin/settings?tab=account';
				document.body.appendChild(a);
				a.click();
				a.remove();
			});
			await expect(activeTab(page)).toHaveAttribute('data-active-tab', 'account', { timeout: 1500 });
		}).toPass();
		await expect(page.locator('input[name="supporterKey"]')).toBeVisible();
	});
});
