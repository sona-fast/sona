import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// SONA-148: the global `img { max-width: 100% }` + border-box reset clamp the
// ArtistAvatar <img> to the avatar column's 24px content box whenever every
// rendered row has an image avatar (a monogram <span> row props the column
// open, which is why rosters with avatar-less artists mask the bug). Filtering
// to the seeded 'Avatar Artist' renders exactly that monogram-free table, and
// the avatar must still be its full square size, not a 24x36 ellipse.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('artist avatars stay square in a monogram-free admin table', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/artists?q=Avatar');

	const row = page.getByRole('row', { name: /Avatar Artist/ });
	await expect(row).toBeVisible();

	// The bug only reproduces in a monogram-free table (a monogram span props
	// the column open) — assert that precondition so a seed change can't turn
	// this spec into a tautology.
	await expect(page.locator('table .monogram')).toHaveCount(0);

	// The image avatar, not the monogram span — if the seeded avatar URL ever
	// stops loading, ArtistAvatar falls back to the monogram and this locator
	// fails loudly instead of green-lighting the wrong element.
	const avatar = row.locator('img.avatar');
	await expect(avatar).toBeVisible();

	// loading="lazy" means visibility alone doesn't prove the image LOADED — a
	// 404ing fixture could still measure 36x36 before onerror swaps in the
	// monogram. complete alone isn't enough either (true for failed loads), so
	// also require real decoded pixels.
	await expect(avatar).toHaveJSProperty('complete', true);
	expect(await avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

	// Geometry-independent guard: fails if the max-width opt-out is removed, even
	// if the column width or cell padding change the squish arithmetic later.
	await expect(avatar).toHaveCSS('max-width', 'none');

	const box = await avatar.boundingBox();
	// Not dead: boundingBox() returns null for an attached-but-hidden element.
	expect(box).not.toBeNull();
	// Rendered at size={36}; the bug squishes width to 24 while height stays 36.
	expect(box!.width).toBe(36);
	expect(box!.height).toBe(36);

	// Rider changes on the same component: deferred loading attributes (avatars
	// are never LCP) and the hairline silhouette ring (an outline — an inset
	// box-shadow would be painted over by the image).
	await expect(avatar).toHaveAttribute('loading', 'lazy');
	await expect(avatar).toHaveAttribute('decoding', 'async');
	await expect(avatar).toHaveCSS('outline-width', '1px');
	await expect(avatar).toHaveCSS('outline-offset', '-1px');
});
