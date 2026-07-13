import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { E2E_RESEND_CAPTURE } from './paths';
import { adminLogin } from './admin-login';

// End-to-end password recovery: the hardened forgot → reset cookie-exchange
// flow (#74). The Resend send happens SERVER-SIDE, so Playwright's page.route
// can't see it; instead tests/e2e/resend-mock.mjs (preloaded into the dev server
// via NODE_OPTIONS, see playwright.config.ts) answers the send 200 and captures
// the emitted reset link to E2E_RESEND_CAPTURE, which this spec polls.
//
// This spec MUTATES shared admin state (it sets adminPasswordHash and deletes
// every session), so it runs serially. Note it shares one D1 with the other
// specs under fullyParallel — see the harness-gap note in the delivery report.

// $lib/config → RESET_TOKEN_COOKIE. Hardcoded here because the spec runs outside
// the SvelteKit bundle (no $lib alias), matching how the other specs hardcode
// their seeded constants.
const RESET_COOKIE = 'sona_reset_token';
// Matches the adminEmail seeded in tests/e2e/fixtures/seed.sql.
const ADMIN_EMAIL = 'admin@e2e.test';
const NEW_PASSWORD = 'new-e2e-password-123';

function capturedLinks(): string[] {
	if (!existsSync(E2E_RESEND_CAPTURE)) return [];
	return readFileSync(E2E_RESEND_CAPTURE, 'utf8').split('\n').filter(Boolean);
}

test.describe.configure({ mode: 'serial' });

test('forgot → reset cookie-exchange → login with new password, no token reuse', async ({
	page,
	context
}) => {
	const before = capturedLinks().length;

	// 1–2. Request a reset for the seeded admin email → generic confirmation
	// (same response whether or not the email matched — no enumeration).
	await page.goto('/admin/forgot');
	await page.fill('input[name="email"]', ADMIN_EMAIL);
	await page.click('button[type="submit"]');
	await expect(page.getByText(/a reset link is on its way/i)).toBeVisible();

	// The send is deferred off the response path (waitUntil), so poll the capture
	// file for the freshly emitted link rather than assuming it's already there.
	let link = '';
	await expect
		.poll(
			() => {
				const links = capturedLinks();
				if (links.length > before) link = links[links.length - 1];
				return links.length;
			},
			{ timeout: 15_000, message: 'reset email was never captured from the Resend send' }
		)
		.toBeGreaterThan(before);
	expect(link).toContain('/admin/reset?token=');

	// 3. Follow the emailed link. The load must move the token out of the URL into
	// an httpOnly cookie: a 303 to a CLEAN /admin/reset (no token param).
	const exchanges: { url: string; status: number; location?: string }[] = [];
	page.on('response', (r) =>
		exchanges.push({ url: r.url(), status: r.status(), location: r.headers()['location'] })
	);
	await page.goto(link);
	await expect(page).toHaveURL(/\/admin\/reset$/); // token gone from the address bar

	const exchange = exchanges.find((r) => r.url.includes('token='));
	expect(exchange?.status, 'the token URL should 303-redirect').toBe(303);
	expect(exchange?.location).toMatch(/\/admin\/reset$/);

	const setCookie = (await context.cookies()).find((c) => c.name === RESET_COOKIE);
	expect(setCookie, 'reset token cookie should be set').toBeTruthy();
	expect(setCookie?.httpOnly, 'reset token cookie must be httpOnly').toBe(true);

	// The clean page shows the new-password form (the cookie token validated).
	await expect(page.locator('input[name="password"]')).toBeVisible();

	// 4. Complete the reset → redirect to the login success target.
	await page.fill('input[name="password"]', NEW_PASSWORD);
	await page.fill('input[name="confirmPassword"]', NEW_PASSWORD);
	await page.click('button[type="submit"]');
	await expect(page).toHaveURL(/\/admin\/login\?reset=1/);

	// The token cookie is cleared on success.
	expect((await context.cookies()).find((c) => c.name === RESET_COOKIE)).toBeUndefined();

	// The new password actually works (the reset wrote adminPasswordHash). The
	// shared helper loads the login page cold and waits for the Turnstile widget to
	// auto-solve before submitting.
	await adminLogin(page, NEW_PASSWORD);

	// 5. The link can't be reused — the token row was consumed on success, so a
	// second visit (fresh session) lands on the invalid-link message.
	await context.clearCookies();
	await page.goto(link);
	await expect(page).toHaveURL(/\/admin\/reset$/);
	await expect(page.getByText(/This reset link is invalid or has expired/i)).toBeVisible();
	await expect(page.locator('input[name="password"]')).toHaveCount(0);
});
