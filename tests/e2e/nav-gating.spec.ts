import { test, expect } from '@playwright/test';

// Nav content gating: the seed fixture (tests/e2e/fixtures/seed.sql) has ZERO
// sticker packs and ZERO collections but a published VR avatar, so the shared
// read-only server renders exactly the gated state — the Collections link out
// of the header, the VR pill in the gallery tab bar but no Stickers pill,
// while the gated sections' URLs keep serving their honest empty states.
// Stickers and VR are gallery tabs, never top-nav links, on any fork.
//
// Runs on the SHARED DB/server under fullyParallel: read-only throughout.

test('desktop header hides the gated Collections link, has no Stickers or VR link, and keeps Gallery and About', async ({
	page
}) => {
	await page.goto('/gallery');

	const nav = page.locator('.header nav');
	await expect(nav.locator('a[href="/gallery"]')).toBeVisible();
	await expect(nav.locator('a[href="/about"]')).toBeVisible();
	await expect(nav.locator('a[href="/stickers"]')).toHaveCount(0);
	await expect(nav.locator('a[href="/vr"]')).toHaveCount(0);
	await expect(nav.locator('a[href="/collections"]')).toHaveCount(0);
});

test('mobile bottom nav has no Stickers tab (header links hidden < 768px)', async ({ page }) => {
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

	const tabs = page.getByRole('navigation', { name: 'Gallery', exact: true });
	await expect(tabs).toBeVisible();
	await expect(tabs.locator('a[href="/vr"]')).toBeVisible();
	await expect(tabs.locator('a[href="/stickers"]')).toHaveCount(0);

	// The same bar heads /vr, and leaves the empty Stickers section out there too.
	await page.goto('/vr');
	await expect(tabs.getByRole('link')).toHaveText(['Artwork', 'VR Avatars']);
	await expect(tabs.locator('a[aria-current="page"]')).toHaveText('VR Avatars');
});

test('/stickers with no packs keeps its own tab, current, beside Artwork and VR', async ({ page }) => {
	// The empty section's own page still shows where the visitor is.
	await page.goto('/stickers');
	const tabs = page.getByRole('navigation', { name: 'Gallery', exact: true });
	await expect(tabs.getByRole('link')).toHaveText(['Artwork', 'Stickers', 'VR Avatars']);
	await expect(tabs.locator('a[aria-current="page"]')).toHaveText('Stickers');
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
