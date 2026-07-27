import { test, expect, type Page } from '@playwright/test';

// F3: the CSP set via kit.csp must contain XSS blast radius WITHOUT breaking the
// app. This drives public + admin pages and asserts the browser reports ZERO
// Content-Security-Policy violations (hydration, the app.html theme script,
// fonts, styles, images all load), and that the CSP + HSTS response headers are
// present and correctly shaped.

const PASSWORD = 'e2e-admin-password';

type Violation = { directive: string; blocked: string; source: string };

// Register a securitypolicyviolation listener that survives each navigation, and
// read+clear it after each page settles (window resets on navigation).
async function installCollector(page: Page) {
	await page.addInitScript(() => {
		(window as unknown as { __csp: Violation[] }).__csp = [];
		document.addEventListener('securitypolicyviolation', (e) => {
			(window as unknown as { __csp: Violation[] }).__csp.push({
				directive: e.violatedDirective,
				blocked: e.blockedURI,
				source: `${e.sourceFile}:${e.lineNumber}`
			});
		});
	});
}

async function drain(page: Page): Promise<Violation[]> {
	// Give hydration + async font/image loads a beat to fire any violation.
	await page.waitForLoadState('networkidle').catch(() => {});
	await page.waitForTimeout(400);
	return page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp ?? []);
}

test('no CSP violations across public + admin pages; CSP + HSTS headers present', async ({
	page
}) => {
	await installCollector(page);
	const all: Violation[] = [];
	const pageErrors: string[] = [];
	const badAssets: string[] = [];
	page.on('pageerror', (e) => pageErrors.push(e.message));
	page.on('response', (r) => {
		if (r.url().includes('/_app/') && r.status() >= 400) badAssets.push(`${r.status()} ${r.url()}`);
	});

	// Header assertions on a public SSR response.
	const resp = await page.goto('/gallery', { waitUntil: 'domcontentloaded' });
	const csp = resp?.headers()['content-security-policy'] ?? '';
	const hsts = resp?.headers()['strict-transport-security'] ?? '';
	expect(csp, 'CSP header present').toContain('script-src');
	// script-src must be locked: 'self' + hashes, never unsafe-inline.
	const scriptSrc = csp.split(';').find((dir) => dir.trim().startsWith('script-src ')) ?? '';
	expect(scriptSrc).toContain("'self'");
	expect(scriptSrc).not.toContain('unsafe-inline');
	expect(scriptSrc).toContain('sha256-');
	expect(csp).toContain("img-src 'self' https: data:");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("object-src 'none'");
	// This host only — no includeSubDomains (an operator's apex may serve unrelated
	// plain-HTTP subdomains) and no preload (irreversible). See hooks.server.ts.
	expect(hsts).toBe('max-age=31536000');

	all.push(...(await drain(page)));

	for (const url of ['/gallery/parent-piece', '/stickers', '/about']) {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		all.push(...(await drain(page)));
	}

	// Admin: login form, then the dashboard.
	await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
	all.push(...(await drain(page)));
	await page.fill('input[name="password"]', PASSWORD);
	// If the fork configured Turnstile, the submit button stays disabled until the
	// widget solves — click without waiting and this races it. Gate on the
	// SSR-rendered `.turnstile` container (present in the initial HTML whenever a
	// sitekey is set), NOT on the hidden response input, which turnstile.render()
	// injects only after api.js loads; a count() on that can run before it exists
	// and wrongly skip the wait. toHaveValue then auto-waits for it to populate.
	//
	// Deliberately inlined rather than importing tests/e2e/admin-login.ts: that
	// helper arrives with the Turnstile branch, and this spec has to pass on its
	// own branch too. Collapse the two onto the shared helper once both are on main.
	if (await page.locator('.turnstile').count()) {
		await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
			timeout: 15_000
		});
	}
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
	all.push(...(await drain(page)));

	// Confirm the client actually hydrated (so the hydration script-src path was
	// really exercised, not skipped): SvelteKit sets a __sveltekit_* global.
	const hydrated = await page.evaluate(() =>
		Object.keys(window).some((k) => k.startsWith('__sveltekit'))
	);

	if (all.length) console.error('CSP VIOLATIONS:', JSON.stringify(all, null, 2));
	if (pageErrors.length) console.error('PAGE ERRORS:', pageErrors);
	if (badAssets.length) console.error('FAILED _app ASSETS:', badAssets);
	expect(all, 'browser reported CSP violations').toEqual([]);
	expect(badAssets, 'client asset failed to load').toEqual([]);
	expect(pageErrors, 'uncaught page errors').toEqual([]);
	expect(hydrated, 'SvelteKit client hydrated').toBe(true);
});
