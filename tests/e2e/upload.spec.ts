import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// End-to-end round-trip for the streaming upload path (SONA-136): an admin
// uploads a file, /api/upload streams it to UploadThing (the active provider on
// this server — seeded default, token set in wrangler.e2e-uploadthing.toml),
// the locally-signed ingest PUT is answered by the uploadthing-mock.mjs preload
// (Playwright can't route server-side fetch), and the saved piece renders from
// its STORED UploadThing URL — proving the returned ufsUrl survived the whole
// upload → save → render loop.
//
// Runs on its own dev server + seeded DB (the "upload" project in
// playwright.config.ts): it inserts image rows and depends on the provider
// staying 'uploadthing', which the ut-stat spec flips on its own server.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';

// 1×1 transparent PNG — a real raster so the server-side sniff (M7) passes and
// the browser can decode it when the stored URL is served back.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

test('admin upload streams to UploadThing and the stored image renders', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	// The stored file lives on the (mocked) UploadThing CDN origin, which the
	// browser can't reach — serve the fixture bytes for any ufs.sh URL.
	await page.route('https://e2e-app-id.ufs.sh/**', (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
	);

	await page.goto('/admin/upload');
	// setInputFiles stages the file but its synthesized change event does not
	// reach Svelte 5's root-delegated `onchange` (verified: the handler never
	// runs, while a page-dispatched bubbling change does) — so dispatch the
	// change ourselves after staging. The dispatch only lands once hydration
	// has attached the delegated listener, so retry until the tile's hidden
	// input appears — same hydration-retry shape as palette-settings.spec.ts.
	await expect(async () => {
		await page.setInputFiles('input[type="file"]', {
			name: 'e2e-upload.png',
			mimeType: 'image/png',
			buffer: PNG
		});
		await page.evaluate(() => {
			document
				.querySelector('input[type="file"]')!
				.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await expect(page.locator('input[name^="imageUrl_"]').first()).toBeAttached({
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	// The tile's hidden input receives the provider URL once /api/upload (and
	// behind it the mocked ingest PUT) succeeds.
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue(
		/^https:\/\/e2e-app-id\.ufs\.sh\/f\/./,
		{ timeout: 15_000 }
	);

	await page.fill('input[name="title"]', 'E2E Streamed Upload');
	await page.selectOption('select[name="artistId"]', '1');
	// NOT `button[type="submit"]` — the sidebar's Logout button matches that first.
	await page.getByRole('button', { name: 'Upload Artwork' }).click();
	await page.waitForURL(/\/admin\/images/);

	// The saved piece renders from its STORED UploadThing URL (dev's cdnImage
	// passes the raw src through), served by the route stub above.
	const img = page.locator('img[src*="ufs.sh/f/"]').first();
	await expect(img).toBeVisible();
	expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
