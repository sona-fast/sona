import { test, expect } from '@playwright/test';
import { gotoAfterLogin, loginRetrying } from './admin-login';

// Poster fallback: an avatar with no poster image stands in its first showcase
// IMAGE wherever the poster would render — the /vr card, the /admin/vr
// thumbnail, and the detail page's opening frame (before "View in 3D"). The
// seeded avatar 6 (tests/e2e/fixtures/seed.sql) leads its media with a clip so
// each surface also proves the fallback skips videos; avatar 7 is its NSFW twin
// for the mature gate. Read-only on the shared server, like vr-avatar.spec.ts.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
const SHOT = /vr-media-posterless-shot\.png/;
const MATURE_SHOT = /vr-media-posterless-mature-shot\.png/;

test('/vr card shows the first showcase image in place of a missing poster', async ({ page }) => {
	await page.goto('/vr');

	const card = page.getByRole('link', { name: /E2E Posterless Avatar/ });
	await expect(card.locator('.poster img')).toHaveAttribute('src', SHOT);
	await expect(card.locator('.poster-placeholder')).toHaveCount(0);
});

test('detail page opens on the first showcase image, with no empty poster thumb', async ({ page }) => {
	await page.goto('/vr/e2e-posterless');

	// The main frame holds the image, not the placeholder glyph…
	const frame = page.locator('.media-frame');
	await expect(frame.locator('img')).toHaveAttribute('src', SHOT);
	await expect(frame.locator('.poster-placeholder')).toHaveCount(0);

	// …the strip has no "Poster" button to select an empty frame with, and the
	// image thumb (media 2 — the clip is media 1) is the current one.
	await expect(page.getByRole('button', { name: 'Poster', exact: true })).toHaveCount(0);
	const imageThumb = page.getByRole('button', { name: 'E2E Posterless Avatar — media 2' });
	await expect(imageThumb).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('button', { name: 'E2E Posterless Avatar — media 1' })).toHaveAttribute(
		'aria-current',
		'false'
	);

	// Selecting the clip still swaps the frame — the fallback is a starting
	// point, not a lock. The click is retried inside the loop (never the
	// goto): on a cold dev server the first click can land before hydration.
	await expect(async () => {
		await page.getByRole('button', { name: 'E2E Posterless Avatar — media 1' }).click();
		await expect(frame.locator('video')).toHaveCount(1, { timeout: 1_000 });
	}).toPass();
	await expect(frame.locator('img')).toHaveCount(0);
});

test('detail page link preview is the showcase image when there is no poster', async ({ page }) => {
	await page.goto('/vr/e2e-posterless');

	// social-image.ts may rewrite the URL through the image transform, so match
	// the filename, not the whole string.
	await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', SHOT);
	await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '900');
	await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '700');
});

test('NSFW posterless avatar blurs the showcase image under the mature gate', async ({ page }) => {
	await page.goto('/vr');
	const card = page.getByRole('link', { name: /E2E Posterless Mature/ });
	await expect(card.locator('img.blurred')).toHaveAttribute('src', MATURE_SHOT);
	await expect(card.locator('.mature-chip')).toBeVisible();

	await page.goto('/vr/e2e-posterless-mature');
	// Link unfurlers skip the mature gate, so the fallback must not hand them
	// the showcase image: no preview image, and the small card.
	await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
	await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(0);
	await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary');
	const frame = page.locator('.media-frame');
	const stand = frame.locator('.nsfw-overlay img.blurred');
	await expect(stand).toHaveAttribute('src', MATURE_SHOT);
	await expect(stand).toHaveCSS('filter', 'blur(32px)');
	// Its image has no stored dimensions: the frame reserves a 4 / 3 box until
	// the image loads, then takes the image's own ratio (the auto form).
	await expect(stand).toHaveCSS('aspect-ratio', 'auto 4 / 3');
	await expect(frame.locator('.poster-placeholder')).toHaveCount(0);
	// Nothing in the frame shows the image unblurred before the reveal.
	await expect(frame.locator('img:not(.blurred)')).toHaveCount(0);

	// Retried like the clip click above: the first click can land before hydration.
	await expect(async () => {
		await page.getByRole('button', { name: /Show avatar/ }).click();
		await expect(frame.locator('.nsfw-overlay')).toHaveCount(0, { timeout: 1_000 });
	}).toPass();
	const shown = frame.locator('img');
	await expect(shown).toHaveCount(1);
	await expect(shown).toHaveAttribute('src', MATURE_SHOT);
	await expect(shown).toHaveCSS('filter', 'none');
	await expect(shown).toHaveCSS('aspect-ratio', 'auto 4 / 3');
});

test('detail page with a real poster keeps its Poster thumb (fallback stays off)', async ({ page }) => {
	await page.goto('/vr/e2e-avatar');

	// Its link preview is still the poster (image 1), not showcase media.
	await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /parentpiece\.png/);

	await expect(page.getByRole('button', { name: 'Poster', exact: true })).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('button', { name: 'E2E VR Avatar — media 1' })).toHaveAttribute(
		'aria-current',
		'false'
	);
});

test('/admin/vr thumbnail shows the first showcase image for a posterless avatar', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/vr');

	const row = page.getByRole('row', { name: /E2E Posterless Avatar/ });
	await expect(row.locator('.poster-thumb img')).toHaveAttribute('src', SHOT);
});
