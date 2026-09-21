import { test, expect, type Locator } from '@playwright/test';
import { adminLogin, gotoAfterLogin } from './admin-login';

// SONA-209 step 4: .btn-full-mobile and .btn-desktop-only moved behaviour out of
// the pages' scoped CSS and into two markup classes. Both are keyed to a viewport
// width, so a unit test can only read the rule text back — nothing proved a
// BROWSER still lays the buttons out that way. A class dropped from one page, a
// typo in its name, or the media block falling out of app.css leaves the whole
// unit suite green and the phone layout broken.
//
// Only the pages where the class DECIDES the width are measured here. A row that
// stacks into a column at 375px stretches its buttons on its own, so a test
// there passes with the class removed and proves nothing.
//
// Read-only: every test here loads a page and measures it.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
const PHONE = { width: 375, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

// "Takes the whole row" is measured, not read out of the cascade: the control is
// as wide as the box it sits in. Sub-pixel layout rounding means the two widths
// are compared with a 1px tolerance rather than for equality.
async function expectFillsRow(control: Locator, container: Locator, what: string) {
	const [box, row] = [await control.boundingBox(), await container.boundingBox()];
	expect(box, `${what} has no box`).not.toBeNull();
	expect(row, `${what}'s container has no box`).not.toBeNull();
	expect(
		Math.abs(box!.width - row!.width),
		`${what} is ${box!.width}px in a ${row!.width}px row — it is not full width on a phone`
	).toBeLessThan(1);
}

// The VR download anchor's .actions stays a flex ROW at every width — no media
// query restacks it — so the anchor is as wide as its content unless
// .btn-full-mobile says otherwise. Drop the class there and this test says so.
test('btn-full-mobile fills the row on a phone: the VR download button', async ({ page }) => {
	await page.setViewportSize(PHONE);
	// Avatar 5 (tests/e2e/fixtures/seed.sql) is the seeded avatar the loader
	// offers a download for: permissive license + downloadable + a recorded
	// permission source + a model key the R2 stub serves.
	await page.goto('/vr/e2e-downloadable');

	// ConCard also uses .actions, so scope to the row holding the download anchor.
	const row = page.locator('.actions').filter({ has: page.locator('a[download]') });
	await expect(row).toBeVisible();
	await expectFillsRow(row.locator('.btn'), row, '.actions .btn');
});

// The settings buttons are not flex items of the stacked card — each sits inside
// its own <form> — so the width comes from .btn-full-mobile and nothing else.
test('btn-full-mobile fills the row on a phone: the settings export button', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await adminLogin(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/settings?tab=account');

	const form = page.locator('.export-card form');
	await expect(form).toBeVisible();
	await expectFillsRow(form.locator('.btn'), form, '.export-card form .btn');
});

test('btn-desktop-only drops out of the header on a phone and comes back wide', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await adminLogin(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/tags');

	const add = page.locator('.page-header .btn-desktop-only');
	await expect(add).toHaveCount(1);
	await expect(add).toBeHidden();

	await page.setViewportSize(DESKTOP);
	await expect(add).toBeVisible();
});

// A stacking pin, not a class pin: the 404 page's action row restacks into a
// full-width column at this size, so its links need no .btn-full-mobile. This
// guards that media query, so the links can't quietly fall back to content
// width.
test('the 404 actions stack full width on a phone without btn-full-mobile', async ({ page }) => {
	await page.setViewportSize(PHONE);
	const response = await page.goto('/this-page-does-not-exist');
	expect(response?.status()).toBe(404);

	const row = page.locator('.error-page .actions');
	await expect(row).toBeVisible();
	const buttons = row.locator('.btn');
	await expect(buttons).toHaveCount(2);
	for (let i = 0; i < 2; i++) {
		await expectFillsRow(buttons.nth(i), row, `.error-page .actions .btn #${i + 1}`);
	}
});
