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

// A JPEG the scrubber cannot walk: SOI, then an APP1 segment declaring 500
// bytes with five in the file. The sniff sees a real JPEG, so the request gets
// as far as the storage layer, which refuses to store a raster it could not
// walk — a 422, not a 500 (SONA-170).
const UNSCRUBBABLE_JPEG = Buffer.from([
	0xff, 0xd8, 0xff, 0xe1, 0x01, 0xf4, ...Buffer.from('short')
]);

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

test('a file whose metadata cannot be stripped fails the tile with the re-export message', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	// The status the server really answered with, not just what the tile says.
	const statuses: number[] = [];
	page.on('response', (r) => {
		if (new URL(r.url()).pathname === '/api/upload') statuses.push(r.status());
	});

	await page.goto('/admin/upload');
	await stageFiles(
		page,
		{ name: 'e2e-unscrubbable.jpg', mimeType: 'image/jpeg', buffer: UNSCRUBBABLE_JPEG },
		1,
		() => {
			statuses.length = 0;
		}
	);

	// The tile tells the operator what to do about it, rather than showing the
	// bare "Upload failed (422)" both clients used to fall back to.
	const error = page.locator('.tile-error .error-text');
	await expect(error).toContainText('Export a fresh copy from an image editor', {
		timeout: 15_000
	});
	await expect(error).not.toContainText('422');
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('');
	expect(statuses).toEqual([422]);
});

test('the VR media picker names the same refusal and gets a 422', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const statuses: number[] = [];
	page.on('response', (r) => {
		if (new URL(r.url()).pathname === '/api/upload') statuses.push(r.status());
	});

	await page.goto('/admin/vr/new');
	// The showcase-media picker, not the model or poster input: it is the one
	// that accepts a clip alongside the stills.
	const picker = 'input.sr-file[accept*="video/webm"]';
	// Same hydration retry as stageFiles: setInputFiles' own change event does
	// not reach Svelte 5's delegated handler, so dispatch one after staging.
	const banner = page.locator('.banner.err .banner-line');
	await expect(async () => {
		statuses.length = 0;
		await page.setInputFiles(picker, {
			name: 'e2e-unscrubbable.jpg',
			mimeType: 'image/jpeg',
			buffer: UNSCRUBBABLE_JPEG
		});
		await page.evaluate((selector) => {
			document.querySelector(selector)!.dispatchEvent(new Event('change', { bubbles: true }));
		}, picker);
		await expect(banner).toHaveCount(1, { timeout: 3000 });
	}).toPass({ timeout: 20_000 });

	// The VR form used to blame the connection for a 422.
	await expect(banner).toContainText('Export a fresh copy from an image editor');
	await expect(banner).toContainText('e2e-unscrubbable.jpg');
	expect(statuses).toEqual([422]);
});

// Stage `files` through the sticker pack form's picker (the page's only file
// input). Unlike stageFiles, NO manual change dispatch: this input's onchange
// does run off setInputFiles' own event (verified — dispatching as well ran the
// handler twice and uploaded every file twice). The pack form's rows only
// appear once an upload finishes, so the hydration retry waits for the first
// POST to leave the browser instead. `onAttempt` runs at the top of EVERY
// attempt so the caller's counters get reset before a re-stage.
async function stagePackFiles(
	page: Page,
	files: Parameters<Page['setInputFiles']>[1],
	uploads: ReturnType<typeof countUploadPosts>,
	onAttempt: () => void = () => {}
): Promise<void> {
	await expect(async () => {
		onAttempt();
		uploads.reset();
		await page.setInputFiles('input[type="file"]', files);
		await expect.poll(() => uploads.counters.total, { timeout: 3000 }).toBeGreaterThan(0);
	}).toPass({ timeout: 20_000 });
}

test('the sticker pack form names the refusal and keeps the good file in the batch', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const statuses: number[] = [];
	page.on('response', (r) => {
		if (new URL(r.url()).pathname === '/api/upload') statuses.push(r.status());
	});
	const uploads = countUploadPosts(page);

	await page.goto('/admin/stickers/manual');
	await stagePackFiles(
		page,
		[
			{ name: 'e2e-unscrubbable.jpg', mimeType: 'image/jpeg', buffer: UNSCRUBBABLE_JPEG },
			{ name: 'e2e-sticker.png', mimeType: 'image/png', buffer: PNG }
		],
		uploads,
		() => {
			statuses.length = 0;
		}
	);

	// The toast fires only once every file in the batch has been answered, so
	// waiting on it also waits out the uploads.
	const toasts = page.locator('.alert-message');
	await expect(toasts).toHaveCount(2, { timeout: 20_000 });
	// A mixed batch gets both messages: the count, because a file did get
	// through, and the refusal with its own count of REFUSED files.
	await expect(toasts.filter({ hasText: '1 of 2 uploaded, 1 failed' })).toHaveCount(1);
	const refusal = toasts.filter({ hasText: 'Export fresh copies from an image editor' });
	await expect(refusal).toHaveCount(1);
	await expect(refusal).toContainText('from 1 of the files you picked');

	// The statuses the server really answered with — one refusal, one success.
	// Order varies with staging order, so compare sorted.
	expect([...statuses].sort((a, b) => a - b)).toEqual([200, 422]);
	// Only the good file became a sticker row.
	await expect(page.locator('input[name$="[imageUrl]"]')).toHaveCount(1);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue(
		/^https:\/\/e2e-app-id\.ufs\.sh\/f\/./
	);
});

test('a pack batch of only refused files shows the refusal alone', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const statuses: number[] = [];
	page.on('response', (r) => {
		if (new URL(r.url()).pathname === '/api/upload') statuses.push(r.status());
	});
	const uploads = countUploadPosts(page);

	await page.goto('/admin/stickers/manual');
	await stagePackFiles(
		page,
		{ name: 'e2e-unscrubbable.jpg', mimeType: 'image/jpeg', buffer: UNSCRUBBABLE_JPEG },
		uploads,
		() => {
			statuses.length = 0;
		}
	);

	// Every failure was a refusal, so the partial-failure toast would only repeat
	// the count the refusal already carries — exactly one toast appears.
	const toasts = page.locator('.alert-message');
	await expect(toasts).toHaveCount(1, { timeout: 20_000 });
	await expect(toasts).toContainText('Export fresh copies from an image editor');
	await expect(toasts).toContainText('from 1 of the files you picked');
	expect(statuses).toEqual([422]);
	await expect(page.locator('input[name$="[imageUrl]"]')).toHaveCount(0);
});

test('a pack batch where every file uploads shows no toast at all', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const statuses: number[] = [];
	page.on('response', (r) => {
		if (new URL(r.url()).pathname === '/api/upload') statuses.push(r.status());
	});
	const uploads = countUploadPosts(page);

	await page.goto('/admin/stickers/manual');
	await stagePackFiles(
		page,
		[
			{ name: 'e2e-sticker-a.png', mimeType: 'image/png', buffer: PNG },
			{ name: 'e2e-sticker-b.png', mimeType: 'image/png', buffer: PNG }
		],
		uploads,
		() => {
			statuses.length = 0;
		}
	);

	// Both files became rows, so the batch is over. A count toast here would be
	// the false "2 of 2 uploaded, 0 failed" error that the failed > 0 guard
	// exists to prevent.
	await expect(page.locator('input[name$="[imageUrl]"]')).toHaveCount(2, { timeout: 20_000 });
	expect(statuses).toEqual([200, 200]);
	await expect(page.locator('.alert-message')).toHaveCount(0);
});
