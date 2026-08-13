import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// The UploadThing file-count stat ("UT Files") in the admin storage panel is
// guarded by `{#if showUtFileStat(data)}` — and the load populates data.utUsage
// whenever UPLOADTHING_TOKEN is present REGARDLESS of the active provider, so on a
// site that migrated UploadThing -> R2 the count is stale and only the provider
// clause hides it. Unit tests (ut-stat-gate.test.ts) guard the predicate's value
// and its single guarded call site, but they CANNOT catch someone adding a NEW
// unguarded render (a child component, a summary card, a tooltip) — only rendering
// the page and asserting absence closes that class. That is this spec's whole job.
//
// This spec runs against its own dev server + seeded DB with UPLOADTHING_TOKEN set
// and tests/e2e/uploadthing-mock.mjs preloaded (see playwright.config.ts): the
// mocked getUsageInfo() keeps data.utUsage non-null in BOTH provider states, so an
// absent stat under R2 proves the PROVIDER guard rather than a null-usage check.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

// The storage panel is gated behind a client-side tab (display:none until the
// onclick sets activeTab), so it only reveals once hydrated — retry the switch
// until the panel shows, like palette-settings.spec.ts.
async function openStorageTab(page: Page) {
	const tab = page.getByRole('tab', { name: 'Storage', exact: true });
	await expect(async () => {
		await tab.click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
}

// Select a storage provider via the real radio + save path, then wait for the save
// round-trip to land (the Provider stat reflects the choice). Each test sets its
// own precondition so it's robust to prior DB state (e.g. a CI retry after the R2
// test already flipped the shared seeded DB).
async function setProvider(page: Page, provider: 'uploadthing' | 'r2') {
	await openStorageTab(page);
	const radio = page.getByRole('radio', {
		name: provider === 'r2' ? /Cloudflare R2/ : /UploadThing/
	});
	await expect(async () => {
		// The radio input is visually hidden (opacity:0; pointer-events:none); a user
		// selects the provider by clicking its wrapping .provider-card label, so
		// click the label (the radio's parent) rather than the untargetable input.
		await radio.locator('..').click();
		await expect(radio).toBeChecked({ timeout: 1500 });
	}).toPass();
	await page.getByRole('button', { name: 'Save storage settings' }).click();
	const expected = provider === 'r2' ? 'Cloudflare R2' : 'UploadThing';
	// The Provider stat's value; its parent div also holds the "Provider" label.
	await expect(page.getByText('Provider', { exact: true }).locator('..')).toContainText(expected);
}

// The "UT Files" stat's label — present iff the guarded block renders.
const utFilesStat = (page: Page) => page.getByText('UT Files');

// The two tests share one seeded DB (one dev server); serial keeps the
// provider-mutating saves from racing under fullyParallel.
test.describe.configure({ mode: 'serial' });

test.describe('admin settings UploadThing file-count stat', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
	});

	test('renders the UT file count while UploadThing is the active provider', async ({ page }) => {
		await setProvider(page, 'uploadthing');
		await expect(utFilesStat(page)).toBeVisible();
		// The value comes from the mocked getUsageInfo() payload (filesUploaded: 4242).
		await expect(utFilesStat(page).locator('..')).toContainText('4242');
	});

	test('hides the stale UT file count after migrating to R2, keeping the leftover prompt', async ({
		page
	}) => {
		await setProvider(page, 'r2');
		// The stat's label is gone...
		await expect(utFilesStat(page)).toHaveCount(0);
		// ...and so is its VALUE anywhere on the page. This is the assertion the unit
		// tests structurally can't make: it catches ANY new unguarded render of the
		// count (e.g. a bare `{data.utUsage.filesUploaded}` in a card/tooltip), not
		// just the one guarded call site.
		await expect(page.getByText('4242')).toHaveCount(0);
		// utUsage is still non-null (token set + mocked) — the leftover prompt (which
		// needs non-null, non-zero UT usage) is still shown, proving the count was
		// hidden by the PROVIDER guard, not by usage going null.
		await expect(page.getByText(/UploadThing still holds/)).toBeVisible();
	});
});

// This server is the only e2e env WITHOUT OBSERVABILITY_ENABLED (see
// wrangler.e2e-uploadthing.toml), so the gate-off half of the ?tab= deep-link
// fallback (SONA-114) is asserted here; the gate-on cases live in
// settings-tabs.spec.ts. Read-only, so serial mode just appends it after the
// provider tests.
test.describe('admin settings ?tab=observability with the gate off', () => {
	test('falls back to the Site tab', async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings?tab=observability');

		await expect(page.locator('.settings-tabs')).toHaveAttribute('data-active-tab', 'site');
		// The gated tab button isn't offered either.
		await expect(page.getByRole('tab', { name: 'Observability' })).toHaveCount(0);
	});
});
