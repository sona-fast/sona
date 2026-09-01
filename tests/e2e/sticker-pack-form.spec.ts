import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// Sticker-pack form drop zone (SONA-216). Like vr-admin-form.spec.ts this runs
// on the SHARED read-only DB/server under fullyParallel: it drops files onto the
// client-side form and never submits it, and /api/upload is stubbed so no stored
// file is left behind.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

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
	const zone = page.locator('.upload-zone.multi');
	await expect(zone).toBeVisible();

	const drop = (name: string, type: string) =>
		page.evaluate(
			({ name, type }) => {
				const dt = new DataTransfer();
				dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
				document
					.querySelector('.upload-zone.multi')!
					.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
			},
			{ name, type }
		);

	// Hydration-retry shape (see vr-admin-form.spec.ts): a drop dispatched before
	// the attachment has run silently does nothing. The counter resets per try.
	await expect(async () => {
		uploads = 0;
		// Empty type on purpose: a file manager often hands one over that way, so
		// the accept string has to carry the extension as well as the MIME type.
		await drop('sticker.png', '');
		await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x.png', {
			timeout: 2000
		});
		expect(uploads).toBe(1);
	}).toPass({ timeout: 20_000 });

	// The highlight class is set imperatively and matched by a :global() rule —
	// assert the painted border changed, not just that the class landed.
	const resting = await zone.evaluate((el) => getComputedStyle(el).borderColor);
	await page.evaluate(() => {
		document
			.querySelector('.upload-zone.multi')!
			.dispatchEvent(new DragEvent('dragover', { dataTransfer: new DataTransfer(), bubbles: true }));
	});
	await expect(zone).toHaveClass(/drag-over/);
	await expect
		.poll(() => zone.evaluate((el) => getComputedStyle(el).borderColor))
		.not.toBe(resting);

	// A dropped file skips the input's accept filter, so the zone rejects the
	// wrong type itself: a toast naming the file, and no POST.
	const before = uploads;
	await drop('notes.txt', 'text/plain');
	await expect(page.getByText(/Skipped notes\.txt/)).toBeVisible();
	expect(uploads).toBe(before);
});
