import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// Site-social rendering (SONA-117, extended by SONA-128): the seed fixture sets
// instagramUrl (https://www.instagram.com/sona.e2e.example) and a FurAffinity
// deep link, and these read-only assertions
// verify it surfaces on the public pages — the /connect link row, the /about
// social chip, and the footer icon. The unit test
// (src/routes/admin/settings/page.server.test.ts) covers the ACTION's FormData
// handling ('instagram' key → normalization → instagramUrl); the input-name
// binding is covered here by the admin prefill assertion. This spec never
// submits ?/saveSite — which would race legal.spec.ts, since saveSite treats a
// present-but-blank field as a clear and each save would wipe the other
// spec's setting under fullyParallel.

const PASSWORD = 'e2e-admin-password'; // legacy ADMIN_PASSWORD login path (see seed.sql)

test.describe('instagram site social', () => {
	test('the seeded Instagram URL renders a /connect link row', async ({ page }) => {
		await page.goto('/connect');
		const row = page.locator('a.link-row[href="https://www.instagram.com/sona.e2e.example"]');
		await expect(row).toBeVisible();
		await expect(row).toContainText('Instagram');
		await expect(row).toContainText('@sona.e2e.example');
	});

	test('the seeded Instagram URL renders an /about social chip', async ({ page }) => {
		await page.goto('/about');
		const chip = page.locator('a.social-item[href="https://www.instagram.com/sona.e2e.example"]');
		await expect(chip).toBeVisible();
		await expect(chip).toContainText('@sona.e2e.example');
		await expect(chip).toHaveAttribute('rel', 'noopener noreferrer');
		// The icon is aria-hidden, so the platform has to reach the accessible
		// name through the visually-hidden span — "@sona.e2e.example" alone would be
		// indistinguishable from the owner's other chips.
		await expect(page.getByRole('link', { name: /Instagram.*@sona.e2e.example/ })).toBeVisible();
	});

	// SONA-128: the seed also carries a FurAffinity DEEP link
	// (.../user/sona.e2e.example/gallery). Its rendering is what the shared label
	// rules changed — /connect used to show "sona.e2e.example" with no @, and a
	// last-segment reading says "@gallery" — so it catches a regression the
	// Instagram URL, byte-identical before and after, cannot.
	test('the seeded FurAffinity deep link renders the account, not the section', async ({
		page
	}) => {
		await page.goto('/connect');
		const row = page.locator(
			'a.link-row[href="https://www.furaffinity.net/user/sona.e2e.example/gallery"]'
		);
		await expect(row).toBeVisible();
		await expect(row).toContainText('FurAffinity');
		await expect(row).toContainText('@sona.e2e.example');
		await expect(row).not.toContainText('@gallery');
	});

	test('the seeded FurAffinity deep link names the account on its /about chip', async ({
		page
	}) => {
		await page.goto('/about');
		await expect(page.getByRole('link', { name: /FurAffinity.*@sona.e2e.example/ })).toBeVisible();
	});

	test('the public footer renders an Instagram icon link', async ({ page }) => {
		// The footer lives in the (public) layout and is hidden below 768px; the
		// project's default Desktop Chrome viewport (1280x720) keeps it visible.
		// /about's social chip carries no aria-label, so this selector is unique.
		await page.goto('/about');
		const icon = page.locator('a[aria-label="Instagram"]');
		await expect(icon).toBeVisible();
		await expect(icon).toHaveAttribute('href', 'https://www.instagram.com/sona.e2e.example');
	});

	test('the admin settings form prefills the seeded value into input[name="instagram"]', async ({
		page
	}) => {
		// Read-only guard on the input's name attribute: the action reads
		// formData.get('instagram'), so renaming the input would silently discard
		// saves while the unit test stays green. The value is server-rendered into
		// the form, so no hydration gate is needed — and nothing is submitted here
		// (see the header comment on the legal.spec.ts race).
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings');
		await expect(page.locator('input[name="instagram"]')).toHaveValue(
			'https://www.instagram.com/sona.e2e.example'
		);
	});
});
