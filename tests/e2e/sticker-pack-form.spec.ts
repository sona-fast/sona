import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';
import { dropOn, expectDragOverHighlight } from './drop-files';

// Sticker-pack form drop zone (SONA-216). Like vr-admin-form.spec.ts this runs
// on the SHARED read-only DB/server under fullyParallel: it drops files onto the
// client-side form and never submits it, and /api/upload is stubbed so no stored
// file is left behind.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

const ZONE = '.upload-zone.multi';

test('dropping a sticker adds a row, and a wrong type is rejected without a request', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/stickers/manual');
	const zone = page.locator(ZONE);
	await expect(zone).toBeVisible();

	// Hydration-retry shape (see vr-admin-form.spec.ts): a drop dispatched before
	// the attachment has run silently does nothing. The counter resets per try.
	await expect(async () => {
		uploads = 0;
		await dropOn(page, ZONE, [{ name: 'sticker.png', type: 'image/png' }]);
		await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x.png', {
			timeout: 2000
		});
		expect(uploads).toBe(1);
	}).toPass({ timeout: 20_000 });

	await expectDragOverHighlight(page, ZONE);

	// A dropped file skips the input's accept filter, so the zone rejects the
	// wrong type itself: a toast naming the file, and no POST.
	const before = uploads;
	await dropOn(page, ZONE, [{ name: 'notes.txt', type: 'text/plain' }]);
	await expect(page.getByText('Skipped notes.txt. Add PNG or WebP images instead.')).toBeVisible();
	expect(uploads).toBe(before);
});

test('the sticker upload zone is reachable by keyboard and shows a focus ring', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/stickers/manual');
	await expect(page.locator(ZONE)).toBeVisible();

	// The file input is visually hidden, so nothing but the zone's own ring tells
	// a keyboard user where focus is. Tab there for real: :focus-visible does not
	// match a programmatic .focus(), which would make the ring assertion vacuous.
	const input = `${ZONE} input[type="file"]`;
	await page.locator('input[name="name"]').focus();
	let reached = false;
	for (let i = 0; i < 30 && !reached; i++) {
		await page.keyboard.press('Tab');
		reached = await page.evaluate(
			(sel) => document.activeElement === document.querySelector(sel),
			input
		);
	}
	expect(reached).toBe(true);
	expect(await page.locator(ZONE).evaluate((el) => getComputedStyle(el).outlineWidth)).not.toBe(
		'0px'
	);
});
