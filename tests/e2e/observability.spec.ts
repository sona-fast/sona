import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Regression spec for #193: the visitor percentage bars on /admin/observability
// rendered as empty grey tracks because the fill elements are inline <span>s,
// which ignore the inline width:{share}% — the fills collapsed to a zero-size
// box and never painted. The seed plants Tier-A metric_rollup counters (dated
// today) so every bar list renders. The referrer and country bar lists reuse
// the same .barfill class/rule, so the top-pages assertion covers them
// transitively.
//
// Assertions are deliberately loose: OBSERVABILITY_ENABLED is on for the shared
// e2e server, so the other specs' own page loads also roll up into the shared
// DB and the exact shares drift run to run. The regression collapses a fill to
// a 0×0 box, so "occupies real space inside its track" is both stable and
// mutation-proof — exact percentages are not asserted.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

async function expectFillPaints(page: Page, fillSel: string, trackSel: string) {
	const fill = page.locator(fillSel).first();
	await expect(fill).toBeVisible();
	const fillBox = await fill.boundingBox();
	const trackBox = await page.locator(trackSel).first().boundingBox();
	expect(fillBox).not.toBeNull();
	expect(trackBox).not.toBeNull();
	// A painted fill has real extent (the top-ranked row's share is never ~0%)
	// and fills its track's height; the inline-span regression yields 0×0.
	expect(fillBox!.width).toBeGreaterThan(2);
	expect(fillBox!.width).toBeLessThanOrEqual(trackBox!.width + 1);
	expect(fillBox!.height).toBeGreaterThanOrEqual(trackBox!.height - 1);
}

test.describe('admin observability visitor bars', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/observability');
	});

	test('top-pages bar fills paint with a visible width', async ({ page }) => {
		await expectFillPaints(page, '.barfill', '.bartrack');
	});

	test('device-split fills paint with a visible width', async ({ page }) => {
		await expectFillPaints(page, '.devrow .dfill', '.devrow .dtrack');
	});

	// Guards the OPPOSITE regression of #193: if the inline style="width:{share}%"
	// binding is ever lost, a display:block fill defaults to 100% of its track and
	// the paint checks above stay green while every bar renders full. The device
	// split gives a drift-proof inequality: the suite only ever browses with
	// Desktop Chrome, so live traffic can only grow the desktop counter — the
	// seeded desktop(20) > tablet(5) gap widens, never closes. Both regression
	// directions fail this: all-100% makes the widths equal; 0×0 makes both zero.
	test('device-split fill widths track their shares (desktop > tablet)', async ({ page }) => {
		const fills = page.locator('.devrow .dfill');
		const desktopBox = await fills.nth(0).boundingBox();
		const tabletBox = await fills.nth(2).boundingBox();
		expect(desktopBox).not.toBeNull();
		expect(tabletBox).not.toBeNull();
		expect(desktopBox!.width).toBeGreaterThan(tabletBox!.width + 2);
	});
});
