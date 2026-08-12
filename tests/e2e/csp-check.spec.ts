import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// F3: the CSP set via kit.csp must contain XSS blast radius WITHOUT breaking the
// app. This drives public + admin pages and asserts the browser reports ZERO
// Content-Security-Policy violations (hydration, the app.html theme script,
// fonts, styles, images all load), and that the CSP + HSTS response headers are
// present and correctly shaped.

const PASSWORD = 'e2e-admin-password';

type Violation = { directive: string; blocked: string; source: string };

// Register a securitypolicyviolation listener that survives each navigation and
// forwards every violation to NODE as it fires, returning the array it fills.
//
// Collecting outside the page is what makes this reliable. The previous version
// buffered violations in `window.__csp` and read them back with page.evaluate,
// which throws "Execution context was destroyed, most likely because of a
// navigation" whenever anything navigates during the read — a live flake on CI
// for a spec that performs six navigations and two logins (SONA-164). A Node
// array cannot be destroyed by a navigation, and nothing has to survive in page
// memory between the violation firing and the test reading it.
async function installCollector(page: Page): Promise<Violation[]> {
	const collected: Violation[] = [];
	await page.exposeFunction('__cspReport', (v: Violation) => {
		collected.push(v);
	});
	await page.addInitScript(() => {
		// Top document only. addInitScript runs in every frame, and the real
		// Turnstile widget renders a cross-origin challenge iframe whose own CSP
		// violations are Cloudflare's business, not this app's — the old
		// window-scoped collector ignored them for free because drain() only ever
		// evaluated in the main frame.
		if (window.top !== window) return;
		document.addEventListener('securitypolicyviolation', (e) => {
			(window as unknown as { __cspReport: (v: Violation) => void }).__cspReport({
				directive: e.violatedDirective,
				blocked: e.blockedURI,
				source: `${e.sourceFile}:${e.lineNumber}`
			});
		});
	});
	return collected;
}

async function drain(page: Page, collected: Violation[]): Promise<Violation[]> {
	// Give hydration + async font/image loads a beat to fire any violation.
	//
	// The timeout is load-bearing, not defensive. On /admin/login the Turnstile widget
	// keeps talking to challenges.cloudflare.com, so the page NEVER reaches networkidle
	// and an unbounded wait here hangs until the whole test times out. That is what
	// turned main's e2e red the moment the Turnstile keys landed in the e2e config
	// alongside this spec. Settling is a nice-to-have; not hanging is not.
	await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
	await page.waitForTimeout(400);
	// Take and clear: the Node array accumulates across navigations, where the old
	// per-window buffer was wiped by each one. Callers still get only what is new.
	return collected.splice(0);
}

test('no CSP violations across public + admin pages; CSP + HSTS headers present', async ({
	page
}) => {
	// Six navigations, two of them through a Turnstile solve that fetches api.js from
	// challenges.cloudflare.com. That overruns the default 30s budget on CI.
	test.slow();
	const collected = await installCollector(page);
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

	all.push(...(await drain(page, collected)));

	for (const url of ['/gallery/parent-piece', '/stickers', '/about', '/vr/e2e-avatar']) {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		all.push(...(await drain(page, collected)));
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
	// This navigation can abort under dev-server churn (net::ERR_ABORTED, seen as
	// a first-attempt CI flake on this exact goto). Retry that specific abort once
	// and confirm the page actually arrived, so a transient abort doesn't kill the
	// test before any CSP coverage has run.
	try {
		await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
	} catch (e) {
		if (!(e instanceof Error) || !e.message.includes('net::ERR_ABORTED')) throw e;
		await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
	}
	await expect(page).toHaveURL(/\/admin\/login/);
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
	all.push(...(await drain(page, collected)));
	await adminLogin(page, PASSWORD, { realTurnstile: true });
	all.push(...(await drain(page, collected)));

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

// Same shape as the blob:-image test above, for the OTHER blob: consumer: the VR
// viewer's textures load through fetch(), not <img>.
test('/vr pages can fetch() blob: and data: URLs, so GLTFLoader textures load', async ({
	page
}) => {
	// Proves the CSP served on the viewer page permits the fetch() loads that
	// GLTFLoader's texture pipeline depends on — blob: extraction and data:-URI
	// embeds (mechanism documented on connect-src in svelte.config.js) — with no
	// coupling to three.js internals or GPU availability in CI. When connect-src
	// was just 'self', these fetches failed and models rendered untextured.
	const resp = await page.goto('/vr/e2e-avatar', { waitUntil: 'domcontentloaded' });
	// SvelteKit serves the same CSP on its 404 page, so without this the fetch
	// probes below would still pass if the seed drifted and the page vanished.
	expect(resp?.status(), '/vr/e2e-avatar seeded and published').toBe(200);

	const directives = (resp?.headers()['content-security-policy'] ?? '').split(';');
	// Exact directive values, not substrings: a contains-check would still pass
	// with an extra network source appended, which is the regression the unit
	// gate's toEqual blocks at the config level — this pins the served header.
	// It also proves SvelteKit actually serializes worker-src (the unit gate
	// can only see the config object, not the emitted header).
	const connectSrc = directives.find((d) => d.trim().startsWith('connect-src'));
	expect(connectSrc?.trim(), 'connect-src on /vr/[slug]').toBe("connect-src 'self' blob: data:");
	const workerSrc = directives.find((d) => d.trim().startsWith('worker-src'));
	expect(workerSrc?.trim(), 'worker-src on /vr/[slug]').toBe("worker-src 'none'");

	const outcome = await page.evaluate(async () => {
		const url = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])]));
		try {
			const blobBuf = await (await fetch(url)).arrayBuffer();
			const dataBuf = await (
				await fetch('data:application/octet-stream;base64,AQID')
			).arrayBuffer();
			return `fetched ${blobBuf.byteLength}+${dataBuf.byteLength} bytes`;
		} catch (e) {
			return `blocked: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			URL.revokeObjectURL(url);
		}
	});

	// 'blocked: Failed to fetch' is what connect-src 'self' produced.
	expect(outcome, 'fetch(blob:) + fetch(data:) on the VR viewer page').toBe('fetched 3+3 bytes');
});
