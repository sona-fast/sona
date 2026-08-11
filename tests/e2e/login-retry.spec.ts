import { test, expect } from '@playwright/test';
import { stubTurnstile } from './admin-login';

// A failed login must be retryable on the SAME page. siteverify consumes the
// Turnstile token (single-use) before the password is even checked, so the login
// form's use:enhance callback calls turnstile.reset() after every submit — a
// wrong-password retry needs a fresh token or the submit button stays disabled.
// This drives that path through the stub (admin-login.ts): a changed
// e2e-stub-token value is proof reset() actually ran.
//
// Shared-server friendly: one failed attempt is well under the login throttle's
// 5-failures-per-15-min window (admin-auth.ts), and the successful login at the
// end resets the counter. No site settings are mutated.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('wrong password shows the error, re-issues the token, and a retry logs in', async ({
	page
}) => {
	await stubTurnstile(page);
	await page.goto('/admin/login');

	const tokenInput = page.locator('input[name="cf-turnstile-response"]');
	await expect(tokenInput).toHaveValue(/^e2e-stub-token-/, { timeout: 15_000 });
	const firstToken = await tokenInput.inputValue();

	await page.fill('input[name="password"]', 'not-the-password');
	await page.click('button[type="submit"]');

	// The action fails with 401 and use:enhance re-renders the error in place.
	await expect(page.locator('.error')).toHaveText('Invalid password');
	// use:enhance then called turnstile.reset(): a FRESH stub token replaced the
	// consumed one, and the submit button re-enabled off it.
	await expect(tokenInput).toHaveValue(/^e2e-stub-token-/);
	await expect(tokenInput).not.toHaveValue(firstToken);
	await expect(page.locator('button[type="submit"]')).toBeEnabled();

	// Retry on the same page with the right password: the fresh token clears
	// siteverify and the login lands.
	await page.fill('input[name="password"]', PASSWORD);
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
});
