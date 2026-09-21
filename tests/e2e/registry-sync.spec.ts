import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adminLogin } from './admin-login';
import { E2E_REGISTRY_SCENARIO } from './paths';

// The admin "Sync now" toast, driven in a real browser (sona#447 follow-up).
//
// The unit suite covers both ends of this flow: the syncNow action's payload
// (page.server.test.ts) and the toast assembly from that payload
// (sync-toast-view.test.ts). What only a browser can prove is that the two shapes
// line up: the action returns counts and reasons, the enhance callback hands them
// to the view module, and the words on screen are the ones the operator needs.
//
// The registry is answered by tests/e2e/registry-mock.mjs, preloaded into this
// spec's dedicated dev server (playwright.config.ts). Each test writes the
// scenario file that interceptor reads on every request, so one server serves
// all four registry moods. The scenarios drive the DELTA feed: that is what a
// zone rule blocked on 2026-09-17, and it needs no seeded artists (the seed has
// no unlinked artists with handles, so the backfill search never runs here).
//
// Serial by config (workers: 1): the tests share the scenario file.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';

type Answer = {
	status: number;
	json?: unknown;
	html?: boolean;
	mitigated?: string;
	ray?: string;
};

function setRegistry(scenario: { delta?: Answer; search?: Answer }) {
	mkdirSync(path.dirname(E2E_REGISTRY_SCENARIO), { recursive: true });
	writeFileSync(E2E_REGISTRY_SCENARIO, JSON.stringify(scenario));
}

const syncButton = (page: Page) => page.locator('form[action="?/syncNow"] button[type="submit"]');
// Toasts stack; the one this click raised is the newest.
const toast = (page: Page) => page.locator('.toaster .alert-message').last();

// The connections sections are hidden by CSS until the tab is active, and the
// tab toggle is client JS, so a tab click that "takes" proves the page has
// hydrated (the fuzzysearch-key spec's shape). Sync now is hydration-sensitive
// the same way: a click that lands before use:enhance is attached posts the form
// natively, the page reloads on the Site tab, and no toast ever appears. So the
// whole sequence retries from a fresh load until the enhanced path answers with
// a toast. (A retry that posted natively ran a sync against the throwaway DB,
// which is harmless: the scenario file still says what the registry answers.)
async function syncNow(page: Page) {
	test.setTimeout(120_000);
	await expect(async () => {
		await page.goto('/admin/settings');
		await expect(async () => {
			await page.getByRole('tab', { name: 'Connections', exact: true }).click();
			await expect(syncButton(page)).toBeVisible({ timeout: 1500 });
		}).toPass();
		await syncButton(page).click();
		await expect(toast(page)).toBeVisible({ timeout: 10_000 });
	}).toPass({ timeout: 90_000 });
	return toast(page);
}

test.describe('admin Sync now toast', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page, PASSWORD);
	});

	// The 2026-09-17 shape: a zone bot rule answered the delta feed with an HTML
	// challenge page. Before sona#447 this toast told the operator to check a fork
	// key that was fine.
	test('a challenge page in front of the registry names the block, not the key', async ({
		page
	}) => {
		setRegistry({
			delta: { status: 403, html: true, mitigated: 'challenge', ray: 'a3e7bc522cbfa3c2-SEA' }
		});

		const t = await syncNow(page);
		await expect(t).toContainText("Couldn't reach the shared registry");
		await expect(t).toContainText('blocked by a Cloudflare challenge');
		await expect(t).not.toContainText("refused this site's key");
	});

	test('a refused fork key says so, with the registry\'s own reason', async ({ page }) => {
		setRegistry({ delta: { status: 401, json: { error: 'invalid fork key' } } });

		const t = await syncNow(page);
		await expect(t).toContainText("refused this site's key");
		await expect(t).toContainText('invalid fork key');
		await expect(t).not.toContainText("Couldn't reach");
	});

	test('a healthy registry reports the counts and nothing else', async ({ page }) => {
		setRegistry({});

		const t = await syncNow(page);
		await expect(t).toHaveText('Sync complete: 0 refreshed, 0 newly linked.');
	});

	test('a failed delta page is reported as a degraded run', async ({ page }) => {
		setRegistry({ delta: { status: 503, json: { error: 'registry down' } } });

		const t = await syncNow(page);
		await expect(t).toContainText('Sync complete: 0 refreshed, 0 newly linked.');
		await expect(t).toContainText('1 registry call failed this run, so these counts are incomplete.');
	});

	test('a rate-limited delta page is reported as back-pressure, not a failure', async ({
		page
	}) => {
		setRegistry({ delta: { status: 429, json: { error: 'rate limited — slow down' } } });

		const t = await syncNow(page);
		await expect(t).toContainText('Sync complete: 0 refreshed, 0 newly linked.');
		await expect(t).toContainText('1 registry call was rate limited this run and did not complete.');
		await expect(t).not.toContainText('registry call failed');
	});
});
