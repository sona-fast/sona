import { test, expect } from '@playwright/test';

// The ungated half of the nav content-gating rule, and the only end-to-end proof
// that a sticker pack renders at all.
//
// nav-gating.spec.ts covers the other half on the shared server, whose fixture
// deliberately has ZERO packs: that is what makes the header, the bottom nav and
// the gallery tab bar render their gated state. A published pack in that fixture
// would delete the coverage, so this spec gets its own seeded database and dev
// server, with tests/e2e/fixtures/stickers.sql layered on the shared fixture
// (see tests/e2e/paths.ts). One published pack, two SFW stickers, both credited
// to the seeded artist.
//
// Read-only throughout: no login, no writes, and the sticker image URLs are
// same-origin placeholders that 404 harmlessly, so nothing here touches the
// network or asserts pixels.

const PACK_SLUG = 'e2e-pack';
const PACK_NAME = 'E2E Sticker Pack';

test('/stickers lists the seeded pack', async ({ page }) => {
	await page.goto('/stickers');

	const card = page.locator('.pack-grid .pack-card');
	await expect(card).toHaveCount(1);
	await expect(card.locator('.pack-name-link')).toHaveText(PACK_NAME);
	await expect(card.locator(`a[href="/stickers/${PACK_SLUG}"]`).first()).toBeVisible();

	// The count comes from a grouped query over the stickers table, not from the
	// pack row, so it fails if the two stickers never attached to the pack.
	await expect(card.locator('.sticker-count')).toContainText('2');
});

test('the pack page shows both stickers', async ({ page }) => {
	await page.goto(`/stickers/${PACK_SLUG}`);

	await expect(page.getByRole('heading', { level: 1, name: PACK_NAME })).toBeVisible();
	await expect(page.locator('.sticker-grid .card')).toHaveCount(2);

	// Each card links to its own sticker detail route, so the grid is rendering
	// rows rather than repeating one.
	await expect(page.locator(`.sticker-grid a[href="/stickers/${PACK_SLUG}/1"]`)).toHaveCount(1);
	await expect(page.locator(`.sticker-grid a[href="/stickers/${PACK_SLUG}/2"]`)).toHaveCount(1);
});

test('the Stickers link is ungated once a published pack exists', async ({ page }) => {
	await page.goto('/gallery');

	// The twin of nav-gating.spec.ts, which asserts these are absent on a fork
	// with no packs. Same three places, opposite expectation.
	await expect(page.locator('.header nav a[href="/stickers"]')).toBeVisible();
	await expect(page.locator('.tabs[role="tablist"] a[href="/stickers"]')).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	await expect(page.locator('.mobile-nav a[href="/stickers"]')).toBeVisible();
});
