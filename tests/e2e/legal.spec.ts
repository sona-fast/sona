import { test, expect, type Page } from '@playwright/test';

// E2E coverage for the /privacy + /terms legal pages (and their footer / mobile
// discoverability). Runs against the shared read-only seed (siteName
// "E2E Test Gallery", no legal overrides set) unless a test sets an override.
//
// Serial: the override test mutates the privacyPolicy setting on the shared DB,
// which would race the default-rendering assertions under fullyParallel.
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'e2e-admin-password'; // legacy ADMIN_PASSWORD login path (see seed.sql)

async function login(page: Page) {
	await page.goto('/admin/login');
	await page.fill('input[name="password"]', PASSWORD);
	await page.locator('input[name="password"]').press('Enter');
	await page.waitForURL(/\/admin\/images/);
}

test('default legal pages render and are reachable from the footer', async ({ page }) => {
	// Defaults render (no override seeded).
	await page.goto('/privacy');
	await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Your privacy rights' })).toBeVisible();
	// CCPA/CPRA notice is part of the default baseline.
	await expect(page.getByText(/California Consumer Privacy Act/)).toBeVisible();
	// "Last updated" renders from a stable source (the per-release defaults date),
	// not `new Date()` — so it's a fixed dotted date, present on the stock page.
	await expect(page.locator('.legal-updated')).toHaveText(/Last updated \d{4}\.\d{2}\.\d{2}/);

	await page.goto('/terms');
	await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Acceptance of these terms' })).toBeVisible();
	await expect(page.locator('.legal-updated')).toHaveText(/Last updated \d{4}\.\d{2}\.\d{2}/);

	// Desktop footer links navigate.
	await page.goto('/');
	await page.locator('.footer .legal-links a[href="/privacy"]').click();
	await expect(page).toHaveURL(/\/privacy$/);
	await page.goto('/');
	await page.locator('.footer .legal-links a[href="/terms"]').click();
	await expect(page).toHaveURL(/\/terms$/);
});

test('legal pages are reachable on mobile (footer hidden < 768px)', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	// Desktop footer is display:none at this width; the mobile credit carries the links.
	await expect(page.locator('.footer')).toBeHidden();
	const privacyLink = page.locator('.mobile-credit .legal-links a[href="/privacy"]');
	await privacyLink.scrollIntoViewIfNeeded();
	await expect(privacyLink).toBeVisible();
	await privacyLink.click();
	await expect(page).toHaveURL(/\/privacy$/);
});

test('an owner override replaces the defaults and is rendered as escaped text', async ({ page }) => {
	const override = "First paragraph.\n\nSecond paragraph <script>window.__xssRan = true</script>";

	await login(page);
	await page.goto('/admin/settings'); // opens on the "site" tab
	// The seed sets no contactEmail, so the "set a monitored contact email" nudge
	// shows next to the field — the CCPA rights channel prompt (item 2).
	await expect(page.getByText(/Set a monitored contact email/)).toBeVisible();
	// Re-drive the input until the reactive nudge responds. Filling as the first
	// post-load interaction races Svelte hydration: before the bound input's
	// oninput handler is wired, a keystroke sets the DOM value but not the
	// `contactEmail` $state, so the nudge — {#if !contactEmail?.trim()}, purely
	// client-side — never hides (and Svelte, seeing $state unchanged from its
	// initial empty value, never re-renders the input to clobber the DOM either).
	// toPass keeps re-filling until hydration lands and the binding is live, which
	// makes this deterministic instead of flaky. Nothing is persisted here.
	const contactEmail = page.locator('input[name="contactEmail"]');
	await expect(async () => {
		await contactEmail.fill('owner@example.com');
		await expect(page.getByText(/Set a monitored contact email/)).toBeHidden({ timeout: 500 });
	}).toPass();
	await contactEmail.fill(''); // restore empty so the save below doesn't persist it
	await expect(contactEmail).toHaveValue('');
	await expect(page.getByText(/Set a monitored contact email/)).toBeVisible();
	await page.fill('textarea[name="privacyPolicy"]', override);
	// The action writes the setting server-side before returning, so once the POST
	// resolves the override is persisted — more robust than racing the toast.
	const [resp] = await Promise.all([
		page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/admin/settings')
		),
		page.getByRole('button', { name: 'Save site settings' }).click()
	]);
	expect(resp.ok()).toBeTruthy();

	// Fail loudly if the override ever executes as HTML rather than rendering as text.
	page.on('dialog', async (d) => {
		await d.dismiss();
		throw new Error('override executed as HTML — XSS');
	});

	await page.goto('/privacy');
	// The override text shows; the default sections are gone.
	await expect(page.getByText('First paragraph.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Your privacy rights' })).toHaveCount(0);
	// The <script> is present as literal, escaped text — not executed.
	await expect(
		page.getByText("<script>window.__xssRan = true</script>", { exact: false })
	).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __xssRan?: boolean }).__xssRan)).toBeUndefined();
	// Split on the blank line into two paragraphs.
	await expect(page.locator('.legal-page .legal-override')).toHaveCount(2);

	// Saving the privacy override stamps privacyUpdatedAt, so the "Last updated"
	// line now reflects the save date (today) rather than the built-in defaults' date.
	const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
	await expect(page.locator('.legal-updated')).toHaveText(`Last updated ${today}`);
});
