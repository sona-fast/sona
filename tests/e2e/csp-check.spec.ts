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
	//
	// The timeout is load-bearing, not defensive. On /admin/login the Turnstile widget
	// keeps talking to challenges.cloudflare.com, so the page NEVER reaches networkidle
	// and an unbounded wait here hangs until the whole test times out. That is what
	// turned main's e2e red the moment the Turnstile keys landed in the e2e config
	// alongside this spec. Settling is a nice-to-have; not hanging is not.
	await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
	await page.waitForTimeout(400);
	return page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp ?? []);
}

test('no CSP violations across public + admin pages; CSP + HSTS headers present', async ({
	page
}) => {
	// Six navigations, two of them through a Turnstile solve that fetches api.js from
	// challenges.cloudflare.com. That overruns the default 30s budget on CI.
	test.slow();
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

	// Admin: the login form itself, then the dashboard. Violations are collected per
	// page (window resets on navigation), so the login page must be drained BEFORE
	// logging in — the Turnstile widget lives there and is the most likely thing to
	// trip CSP. adminLogin navigates to /admin/login itself, so this loads that page
	// twice on purpose: once to inspect, once to log in through. Two widget solves,
	// each pulling api.js over the network, is most of why this test needs test.slow().
	// realTurnstile: this test is the ONE place the genuine widget runs — its
	// challenge iframe is the only RUNTIME coverage of the frame-src directive
	// (full rationale in admin-login.ts).
	await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
	// The challenge iframe must actually attach — otherwise the frame-src runtime
	// coverage passes vacuously when the widget silently fails to load. Checked via
	// page.frames(), not a DOM locator: the widget mounts its iframe inside a
	// CLOSED shadow root, which locators can't pierce. This poll deliberately ADDS
	// a real-network requirement to the FIRST login-page load (previously only the
	// second load had to solve) — an accepted cost: it is the anti-vacuity
	// guarantee for the one test that keeps the real widget.
	await expect
		.poll(
			() =>
				page.frames().some((f) => {
					try {
						return new URL(f.url()).hostname === 'challenges.cloudflare.com';
					} catch {
						return false;
					}
				}),
			{
				timeout: 15_000,
				message: 'real Turnstile challenge iframe never attached'
			}
		)
		.toBe(true);
	all.push(...(await drain(page)));
	await adminLogin(page, PASSWORD, { realTurnstile: true });
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

// Separate test, separate timeout budget: needs its own login, and asserts a runtime
// capability rather than counting violations.
test('/admin/upload can load a blob: image, so picked files keep their dimensions', async ({
	page
}) => {
	// Logs in through the Turnstile stub like every other spec (see admin-login.ts):
	// this test collects no CSP violations, so the real widget would buy nothing here.
	test.slow();

	// admin/upload mints blob: URLs from every picked file (+page.svelte:63 and :115):
	// the preview thumbnail, and an image element that getImageDimensions() reads
	// naturalWidth/naturalHeight from. When img-src omitted blob: — as it did on the
	// first CSP release — that element fired onerror, dimensions resolved to 0x0, and
	// the form posted width/height that +page.server.ts stored as NULL. The missing
	// thumbnail was cosmetic; the metadata loss was the real damage.
	//
	// This drives the capability directly instead of picking a file through the hidden
	// <input type=file>. It is deliberately narrower than a full upload: it proves the
	// CSP on this exact page permits the blob: image load that getImageDimensions
	// depends on, with no coupling to the upload page's internal markup or to the R2
	// binding. Drop blob: from img-src and this fails with 'onerror (blocked)'.
	await adminLogin(page, PASSWORD);
	const resp = await page.goto('/admin/upload', { waitUntil: 'domcontentloaded' });

	const imgSrc = (resp?.headers()['content-security-policy'] ?? '')
		.split(';')
		.find((d) => d.trim().startsWith('img-src'));
	expect(imgSrc, 'img-src on /admin/upload').toContain('blob:');

	const outcome = await page.evaluate(async () => {
		// 1x1 PNG, so a successful load reports 1x1 and a blocked one cannot fake it.
		const bytes = Uint8Array.from(
			atob(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
			),
			(c) => c.charCodeAt(0)
		);
		const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
		try {
			return await new Promise<string>((resolve) => {
				const img = new Image();
				img.onload = () => resolve(`${img.naturalWidth}x${img.naturalHeight}`);
				img.onerror = () => resolve('onerror (blocked)');
				setTimeout(() => resolve('timeout — neither handler fired'), 5000);
				img.src = url;
			});
		} finally {
			URL.revokeObjectURL(url);
		}
	});

	// Exactly what getImageDimensions() would read. '0x0' is what the bug produced.
	expect(outcome, 'blob: image load on /admin/upload').toBe('1x1');
});
