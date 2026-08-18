import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// E2E coverage for the /privacy + /terms legal pages (and their footer / mobile
// discoverability). Runs against the shared read-only seed (siteName
// "E2E Test Gallery", no legal overrides set) unless a test sets an override.
//
// Serial: the override test mutates the privacyPolicy setting on the shared DB,
// which would race the default-rendering assertions under fullyParallel.
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'e2e-admin-password'; // legacy ADMIN_PASSWORD login path (see seed.sql)

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

// The three saveSite-submitting tests in this file share one dance: wait for
// hydration (a client-only tab switch is the gate), return to the Site tab,
// then POST and assert the response. Hydration matters because an unhydrated
// form does a real navigation, which aborts the goto that follows.
async function openSiteTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Storage', exact: true }).click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
	await page.getByRole('tab', { name: 'Site', exact: true }).click();
}

async function saveSiteSettings(page: Page) {
	const [resp] = await Promise.all([
		page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/admin/settings')
		),
		page.getByRole('button', { name: 'Save site settings' }).click()
	]);
	expect(resp.ok()).toBeTruthy();
}

test('default legal pages render and are reachable from the footer', async ({ page }) => {
	// Defaults render (no override seeded).
	await page.goto('/privacy');
	await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Your privacy rights' })).toBeVisible();
	// CCPA/CPRA notice is part of the default baseline. Scoped to the rights
	// paragraph: the DNT/GPC section names the Act too, so a bare match on it
	// resolves to two paragraphs and trips strict mode.
	await expect(
		page.getByText(/Depending on where you live.*California Consumer Privacy Act/)
	).toBeVisible();
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

	// Submit only once the page has hydrated. Before hydration the form is a plain
	// POST, so the browser navigates to /admin/settings?/saveSite and the goto below
	// aborts with "interrupted by another navigation" — awaiting the POST response
	// does not help, because the response arrives mid-navigation. Hydrated, SvelteKit
	// submits via fetch and no navigation happens at all. The tab switch is a client
	// handler, so it only works once hydrated; retry it as the hydration gate (same
	// idiom as palette-settings.spec.ts). This branch's third e2e webServer widens
	// the hydration window past the nudge loop's 5s cap below, so gate first.
	await expect(async () => {
		await page.getByRole('tab', { name: 'Storage', exact: true }).click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
	await page.getByRole('tab', { name: 'Site', exact: true }).click();

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
	}).toPass({ timeout: 5000 });
	await contactEmail.fill(''); // restore empty so the save below doesn't persist it
	await expect(contactEmail).toHaveValue('');
	await expect(page.getByText(/Set a monitored contact email/)).toBeVisible();
	await page.fill('textarea[name="privacyPolicy"]', override);
	// The action writes the setting server-side before returning, so once the POST
	// resolves the override is persisted.
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

// --- /ai disclosure page (SONA-167) -----------------------------------------
// Same shape as the legal cases above: it lives in this spec because it also
// submits the saveSite form, and this is the only spec permitted to do that
// (serial mode; a parallel spec would clobber the shared seeded DB).

test('the AI disclosure page renders and is reachable from the footer', async ({ page }) => {
	await page.goto('/ai');
	await expect(page.getByRole('heading', { level: 1, name: 'AI and this site' })).toBeVisible();
	// The five disclosure topics are real headings, so the outline is navigable.
	await expect(page.getByRole('heading', { name: 'The software.' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'The art.' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Your data.' })).toBeVisible();

	// The security section renders too, with a clickable reporting contact
	// (SONA-171): the section only exists in this route's template, so nothing
	// else catches its deletion end to end.
	await expect(page.getByRole('heading', { name: 'Security problems.' })).toBeVisible();
	await expect(page.locator('a[href="mailto:security@sona.fast"]')).toBeVisible();
	// By role AND name: pins the rendered accessible name (the aria-label),
	// which the source-pin test can't see — dropping ariaLabel from the data
	// would otherwise leave every suite green.
	await expect(
		page.getByRole('link', { name: 'Report a vulnerability through GitHub' })
	).toBeVisible();

	// Reachable from any public page's footer.
	await page.goto('/');
	await page.locator('.footer .legal-links a[href="/ai"]').click();
	await expect(page).toHaveURL(/\/ai$/);
});

test('security.txt serves machine-readable contacts through the real app stack', async ({
	request
}) => {
	// The unit test drives GET() directly; this proves the route survives the
	// hooks chain (setup gate + theme-read exemptions, SONA-171 r1-07).
	const res = await request.get('/.well-known/security.txt');
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toContain('text/plain');
	expect(await res.text()).toMatch(/^Contact: /m);
});

test('the AI page is reachable on mobile (desktop footer hidden < 768px)', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	// Below the breakpoint the desktop footer is display:none and MobileCredit
	// carries the legal links — including /ai, or phone visitors could never
	// reach the disclosure at all.
	await expect(page.locator('.footer')).toBeHidden();
	const aiLink = page.locator('.mobile-credit .legal-links a[href="/ai"]');
	await expect(aiLink).toBeVisible();
	await aiLink.click();
	await expect(page.getByRole('heading', { level: 1, name: 'AI and this site' })).toBeVisible();
});

test('an owner override replaces the AI page defaults and the toggle removes the page', async ({
	page
}) => {
	const override = "My own words.\n\nSecond paragraph <script>window.__aiXssRan = true</script>";

	await login(page);
	await page.goto('/admin/settings');

	await openSiteTab(page);
	await page.fill('textarea[name="aiPageText"]', override);
	await saveSiteSettings(page);

	page.on('dialog', async (d) => {
		await d.dismiss();
		throw new Error('AI page override executed as HTML — XSS');
	});

	await page.goto('/ai');
	await expect(page.getByText('My own words.')).toBeVisible();
	// The default copy is gone.
	await expect(page.getByRole('heading', { name: 'The software.' })).toHaveCount(0);
	// The <script> renders as literal text and never runs.
	await expect(
		page.getByText('<script>window.__aiXssRan = true</script>', { exact: false })
	).toBeVisible();
	expect(
		await page.evaluate(() => (window as unknown as { __aiXssRan?: boolean }).__aiXssRan)
	).toBeUndefined();
	await expect(page.locator('.ai-page .ai-override')).toHaveCount(2);

	// Turning the page off removes BOTH the footer link and the route itself —
	// the disclosure never lingers as an unlinked page.
	await page.goto('/admin/settings');
	await openSiteTab(page);
	await page.uncheck('input[name="aiPageEnabled"]');
	// Clear the privacy override the earlier case in this serial file left
	// behind, so the /privacy assertions below read the DEFAULT policy — which
	// is the only place the gated paragraph exists. Without this the page
	// renders that override and the assertions describe the wrong document.
	await page.fill('textarea[name="privacyPolicy"]', '');
	await saveSiteSettings(page);

	await page.goto('/');
	await expect(page.locator('.footer .legal-links a[href="/ai"]')).toHaveCount(0);
	const gone = await page.goto('/ai');
	expect(gone?.status()).toBe(404);

	// Declining the disclosure also drops the vendor names from the default
	// privacy policy, so the owner is not left publishing processors they may
	// not use. The category disclosure stays, because it still might be true.
	await page.goto('/privacy');
	await expect(page.getByText('CodeRabbit')).toHaveCount(0);
	await expect(page.getByText('Anthropic')).toHaveCount(0);
	await expect(page.getByText(/development or code-review tools/)).toBeVisible();
	await expect(page.getByText(/Resend/)).toBeVisible();
});

// SONA-183: the source pins can only see markup, so this asserts the computed
// accessible name and description, plus the for/id pairing that keeps the title
// clickable. Reads state only (no save), so it leaves the shared settings
// untouched — and it runs LAST because this file is serial: a flake here would
// otherwise skip the mutating cases above.
test('the AI toggle is named by its title and described by its hint', async ({ page }) => {
	await login(page);
	await page.goto('/admin/settings');
	await openSiteTab(page);

	const toggle = page.locator('input[name="aiPageEnabled"]');
	await expect(toggle).toHaveAccessibleName('Serve the AI disclosure page (/ai)');
	await expect(toggle).toHaveAccessibleDescription(/Read it before you leave this on/);

	// The only guard on the new for/id pairing: every other test drives the input
	// by selector, so a dropped `for` would go unnoticed.
	const before = await toggle.isChecked();
	await page.getByText('Serve the AI disclosure page (/ai)', { exact: true }).click();
	expect(await toggle.isChecked()).toBe(!before);
});

// The override/toggle cases above mutate settings on the shared seeded DB.
// Serial retries restart at the first test, which would then hit a 404 /ai and
// fail for the wrong reason, so put the fork back the way this file found it.
test.afterAll(async ({ browser }) => {
	const page = await browser.newPage();
	try {
		await login(page);
		await page.goto('/admin/settings');
		await openSiteTab(page);
		await page.fill('textarea[name="aiPageText"]', '');
		await page.fill('textarea[name="privacyPolicy"]', '');
		await page.check('input[name="aiPageEnabled"]');
		await saveSiteSettings(page);
	} finally {
		await page.close();
	}
});
