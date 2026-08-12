import { test, expect, type Page } from '@playwright/test';

// Fullscreen behavior of the 3D viewer (SONA-165). VrViewer.test.ts pins this
// wiring as SOURCE TEXT — the repo has no component runner — so a refactor that
// keeps the strings while breaking the state machine passes there. These specs
// drive the real thing in a browser instead.
//
// Both run against the seeded e2e-textured avatar (avatar 4), the only one
// whose R2 object is a real parseable VRM (tests/e2e/fixtures/e2e-textured.vrm)
// — the Fullscreen control only exists once a model has loaded. Read-only on
// the shared DB under fullyParallel: no form is ever submitted.
//
// Chromium implements the standard fullscreen API, so the first spec exercises
// the native path. The overlay fallback is what iPhone Safari gets (no element
// fullscreen API at all), and the second spec reaches it the only way a desktop
// browser can: by removing the API before the page's JS ever runs.
//
// SERIAL, and on deliberately small viewports: WebGL in CI comes from
// SwiftShader, which rasterizes on the CPU, so each live 3D context burns a
// core for the whole test. Running these two beside each other (and beside
// vr-render.spec.ts) under fullyParallel starved the workers and pushed
// timing-sensitive specs elsewhere in the suite over their budgets — measured,
// not theoretical: the full suite went red twice with these running in
// parallel and clean without them. One at a time, on a small canvas, it stays
// green.
test.describe.configure({ mode: 'serial' });

/** Enter 3D and wait for the stage: the click can land before hydration
 * attaches its listener (cold dev server), so retry until the viewer reacts.
 * Mirrors vr-render.spec.ts, which documented the same race. */
async function enter3d(page: Page) {
	const resp = await page.goto('/vr/e2e-textured', { waitUntil: 'domcontentloaded' });
	// A 404 means the seed drifted — fail before blaming the viewer.
	expect(resp?.status(), '/vr/e2e-textured seeded and published').toBe(200);

	await expect(async () => {
		if ((await page.locator('.loading-panel, .stage').count()) > 0) return;
		await page.getByRole('button', { name: 'View in 3D' }).click({ timeout: 2000 });
		await expect(page.locator('.loading-panel, .stage')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });

	// WebGL missing (SwiftShader flags dropped from playwright.config.ts) shows
	// this instead of ever loading — surface that as THE failure.
	await expect(
		page.locator('.webgl-fallback'),
		'WebGL unavailable — check the SwiftShader launch args in playwright.config.ts'
	).toHaveCount(0);
	await expect(page.locator('.stage canvas')).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('.load-error'), 'viewer error banner').toHaveCount(0);
}

test('native fullscreen: the wrapper goes fullscreen, the toggle relabels, and exiting restores the page', async ({
	page
}) => {
	// Cold dev servers transform three + three-vrm on first import; CI runners
	// rasterize on the CPU. Both overrun the default budget.
	test.slow();
	// Small viewport: every pixel of the fullscreen stage is CPU-rasterized.
	await page.setViewportSize({ width: 800, height: 600 });
	await enter3d(page);

	const toggle = page.getByRole('button', { name: 'Fullscreen', exact: true });
	await expect(toggle).toBeVisible();

	await toggle.click();

	// The fullscreen element is the WRAPPER, not the bare stage — the controls
	// must stay reachable inside it (a keyboard user otherwise has only Esc).
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const el = document.fullscreenElement;
					if (!el) return 'none';
					return el.classList.contains('viewer') ? 'viewer' : el.className;
				}),
			{ message: 'fullscreen element', timeout: 10_000 }
		)
		.toBe('viewer');

	// The relabelled toggle is the only visible cue which mode is active, and
	// both exits stay on screen.
	const exitFullscreen = page.getByRole('button', { name: 'Exit fullscreen' });
	await expect(exitFullscreen).toBeVisible();
	await expect(page.getByRole('button', { name: 'Exit 3D' })).toBeVisible();
	// The name carries the state, so there is no pressed-state attribute to
	// contradict it (dropping aria-pressed was the a11y resolution).
	await expect(exitFullscreen).not.toHaveAttribute('aria-pressed', /.*/);

	// The stage fills the fullscreen wrapper: taller than the inline 4:3-ish
	// stage was, and the renderer's canvas follows it.
	const stage = page.locator('.stage');
	const fullscreenBox = await stage.boundingBox();
	expect(fullscreenBox, 'stage measured in fullscreen').not.toBeNull();

	await exitFullscreen.click();

	await expect
		.poll(() => page.evaluate(() => document.fullscreenElement !== null), {
			message: 'fullscreen exited',
			timeout: 10_000
		})
		.toBe(false);
	// Back to the enter label, and the stage shrinks to its inline size again.
	await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
	const inlineBox = await stage.boundingBox();
	expect(inlineBox!.height, 'stage shrinks back out of fullscreen').toBeLessThan(
		fullscreenBox!.height
	);
});

test('overlay fallback (iPhone): covers the page, inerts and locks it, and Escape restores everything', async ({
	page
}) => {
	test.slow();

	// iPhone Safari exposes NO element fullscreen API. Deleting both variants
	// before any page script runs is the only way a desktop browser reaches the
	// fallback branch this spec exists for.
	await page.addInitScript(() => {
		// @ts-expect-error deliberately removing a standard API to emulate iOS
		delete Element.prototype.requestFullscreen;
		// @ts-expect-error the prefixed variant is iPadOS-only and equally absent
		delete Element.prototype.webkitRequestFullscreen;
	});
	// Phone viewport: the fallback's whole reason for existing.
	await page.setViewportSize({ width: 390, height: 844 });

	await enter3d(page);

	const viewer = page.locator('.viewer');
	await expect(viewer).not.toHaveClass(/fs-fallback/);
	const scrollLockBefore = await page.evaluate(() => document.documentElement.style.overflow);

	await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();

	// The overlay is a real full-viewport cover, not a resized card.
	await expect(viewer).toHaveClass(/fs-fallback/);
	await expect(viewer).toHaveCSS('position', 'fixed');
	const box = await viewer.boundingBox();
	expect(box!.width, 'overlay spans the viewport width').toBe(390);
	expect(box!.height, 'overlay spans the viewport height').toBe(844);

	// It must sit above every page layer — the toaster is the highest at 1000
	// (a toast painting over the exit controls would strand the user).
	const zIndex = await viewer.evaluate((el) => getComputedStyle(el).zIndex);
	expect(Number(zIndex), 'overlay clears the toaster layer (1000)').toBeGreaterThan(1000);

	// Page scroll is locked behind it…
	await expect
		.poll(() => page.evaluate(() => document.documentElement.style.overflow))
		.toBe('hidden');

	// …and the covered page leaves the tab AND screen-reader order: siblings on
	// the path from the viewer up to <body> are inert, while the viewer itself
	// (controls, live regions) never is.
	const inertCount = await page.evaluate(() => document.querySelectorAll('[inert]').length);
	expect(inertCount, 'page behind the overlay is inert').toBeGreaterThan(0);
	expect(
		await page.evaluate(() => document.querySelector('.viewer')!.closest('[inert]') !== null),
		'the viewer itself is never inert'
	).toBe(false);

	// The exit affordances are inside the overlay (the only ways out on a phone).
	await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Exit 3D' })).toBeVisible();

	// Escape is wired by hand here — native fullscreen gets it from the browser.
	await page.keyboard.press('Escape');

	await expect(viewer).not.toHaveClass(/fs-fallback/);
	// Everything the overlay touched is restored: scroll lock back to its
	// previous inline value, and not one element left inert.
	await expect
		.poll(() => page.evaluate(() => document.documentElement.style.overflow))
		.toBe(scrollLockBefore);
	expect(
		await page.evaluate(() => document.querySelectorAll('[inert]').length),
		'no inert left behind'
	).toBe(0);
	await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
	// The 3D view itself survives the overlay round trip.
	await expect(page.locator('.stage canvas')).toBeVisible();
});
