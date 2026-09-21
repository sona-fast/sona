import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginRetrying } from './admin-login';
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
// all five registry moods. The scenarios drive the DELTA feed: that is what a
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
	// Written whole, then renamed into place: the interceptor re-reads this file
	// on every request and treats an unparseable one as a healthy registry, so a
	// torn read would turn a failure scenario into a passing-looking success.
	const tmp = `${E2E_REGISTRY_SCENARIO}.tmp`;
	writeFileSync(tmp, JSON.stringify(scenario));
	renameSync(tmp, E2E_REGISTRY_SCENARIO);
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
//
// Returns the toast's TEXT, read once while it is on screen: a success toast
// dismisses itself after a few seconds, so asserting against the live locator
// afterwards would race that timer on a slow machine.
async function syncNow(page: Page): Promise<string> {
	let text = '';
	await expect(async () => {
		await page.goto('/admin/settings');
		await expect(async () => {
			await page.getByRole('tab', { name: 'Connections', exact: true }).click();
			await expect(syncButton(page)).toBeVisible({ timeout: 1500 });
			// Bounded, so a page that never hydrates hands control back to the outer
			// loop for a fresh load instead of spinning until the test deadline.
		}).toPass({ timeout: 15_000 });
		await syncButton(page).click();
		await expect(toast(page)).toBeVisible({ timeout: 10_000 });
		text = (await toast(page).textContent()) ?? '';
	}).toPass({ timeout: 90_000 });
	return text;
}

test.describe('admin Sync now toast', () => {
	// loginRetrying raises the per-test timeout itself, which also covers the
	// retry budget in syncNow: this is the ninth server to boot, and a cold login
	// on a loaded machine is the documented bounce every other serial spec hits.
	test.beforeEach(async ({ page }) => {
		await loginRetrying(page, PASSWORD);
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
		expect(t).toContain("Couldn't reach the shared registry");
		expect(t).toContain('blocked by a Cloudflare challenge');
		expect(t).not.toContain("refused this site's key");
	});

	test('a refused fork key says so, with the registry\'s own reason', async ({ page }) => {
		setRegistry({ delta: { status: 401, json: { error: 'invalid fork key' } } });

		const t = await syncNow(page);
		expect(t).toContain("refused this site's key");
		expect(t).toContain('invalid fork key');
		expect(t).not.toContain("Couldn't reach");
	});

	test('a healthy registry reports the counts and nothing else', async ({ page }) => {
		setRegistry({});

		const t = await syncNow(page);
		expect(t).toBe('Sync complete: 0 refreshed, 0 newly linked.');
	});

	test('a failed delta page is reported as a degraded run', async ({ page }) => {
		setRegistry({ delta: { status: 503, json: { error: 'registry down' } } });

		const t = await syncNow(page);
		expect(t).toContain('Sync complete: 0 refreshed, 0 newly linked.');
		expect(t).toContain('1 registry call failed this run, so these counts are incomplete.');
		expect(t).not.toContain('rate limited');
	});

	test('a rate-limited delta page is reported as back-pressure, not a failure', async ({
		page
	}) => {
		setRegistry({ delta: { status: 429, json: { error: 'rate limited — slow down' } } });

		const t = await syncNow(page);
		expect(t).toContain('Sync complete: 0 refreshed, 0 newly linked.');
		expect(t).toContain('1 registry call was rate limited this run and did not complete.');
		expect(t).not.toContain('registry call failed');
	});
});
