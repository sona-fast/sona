import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// VR avatar showcase (SONA-124): public visibility of the seeded avatars, the
// download route's server-side license enforcement, the click-to-load viewer
// button, and the admin section's early-access gate state.
//
// Runs on the SHARED read-only DB/server under fullyParallel: everything here
// only READS the seeded rows (tests/e2e/fixtures/seed.sql — avatars 1–3)
// and never submits a form, so it cannot perturb the other specs.
//
// WebGL is deliberately out of scope: the viewer is click-to-load, so the spec
// asserts the "View in 3D" control exists and is a real button — it never
// clicks it (headless WebGL is flaky and SONA-136 already covers the viewer).

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('public /vr lists the seeded published avatar', async ({ page }) => {
	await page.goto('/vr');

	// Published avatar is visible…
	await expect(page.getByRole('link', { name: /E2E VR Avatar/ })).toBeVisible();
	// …the unpublished draft is not.
	await expect(page.getByText('E2E VR Draft')).toHaveCount(0);
});

test('NSFW poster blurs its card on /vr while the clean card stays sharp', async ({ page }) => {
	await page.goto('/vr');

	// Avatar 3's own nsfw=0 but its poster (image 4) is NSFW: the inherited
	// flag must blur the poster and pin the mature chip on it…
	const matureCard = page.getByRole('link', { name: /E2E Mature Poster/ });
	await expect(matureCard.locator('img.blurred')).toBeVisible();
	await expect(matureCard.locator('.mature-chip')).toBeVisible();

	// …without leaking onto the clean avatar's card.
	const cleanCard = page.getByRole('link', { name: /E2E VR Avatar/ });
	await expect(cleanCard.locator('img')).toBeVisible();
	await expect(cleanCard.locator('img.blurred')).toHaveCount(0);
	await expect(cleanCard.locator('.mature-chip')).toHaveCount(0);
});

test('NSFW poster mature-gates the detail page and hides the 3D entry', async ({ page }) => {
	await page.goto('/vr/e2e-mature-poster');

	// Gate up: the overlay covers the frame with its reveal button, and the
	// 3D entry point does not exist yet (VrViewer nsfw prop).
	//
	// Fixture coupling: the toHaveCount(0) below is meaningful only because
	// avatar 3 shares avatar 1's model key (seed.sql) — a viewer WOULD mount
	// here if the gate were off, so its absence proves the gate, not an
	// unservable model. That key's servability is pinned by the "View in 3D"
	// test on /vr/e2e-avatar later in this file.
	const overlay = page.locator('.nsfw-overlay');
	await expect(overlay).toBeVisible();
	await expect(overlay.getByRole('button', { name: /Show avatar/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'View in 3D' })).toHaveCount(0);

	// The reveal click itself is deliberately not exercised here: that
	// interaction is VrViewer/page behavior already pinned by the unit and
	// markup tests. This spec's job is the DB→loader→gate chain.
});

test('unpublished avatar detail page is indistinguishable from unknown', async ({ page }) => {
	const res = await page.goto('/vr/e2e-draft');
	expect(res?.status()).toBe(404);
});

test('download is refused (403) for a restrictive license even with downloadable on', async ({
	request
}) => {
	// Seeded avatar 1 has downloadable=1 but license=all-rights-reserved: the
	// flag can't override the license, and enforcement is server-side (the URL
	// is hand-craftable regardless of what the page renders).
	const res = await request.get('/vr/e2e-avatar/download');
	expect(res.status()).toBe(403);
});

test('detail page offers View in 3D as a real button and no download button', async ({ page }) => {
	await page.goto('/vr/e2e-avatar');

	// Click-to-load viewer: the control must exist and be a BUTTON (not a link
	// that would navigate) — clicking/rendering WebGL is not asserted.
	const view3d = page.getByRole('button', { name: 'View in 3D' });
	await expect(view3d).toBeVisible();
	expect(await view3d.evaluate((el) => el.tagName)).toBe('BUTTON');

	// Restrictive license → the page mirrors the download route's refusal by
	// not rendering the button at all.
	await expect(page.getByRole('link', { name: 'Download model' })).toHaveCount(0);
});

test('detail page renders the seeded showcase media strip (SP1)', async ({ page }) => {
	await page.goto('/vr/e2e-avatar');

	// Poster thumb + the two seeded media rows, named per thumb button.
	await expect(page.getByRole('button', { name: 'Poster' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'E2E VR Avatar — media 1' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'E2E VR Avatar — media 2' })).toBeVisible();
});

test('admin /admin/vr lists everything ungated (E2E_VR_GATE override active)', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr');

	// The e2e harness sets E2E_VR_GATE=open (see wrangler.e2e.toml): the gate is
	// pre-GA on the calendar but forced open here so the form specs can run.
	// Gate PRESENTATION (banner/locked states) is covered by the registry-driven
	// unit matrices in admin/vr/*/page.server.test.ts.
	await expect(page.getByText('E2E VR Avatar')).toBeVisible();
	await expect(page.getByText('E2E VR Draft')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Add avatar' })).toBeVisible();
	await expect(page.getByText('VR avatars are in early access')).toHaveCount(0);
});
