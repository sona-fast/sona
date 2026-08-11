import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// VR avatar admin form smoke (SONA-124, T1): VrAvatarForm and the /admin/vr/new
// page never executed in any test before this. The e2e harness forces the
// early-access gate open (E2E_VR_GATE=open in wrangler.e2e.toml) — pre-GA there
// is no mintable supporter key, so the ungated form is unreachable otherwise.
//
// Runs on the SHARED read-only DB/server under fullyParallel: everything here
// READS and types into the client-side form without ever submitting it, so it
// cannot perturb the other specs.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('the ungated create form renders its fields, dropzones and credit control', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	await expect(page.getByRole('heading', { name: 'Add avatar' })).toBeVisible();
	await expect(page.locator('input[name="name"]')).toBeVisible();
	await expect(page.locator('input[name="slug"]')).toBeVisible();
	await expect(page.locator('select[name="characterId"]')).toBeVisible();

	// Model dropzone, unlocked (the override opens the gate).
	await expect(page.getByText(/Choose a \.vrm or \.fbx file to upload/)).toBeVisible();
	// Format expectations under the dropzone (VR feedback round): which VRM
	// versions the viewer takes, and that FBX is download-only.
	await expect(page.getByText(/VRM 0\.x and 1\.0 both work in the 3D viewer/)).toBeVisible();
	await expect(page.getByText(/FBX files can be offered as a download/)).toBeVisible();

	// Showcase media manager (SP1) with its own dropzone.
	await expect(page.getByRole('heading', { name: 'Showcase media' })).toBeVisible();
	await expect(page.getByText(/Add screenshots or short \.webm clips/)).toBeVisible();

	// Credits editor entry point.
	await expect(page.getByRole('button', { name: 'Add credit' })).toBeVisible();
	// The gallery/sticker artist affordance is reused here: each credit row's
	// select carries a New-artist button (registry search lives inside the
	// dialog when connected). Rows start empty on /new, so add one first —
	// with the hydration-retry shape: a pre-hydration click silently no-ops.
	await expect(async () => {
		await page.getByRole('button', { name: 'Add credit' }).click();
		await expect(page.getByRole('button', { name: 'New artist for credit 1' })).toBeVisible({
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	// Visibility switches are named (a11y wiring, not just visuals).
	await expect(page.getByRole('checkbox', { name: 'Offer model download' })).toBeAttached();
	// The honesty note on the download toggle (VR feedback round): hiding the
	// button is not access control, because for VRM the viewer fetches the
	// same file anyway.
	await expect(page.getByText(/hides the download button without preventing access/)).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Mark as NSFW' })).toBeAttached();
	await expect(page.getByRole('checkbox', { name: 'Published' })).toBeAttached();
});

test("poster picker cells stay square even when the button's aspect-ratio is ignored", async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// CI simulates an engine that ignores aspect-ratio on form controls (the
	// override below) so the IMG's own aspect-ratio must hold the cell square;
	// the sizing rationale lives on the .poster-option img rule in VrAvatarForm.
	await page.waitForSelector('.poster-option img');
	await page.addStyleTag({ content: '.poster-option { aspect-ratio: auto !important; }' });
	// Assert the computed style directly so the check can't go vacuous if a
	// future fixture happens to be square (or still loading) by coincidence.
	await expect(page.locator('.poster-option img').first()).toHaveCSS('aspect-ratio', '1 / 1');
	const box = await page.locator('.poster-option').first().boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeGreaterThan(40);
	expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
});

test('typing a name auto-suggests the slug until the slug is touched', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// Hydration-retry shape (see upload.spec.ts): typing before Svelte attaches
	// its delegated listeners silently does nothing, so retype until the
	// suggestion appears. Client-side only — the form is never submitted.
	await expect(async () => {
		await page.fill('input[name="name"]', '');
		await page.fill('input[name="name"]', 'Taro VRChat!');
		await expect(page.locator('input[name="slug"]')).toHaveValue('taro-vrchat', {
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	// Adding a credit row exercises the credits editor client path.
	await page.getByRole('button', { name: 'Add credit' }).click();
	await expect(page.locator('select[name="credit[0][artistId]"]')).toBeVisible();
});
