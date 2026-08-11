import { test, expect } from '@playwright/test';

// Nav content gating: the seed fixture (tests/e2e/fixtures/seed.sql) has ZERO
// sticker packs and ZERO collections but a published VR avatar, so the shared
// read-only server renders exactly the gated state — Stickers/Collections
// links out of the header and bottom nav, the VR pill in the gallery tab bar,
// while the gated sections' URLs keep serving their honest empty states.
//
// Runs on the SHARED DB/server under fullyParallel: read-only throughout.

test('desktop header hides the gated Stickers/Collections links but keeps Gallery and About', async ({
	page
}) => {
	await page.goto('/gallery');

	const nav = page.locator('.header nav');
	await expect(nav.locator('a[href="/gallery"]')).toBeVisible();
	await expect(nav.locator('a[href="/about"]')).toBeVisible();
	await expect(nav.locator('a[href="/stickers"]')).toHaveCount(0);
	await expect(nav.locator('a[href="/collections"]')).toHaveCount(0);
});

test('mobile bottom nav drops the Stickers tab (header hidden < 768px)', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');

	const mobileNav = page.locator('.mobile-nav');
	await expect(mobileNav).toBeVisible();
	await expect(mobileNav.locator('a[href="/gallery"]')).toBeVisible();
	await expect(mobileNav.locator('a[href="/about"]')).toBeVisible();
	await expect(mobileNav.locator('a[href="/stickers"]')).toHaveCount(0);
});

test('/gallery tab bar shows the VR pill (seeded published avatar) but no Stickers pill', async ({
	page
}) => {
	await page.goto('/gallery');

	const tabs = page.locator('.tabs[role="tablist"]');
	await expect(tabs).toBeVisible();
	await expect(tabs.locator('a[href="/vr"]')).toBeVisible();
	await expect(tabs.locator('a[href="/stickers"]')).toHaveCount(0);
});

test('the gated sections stay routable: /stickers and /collections return 200', async ({
	page
}) => {
	// Gating hides the nav entries only — typing the URL still renders the
	// section's honest empty state, never a 404.
	const stickers = await page.goto('/stickers');
	expect(stickers?.status()).toBe(200);
	const collections = await page.goto('/collections');
	expect(collections?.status()).toBe(200);
});
