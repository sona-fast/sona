import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';
import { EARLY_ACCESS } from '../../src/lib/early-access';

// VR avatar showcase (SONA-124): public visibility of the seeded avatars, the
// download route's server-side license enforcement, the click-to-load viewer
// button, and the admin section's early-access gate state.
//
// Runs on the SHARED read-only DB/server under fullyParallel: everything here
// only READS the seeded rows (tests/e2e/fixtures/seed.sql — avatars 1 and 2)
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

test('admin /admin/vr reflects the early-access gate state', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr');

	// The seeded DB stores no supporter key, so the gate state tracks the
	// registry's GA date — which is a real calendar date that will pass while
	// this spec keeps running (the registry entry is deleted at the next
	// release). Derive the expected state from the same registry the server
	// reads instead of hardcoding either branch.
	const gaDate = EARLY_ACCESS['vr-avatars'];
	const preGa = gaDate !== undefined && Date.now() < Date.parse(`${gaDate}T00:00:00Z`);

	// Reading is never gated: the seeded avatars stay listed either way.
	await expect(page.getByText('E2E VR Avatar')).toBeVisible();
	await expect(page.getByText('E2E VR Draft')).toBeVisible();

	if (preGa) {
		// Pre-GA with no key: creating is locked — the gate banner shows and the
		// Add-avatar affordance is gone.
		await expect(page.getByText('VR avatars is in early access')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Add supporter key' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Add avatar' })).toHaveCount(0);
	} else {
		// GA reached: the section is ungated.
		await expect(page.getByRole('link', { name: 'Add avatar' })).toBeVisible();
		await expect(page.getByText('VR avatars is in early access')).toHaveCount(0);
	}
});
