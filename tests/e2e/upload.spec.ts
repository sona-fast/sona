import { test, expect, type Page, type Request } from '@playwright/test';
import { promises as fs } from 'node:fs';
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

// Stage `files` through the hidden input and wait for their tiles to appear.
// setInputFiles stages the file but its synthesized change event does not reach
// Svelte 5's root-delegated `onchange` (verified: the handler never runs, while
// a page-dispatched bubbling change does) — so dispatch the change ourselves
// after staging. The dispatch only lands once hydration has attached the
// delegated listener, so retry until the tiles' hidden inputs appear — same
// hydration-retry shape as palette-settings.spec.ts. `onAttempt` runs at the
// top of EVERY attempt so request counters installed by the caller get reset —
// a retry re-stages the files and would otherwise double-count.
async function stageFiles(
	page: Page,
	files: Parameters<Page['setInputFiles']>[1],
	expectedTileCount: number,
	onAttempt: () => void = () => {}
): Promise<void> {
	await expect(async () => {
		onAttempt();
		await page.setInputFiles('input[type="file"]', files);
		await page.evaluate(() => {
			document
				.querySelector('input[type="file"]')!
				.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await expect(page.locator('input[name^="imageUrl_"]')).toHaveCount(expectedTileCount, {
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });
}

// Count /api/upload POSTs (total + concurrency peak) via request lifecycle
// events — an in-flight request spans request → requestfinished/requestfailed,
// so any overlap shows up as peak > 1. Events rather than page.route +
// route.fetch(): replaying a staged multipart body through route.fetch
// corrupts it, so the requests must reach the server untouched.
function countUploadPosts(page: Page) {
	const isUploadPost = (r: Request) =>
		r.method() === 'POST' && new URL(r.url()).pathname === '/api/upload';
	const counters = { total: 0, inFlight: 0, peak: 0 };
	page.on('request', (r) => {
		if (isUploadPost(r)) {
			counters.total++;
			counters.inFlight++;
			counters.peak = Math.max(counters.peak, counters.inFlight);
		}
	});
	page.on('requestfinished', (r) => {
		if (isUploadPost(r)) counters.inFlight--;
	});
	page.on('requestfailed', (r) => {
		if (isUploadPost(r)) counters.inFlight--;
	});
	return {
		counters,
		reset: () => {
			counters.total = 0;
			counters.inFlight = 0;
			counters.peak = 0;
		}
	};
}

test('admin upload streams to UploadThing and the stored image renders', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	// The stored file lives on the (mocked) UploadThing CDN origin, which the
	// browser can't reach — serve the fixture bytes for any ufs.sh URL.
	await page.route('https://e2e-app-id.ufs.sh/**', (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
	);

	await page.goto('/admin/upload');
	// The zone's hint names all three ways in and the batch limit — the cap is
	// otherwise invisible until a ninth file is refused. 8 = MAX_VARIANT_SET.
	await expect(page.locator('.dropzone')).toContainText(
		'Choose up to 8 images, drag them here, or paste from the clipboard'
	);
	await stageFiles(page, { name: 'e2e-upload.png', mimeType: 'image/png', buffer: PNG }, 1);

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
	// Poll: a one-shot read right after toBeVisible() can catch the image still
	// decoding (naturalWidth 0), especially under load.
	await expect
		.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
});

test('a multi-file batch uploads sequentially within the batch — one in-flight POST at a time', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);

	await page.goto('/admin/upload');
	// Stage all three files in ONE setInputFiles call (one change event → one
	// handleFiles batch); distinct names keep the duplicate check quiet.
	const files = [1, 2, 3].map((n) => ({
		name: `e2e-batch-${n}.png`,
		mimeType: 'image/png',
		buffer: PNG
	}));
	await stageFiles(page, files, 3, uploads.reset);

	// Every tile reaches a provider URL — the whole batch really uploaded.
	for (const i of [0, 1, 2]) {
		await expect(page.locator(`input[name="imageUrl_${i}"]`)).toHaveValue(
			/^https:\/\/e2e-app-id\.ufs\.sh\/f\/./,
			{ timeout: 15_000 }
		);
	}
	// The sequential-uploads property: uploads never overlapped.
	expect(uploads.counters.peak).toBe(1);
});

test('an oversized file fails client-side without a POST; the rest of the batch still uploads', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);

	// One real small PNG plus a sparse file just over the 64 MiB cap. Payload
	// buffers are capped at 50 MB by Playwright, so both go via file paths;
	// ftruncate keeps the big one sparse (no 64 MiB actually written).
	const smallPath = testInfo.outputPath('e2e-small.png');
	await fs.writeFile(smallPath, PNG);
	const hugePath = testInfo.outputPath('e2e-huge.png');
	const handle = await fs.open(hugePath, 'w');
	await handle.truncate(64 * 1024 * 1024 + 1);
	await handle.close();

	await page.goto('/admin/upload');
	// Oversized file FIRST: uploads run in staged order, so if a doomed POST
	// were ever fired for it, it would land BEFORE the small file's POST — and
	// the count assertion below (which waits on the small upload finishing)
	// would catch it. Staged last, its POST could fire after the assertion.
	await stageFiles(page, [hugePath, smallPath], 2, uploads.reset);

	// The oversized tile (tile 0) shows the image-scoped too-large message...
	await expect(page.locator('.tile-error .error-text')).toContainText('over 64.0 MB');
	await expect(page.locator('.tile-error .error-text')).toContainText('smaller image');
	// ...and the small file (tile 1) still uploads normally.
	await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue(
		/^https:\/\/e2e-app-id\.ufs\.sh\/f\/./,
		{ timeout: 15_000 }
	);
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('');
	// Exactly one POST fired — none for the doomed oversized file.
	expect(uploads.counters.total).toBe(1);
});
