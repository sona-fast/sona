import { expect, type Page } from '@playwright/test';

// Shared admin-login step for the E2E specs. The e2e env configures Turnstile
// with Cloudflare's always-pass TEST keys (see wrangler.e2e*.toml), so the login
// action ENFORCES a token. When the widget is configured we wait for it to
// auto-solve (the hidden `cf-turnstile-response` input gets a value) before
// submitting, so enforcement never races the widget. When Turnstile isn't
// configured (no widget) the wait is skipped and this is a plain password login.
//
// We gate on the SSR-rendered `.turnstile` container div, which is in the initial
// HTML whenever a sitekey is configured — NOT on the `cf-turnstile-response` input,
// which turnstile.render() injects client-side only after api.js loads async (a
// count() on it can run before it exists and wrongly skip the wait). toHaveValue
// then auto-waits for that input to appear and populate.
//
// NOTE: when a sitekey is configured these specs load
// challenges.cloudflare.com/turnstile/v0/api.js at runtime — a network-restricted
// CI without outbound access to challenges.cloudflare.com will hang this wait.
export async function adminLogin(page: Page, password: string) {
	await page.goto('/admin/login');
	await page.fill('input[name="password"]', password);
	if (await page.locator('.turnstile').count()) {
		await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
			timeout: 15_000
		});
	}
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
}
