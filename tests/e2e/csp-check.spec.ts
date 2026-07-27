import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

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
	// Full directive, blob: included — a prefix match would still pass if blob: were
	// dropped, which is exactly the regression this spec now covers below.
	expect(csp).toContain("img-src 'self' https: data: blob:");
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

	// Admin: login form, then the dashboard. Both halves of the Turnstile change are
	// on main now, so this uses the shared helper rather than its own inlined wait.
	await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
	all.push(...(await drain(page)));
	await adminLogin(page, PASSWORD);
	all.push(...(await drain(page)));

	// /admin/upload is where CSP can do real damage rather than cosmetic damage, and
	// it is invisible to a plain page visit: the blob: URLs only exist once a file is
	// picked. So pick one. getImageDimensions() reads naturalWidth/naturalHeight off
	// an <img src=blob:…>; if img-src blocks blob: that <img> fires onerror, the
	// dimensions resolve to 0x0, and the form posts values the server stores as NULL.
	// Asserting the rendered dimensions — not just the violation count — is what makes
	// this a regression test for the metadata loss rather than for the missing preview.
	await page.goto('/admin/upload', { waitUntil: 'domcontentloaded' });
	all.push(...(await drain(page)));
	const onePixelPng = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64'
	);
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({ name: 'csp-probe.png', mimeType: 'image/png', buffer: onePixelPng });
	// 1x1 source, so real dimensions read back as "1 x 1"; a blocked blob: reads "0 x 0".
	await expect(page.locator('.tile-meta').first()).toContainText('1 x 1', { timeout: 10_000 });
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
