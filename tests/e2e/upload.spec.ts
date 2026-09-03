import { test, expect, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { adminLogin } from './admin-login';
import {
	dropOn,
	dragOver,
	dragOverText,
	expectDragOverHighlight,
	waitForDropAttachment
} from './drop-files';

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
//
// The drag-and-drop tests below (SONA-216) stay off that round trip: they stub
// /api/upload and never submit the form, so they leave neither stored files nor
// rows behind.

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
	onAttempt: () => void | Promise<void> = () => {}
): Promise<void> {
	await expect(async () => {
		await onAttempt();
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

// A file one byte over the 64 MiB cap. Payload buffers are capped at 50 MB by
// Playwright, so oversized files go via a path; ftruncate keeps them sparse (no
// 64 MiB actually written).
async function makeHugeFile(testInfo: TestInfo, name: string): Promise<string> {
	const path = testInfo.outputPath(name);
	const handle = await fs.open(path, 'w');
	await handle.truncate(64 * 1024 * 1024 + 1);
	await handle.close();
	return path;
}

test('an oversized file fails client-side without a POST; the rest of the batch still uploads', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);

	// One real small PNG plus a file just over the 64 MiB cap; both go via file
	// paths, since Playwright caps payload buffers at 50 MB.
	const smallPath = testInfo.outputPath('e2e-small.png');
	await fs.writeFile(smallPath, PNG);
	const hugePath = await makeHugeFile(testInfo, 'e2e-huge.png');

	await page.goto('/admin/upload');
	const announced = await recordAnnouncements(page);
	// Oversized file FIRST: uploads run in staged order, so if a doomed POST
	// were ever fired for it, it would land BEFORE the small file's POST — and
	// the count assertion below (which waits on the small upload finishing)
	// would catch it. Staged last, its POST could fire after the assertion.
	await stageFiles(page, [hugePath, smallPath], 2, async () => {
		uploads.reset();
		await clearAnnouncements(page);
	});

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
	// The counts cover every tile the pick created, oversized as well as
	// wrong-type: one image entered the batch, one file didn't. And the batch is
	// closed out as having errors, since the oversized tile is one of its own.
	await expect.poll(announced).toEqual([
		"1 image(s) added. 1 file(s) couldn't be added",
		'Upload finished with errors. Each file that failed shows the reason.'
	]);
});

test('a pick of nothing but oversized files is counted, and never says it finished', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);
	const firstPath = await makeHugeFile(testInfo, 'e2e-huge-1.png');
	const secondPath = await makeHugeFile(testInfo, 'e2e-huge-2.png');

	await page.goto('/admin/upload');
	const announced = await recordAnnouncements(page);
	await stageFiles(page, [firstPath, secondPath], 2, async () => {
		uploads.reset();
		await clearAnnouncements(page);
	});

	await expect(page.locator('.tile-error')).toHaveCount(2);
	// No file entered the batch, so the counts are the whole announcement: both
	// tiles are reported, and no batch opened that could later claim to be done.
	await expect(page.locator(LIVE_REGION)).toHaveText("2 file(s) couldn't be added");
	await page.waitForTimeout(300);
	expect(await announced()).toEqual(["2 file(s) couldn't be added"]);
	expect(uploads.counters.total).toBe(0);
});

// Paste one file into the page. The clipboard can't be primed with a file from
// the test runner, so build the DataTransfer inside the page and dispatch the
// paste on `document` — it bubbles to the window handler the page listens on.
function pasteFile(page: Page, name: string, type: string) {
	return page.evaluate(
		({ name, type }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
			document.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
			);
		},
		{ name, type }
	);
}

// The page's own live region (the admin layout has a separate one, a <p>).
const LIVE_REGION = 'div.sr-only[aria-live="polite"]';

// Record every text the live region is handed. A batch writes it twice — the
// added/refused counts when the files land, then the outcome when the last one
// is done — and only the second survives long enough for a polling locator
// assertion to see it, so a MutationObserver is the only way to assert the
// first. Two writes, not three: an "Uploading..." write between them landed in
// the same frame as the counts and was the only one a screen reader read out.
async function recordAnnouncements(page: Page) {
	await page.evaluate((selector) => {
		const region = document.querySelector(selector)!;
		const log: string[] = [];
		(window as unknown as { __announced: string[] }).__announced = log;
		new MutationObserver(() => {
			const text = region.textContent!.trim();
			if (text && text !== log[log.length - 1]) log.push(text);
		}).observe(region, { childList: true, characterData: true, subtree: true });
	}, LIVE_REGION);
	return () => page.evaluate(() => (window as unknown as { __announced: string[] }).__announced);
}

// Drop what the observer has seen so far. A stageFiles retry re-stages the files
// and writes the counts again, so a test that asserts the exact log has to clear
// it at the top of every attempt the same way the request counters are reset.
function clearAnnouncements(page: Page) {
	return page.evaluate(() => {
		(window as unknown as { __announced?: string[] }).__announced?.splice(0);
	});
}

test('dropping images adds tiles, and a wrong type is rejected without a request', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	// Stubbed rather than let through: this spec's dev server would really store
	// the file, and a drop needs no proof the streaming path works — the first
	// test covers that. The stub also keeps the seeded DB free of rows, since
	// this test never submits the form.
	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${uploads}.png` })
		});
	});

	await page.goto('/admin/upload');
	// A drop dispatched before the attachment has run silently does nothing.
	await waitForDropAttachment(page, '.dropzone');
	await expectDragOverHighlight(page, '.dropzone');

	await dropOn(page, '.dropzone', [{ name: 'dropped.png', type: 'image/png' }]);
	// The 15s budget every url assertion in this file carries: /api/upload is
	// stubbed, but the duplicate check ahead of it still goes to the dev server,
	// which compiles routes on demand and shares the machine with three others.
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/x1.png', {
		timeout: 15_000
	});
	// The per-file outcome is otherwise only an icon on the tile, so the batch
	// closes out in the live region too. This is the last thing written, so a
	// plain locator assertion can see it.
	await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');

	// The first tile replaces the dropzone with the grid, which takes drops too —
	// otherwise a second file dropped where the zone used to be would navigate
	// the tab away from a half-filled form.
	await waitForDropAttachment(page, '.tile-grid');
	// The grid wraps the variant label inputs, so it lets a text drag through
	// untouched — but only one that landed ON a label (asserted after the second
	// drop below, once a label exists). A drag that hit the grid itself is still
	// cancelled: a link dragged in from another tab carries no 'Files' either,
	// and dropping it on the gap between tiles would navigate away from the form.
	expect(await dragOverText(page, '.tile-grid', 'text/uri-list')).toBe(false);
	await expect(page.locator('.tile-grid')).not.toHaveClass(/drag-over/);
	// A file drag over the same grid is still claimed and still lights it up.
	await expectDragOverHighlight(page, '.tile-grid');

	// A dropped file skips the input's accept filter, so the page has to reject
	// the wrong type itself: an error tile, and no POST for it. Dropped alongside
	// an image, so the announcement has to tell the two apart.
	const before = uploads;
	const announced = await recordAnnouncements(page);
	await dropOn(page, '.tile-grid', [
		{ name: 'second.png', type: 'image/png' },
		{ name: 'notes.txt', type: 'text/plain' }
	]);
	await expect(page.locator('.tile-error .error-text')).toContainText(
		"That file type isn't supported"
	);
	// The image in that same drop still uploads...
	await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x2.png', {
		timeout: 15_000
	});
	// The live region says exactly two things about this drop, in this order: the
	// counts (only the file that really entered the batch is "added"; the refused
	// one gets its own count, joined as the separate sentences they are), then how
	// the batch ended. The end is "with errors" because the refused file is part
	// of the drop — a batch that carried one can't report a clean finish.
	await expect.poll(announced).toEqual([
		"1 image(s) added. 1 file(s) couldn't be added",
		'Upload finished with errors. Each file that failed shows the reason.'
	]);
	await expect(page.locator(LIVE_REGION)).toHaveText(
		'Upload finished with errors. Each file that failed shows the reason.'
	);
	// ...and exactly one POST fired — none for the refused file. Past the moment a
	// POST that DID fire would have landed (mutation-checked).
	await page.waitForTimeout(300);
	expect(uploads).toBe(before + 1);

	// Three tiles make this a group, so the variant label inputs are rendered.
	// A text drag that lands on one is the case the grid passes through — the
	// event bubbles up to the grid's handler with the input as its target, and
	// the grid has to leave it alone or the selection never reaches the field.
	await expect(page.locator('.tile-label').first()).toBeVisible();
	expect(await dragOverText(page, '.tile-label')).toBe(true);
	await expect(page.locator('.tile-grid')).not.toHaveClass(/drag-over/);

	// A drop that misses both zones (here: the form itself) is swallowed
	// page-wide, so it can't navigate the tab to the file and lose the form.
	const beforeStray = uploads;
	expect(await dropOn(page, 'form.upload-form', [{ name: 'stray.png', type: 'image/png' }])).toBe(
		true
	);
	await page.waitForTimeout(300);
	expect(uploads).toBe(beforeStray);
	await expect(page.locator('input[name^="imageUrl_"]')).toHaveCount(3);
});

test('refused files still take slots: nine wrong-type files fill the eight-tile cap', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	// A refused file consumes a slot exactly like an accepted one — it holds a
	// tile the operator has to dismiss — so nine of them hit the cap the seeded
	// max (8, as the dropzone hint says) sets, and the ninth is skipped.
	await dropOn(
		page,
		'.dropzone',
		Array.from({ length: 9 }, (_, i) => ({ name: `notes-${i}.txt`, type: 'text/plain' }))
	);
	await expect(page.locator('.tile-error')).toHaveCount(8);
	await expect(page.locator('.alert-message')).toHaveText('1 file(s) skipped — max 8');
	// None of them was ever sent.
	await page.waitForTimeout(300);
	expect(uploads.counters.total).toBe(0);
});

test('a picked file the accept string refuses gets an error tile, not a POST', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	const uploads = countUploadPosts(page);

	await page.goto('/admin/upload');
	// `accept` is only a filter the OS dialog can override ("All files"), and
	// setInputFiles bypasses it the same way — so the picker partitions too. SVG
	// is the file that matters: /api/upload refuses it because an SVG served
	// straight from the storage origin can execute script.
	await stageFiles(
		page,
		{ name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
		1,
		uploads.reset
	);
	await expect(page.locator('.tile-error .error-text')).toContainText(
		"That file type isn't supported"
	);
	// A refused file gets no object URL, so its tile shows the placeholder rather
	// than an <img> pointed at nothing — which would paint the broken-image glyph.
	// The placeholder carries the file name the alt text used to.
	await expect(page.locator('.tile-preview img')).toHaveCount(0);
	await expect(page.getByRole('img', { name: 'diagram.svg' })).toBeVisible();
	// Nothing entered the batch, so the counts are the whole announcement: no
	// batch opened, and "Upload finished." after a file that never uploaded would
	// be a lie. Read again after a wait, since a later write would replace it.
	await expect(page.locator(LIVE_REGION)).toHaveText("1 file(s) couldn't be added");
	await page.waitForTimeout(300);
	await expect(page.locator(LIVE_REGION)).toHaveText("1 file(s) couldn't be added");
	expect(uploads.counters.total).toBe(0);
});

// The ja bad-type string runs to four lines at tile width. The status band used
// to be an overlay pinned to the bottom of the preview, so at that height it
// covered the placeholder icon; on a placeholder tile the band is in normal flow
// and the icon keeps the space above it. Both widths, since the tile is narrower
// on a phone and the string wraps further.
for (const width of [1280, 390]) {
	test(`the refused-file icon clears the status band at ${width}px in Japanese`, async ({
		page
	}) => {
		await adminLogin(page, PASSWORD);
		// The paraglide locale cookie (src/lib/paraglide/runtime.js cookieName)
		// switches the SSR locale, the same way the VR guide spec does.
		await page
			.context()
			.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/admin/upload');
		await stageFiles(
			page,
			{ name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
			1
		);
		await expect(page.locator('.tile-error .error-text')).toContainText(
			'対応していないファイル形式です'
		);

		// Measure only once the ja face is in: with a fallback font the string
		// wraps to fewer lines, and a short band clears the icon no matter how the
		// two are stacked.
		await page.evaluate(() => document.fonts.ready);

		const icon = (await page.locator('.tile-placeholder svg').boundingBox())!;
		const band = (await page.locator('.tile-status').boundingBox())!;
		const preview = (await page.locator('.tile-preview').boundingBox())!;
		// The band really is the tall multi-line one this test exists for: taller
		// than the space left over if it split the preview evenly with the icon.
		// A one-line band would pass every assertion below without proving a thing.
		expect(band.height).toBeGreaterThan(preview.height / 2 - icon.height / 2);
		// The icon sits entirely above the band and inside the preview box, so no
		// part of it is covered or clipped away.
		expect(icon.y + icon.height).toBeLessThanOrEqual(band.y + 0.5);
		expect(icon.y).toBeGreaterThanOrEqual(preview.y - 0.5);
		// The band fits too — one that overflowed would lose its last line to the
		// preview's `overflow: hidden`.
		expect(band.y + band.height).toBeLessThanOrEqual(preview.y + preview.height + 0.5);
	});
}

// Pasting is the third way a file reaches the queue, and it goes through the
// same accept partition a drop does — a pasted SVG is one /api/upload refuses.
test('a pasted image uploads; a pasted SVG gets a placeholder error tile and no POST', async ({
	page
}) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/p${uploads}.png` })
		});
	});

	await page.goto('/admin/upload');
	// The paste handler is on <svelte:window>, and it only claims a paste while
	// focus is outside a text field — so wait for hydration the same way the drop
	// tests do, and leave focus on <body>.
	await waitForDropAttachment(page, '.dropzone');
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	await pasteFile(page, 'shot.png', 'image/png');
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/p1.png', {
		timeout: 15_000
	});

	const before = uploads;
	await pasteFile(page, 'diagram.svg', 'image/svg+xml');
	await expect(page.locator('.tile-error .error-text')).toContainText(
		"That file type isn't supported"
	);
	// One preview image for the pasted PNG, none for the refused SVG.
	await expect(page.locator('.tile-preview img')).toHaveCount(1);
	await expect(page.getByRole('img', { name: 'diagram.svg' })).toBeVisible();
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);
});

test('a failed upload announces the batch as finished with errors', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	await page.route('**/api/upload', (route) => route.fulfill({ status: 500, body: 'nope' }));

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	await dropOn(page, '.dropzone', [{ name: 'doomed.png', type: 'image/png' }]);

	await expect(page.locator('.tile-error .error-text')).toContainText('Upload failed (500)', {
		timeout: 15_000
	});
	// The tile shows the reason; the live region says the batch is over and that
	// something in it went wrong, so it isn't only visible to a sighted user.
	await expect(page.locator(LIVE_REGION)).toHaveText(
		'Upload finished with errors. Each file that failed shows the reason.'
	);
});

test('an overlapping batch does not close out the one still uploading', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	// The first POST is held open until the test releases it; the second fails.
	// So the second batch finishes FIRST, while the first is still in flight.
	let arrived = () => {};
	const firstArrived = new Promise<void>((resolve) => (arrived = resolve));
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	let posts = 0;
	await page.route('**/api/upload', async (route) => {
		posts++;
		if (posts === 1) {
			arrived();
			await held;
			await route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({ url: '/held.png' })
			});
			return;
		}
		await route.fulfill({ status: 500, body: 'nope' });
	});

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	const announced = await recordAnnouncements(page);

	await dropOn(page, '.dropzone', [{ name: 'held.png', type: 'image/png' }]);
	await firstArrived;
	// Its tile turned the dropzone into the grid, which is where the second drop
	// lands — mid-flight, so the two batches overlap.
	await waitForDropAttachment(page, '.tile-grid');
	await dropOn(page, '.tile-grid', [{ name: 'doomed.png', type: 'image/png' }]);
	await expect(page.locator('.tile-error .error-text')).toContainText('Upload failed (500)', {
		timeout: 15_000
	});
	// The second batch is over, but the first is still uploading — announcing
	// anything now would tell the operator a batch finished that hasn't.
	expect(await announced()).not.toContain('Upload finished.');

	release();
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/held.png', {
		timeout: 15_000
	});
	// The last batch in flight speaks for both, and carries the failure the other
	// one hit — not the clean finish its own file had.
	await expect(page.locator(LIVE_REGION)).toHaveText(
		'Upload finished with errors. Each file that failed shows the reason.'
	);
	await page.waitForTimeout(300);
	expect(await announced()).not.toContain('Upload finished.');
});

test('a refused drop mid-batch still costs the running batch its clean finish', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	// The one POST is held open until the test releases it, so the batch it
	// belongs to is still in flight when the second drop lands.
	let arrived = () => {};
	const firstArrived = new Promise<void>((resolve) => (arrived = resolve));
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/upload', async (route) => {
		arrived();
		await held;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/held.png' })
		});
	});

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');

	await dropOn(page, '.dropzone', [{ name: 'held.png', type: 'image/png' }]);
	await firstArrived;
	// An SVG on its own opens no batch of its own — it only puts an error tile on
	// the screen — so the held batch is the only one left to report it.
	await waitForDropAttachment(page, '.tile-grid');
	await dropOn(page, '.tile-grid', [{ name: 'vector.svg', type: 'image/svg+xml' }]);
	await expect(page.locator('.tile-error .error-text')).toContainText(
		"That file type isn't supported"
	);

	release();
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/held.png', {
		timeout: 15_000
	});
	// Its own file uploaded fine, but a refused tile arrived while it ran, so
	// calling the screen clean would send the operator looking for nothing.
	await expect(page.locator(LIVE_REGION)).toHaveText(
		'Upload finished with errors. Each file that failed shows the reason.'
	);
});

test('the same batch outcome twice is announced twice', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${uploads}.png` })
		});
	});

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	const region = page.locator(LIVE_REGION);

	await dropOn(page, '.dropzone', [{ name: 'first.png', type: 'image/png' }]);
	await expect(region).toHaveText('Upload finished.', { timeout: 15_000 });

	// Re-assigning the text the region already holds touches no DOM and is not
	// announced; the keyed inner node must be replaced (same shape as the VR
	// form's "same media status twice" test). The first tile swapped the dropzone
	// for the grid, which is where the second file goes.
	await region.locator('span').evaluate((el) => el.setAttribute('data-first', ''));
	await waitForDropAttachment(page, '.tile-grid');
	await dropOn(page, '.tile-grid', [{ name: 'second.png', type: 'image/png' }]);
	await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue(/^\/x\d+\.png$/, {
		timeout: 15_000
	});
	await expect(region.locator('span[data-first]')).toHaveCount(0);
	await expect(region).toHaveText('Upload finished.');
});

test('the upload zones refuse files while a save is in flight', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${uploads}.png` })
		});
	});

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	// While nothing is saving, Space on the focused zone opens the picker and
	// must NOT also scroll the page — the handler cancels the default for exactly
	// that. Asserted before the save gate below, since the handler bails early
	// while saving and would pass this vacuously.
	expect(
		await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)
	).toBe(true);
	await page.locator('.dropzone').focus();
	await page.keyboard.press(' ');
	expect(await page.evaluate(() => window.scrollY)).toBe(0);

	await dropOn(page, '.dropzone', [{ name: 'saved.png', type: 'image/png' }]);
	// 15s for the same reason as the drop test above: the duplicate check ahead
	// of the stubbed upload is a real request to the dev server.
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/x1.png', {
		timeout: 15_000
	});

	// Hold the form POST so `saving` stays true. page.route intercepts inside the
	// browser, so the seeded server never sees the request and no row is written.
	let holdPost = (_route: Route) => {};
	const posted = new Promise<Route>((resolve) => (holdPost = resolve));
	await page.route('**/admin/upload**', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.fallback();
			return;
		}
		holdPost(route);
	});

	await page.fill('input[name="title"]', 'Save gate');
	await page.selectOption('select[name="artistId"]', '1');
	await page.getByRole('button', { name: 'Upload Artwork' }).click();
	const save = page.locator('form.upload-form button[type="submit"]');
	await expect(save).toBeDisabled();

	// A drop landing now would upload a file the already-serialized submit never
	// references, orphaning it in storage.
	const before = uploads;
	await dropOn(page, '.tile-grid', [{ name: 'late.png', type: 'image/png' }]);
	await dragOver(page, '.tile-grid');
	await expect(page.locator('.tile-grid')).not.toHaveClass(/drag-over/);
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);
	await expect(page.locator('input[name^="imageUrl_"]')).toHaveCount(1);
	// The third way in is gated too: paste has no zone to disable, so the handler
	// has to bail on its own or it becomes the one route around the save gate.
	await pasteFile(page, 'pasted.png', 'image/png');
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);
	await expect(page.locator('input[name^="imageUrl_"]')).toHaveCount(1);
	// The other way into the picker says it's unavailable too — aria-disabled
	// rather than `disabled`, so a keyboard user holding it keeps focus.
	await expect(page.locator('.tile-add')).toHaveAttribute('aria-disabled', 'true');

	// Removing the last tile mid-save brings the dropzone back — gated the same
	// way, and it says so.
	await page.locator('.tile-remove').click();
	await expect(page.locator('.dropzone')).toHaveClass(/disabled/);
	// The class is the look; aria-disabled is what a screen reader reads.
	await expect(page.locator('.dropzone')).toHaveAttribute('aria-disabled', 'true');
	// The click path is gated too: a disabled input ignores the programmatic
	// click the zone sends it, so the picker can't open mid-save.
	await expect(page.locator('input[type="file"]')).toBeDisabled();
	await dropOn(page, '.dropzone', [{ name: 'later.png', type: 'image/png' }]);
	await dragOver(page, '.dropzone');
	await expect(page.locator('.dropzone')).not.toHaveClass(/drag-over/);
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);

	// The zones come back once the submit settles, so a failed save is still
	// editable. Settled as an action failure rather than an abort: an aborted
	// fetch makes enhance render the error page, which takes the form away and
	// leaves nothing to assert on. The data is devalue-encoded, the shape
	// deserialize() expects.
	await (await posted).fulfill({
		contentType: 'application/json',
		body: JSON.stringify({
			type: 'failure',
			status: 400,
			data: '[{"error":1},"Held by the test"]'
		})
	});
	await expect(page.locator('.dropzone')).not.toHaveClass(/disabled/);
	await expect(page.locator('input[type="file"]')).toBeEnabled();
	await dropOn(page, '.dropzone', [{ name: 'after.png', type: 'image/png' }]);
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue(/^\/x\d+\.png$/, {
		timeout: 15_000
	});
});

test('a lone refused drop does not poison the next clean batch', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);
	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: `/x${uploads}.png` }) });
	});

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');

	// Nothing in flight: the refusal is announced and no batch opens.
	await dropOn(page, '.dropzone', [{ name: 'vector.svg', type: 'image/svg+xml' }]);
	await expect(page.locator('.tile-error .error-text')).toContainText("That file type isn't supported");
	await expect(page.locator(LIVE_REGION)).toHaveText("1 file(s) couldn't be added");

	// A clean batch afterwards closes clean: the stale refusal belongs to no
	// batch, so it must not flip this one's finish to "with errors".
	await dropOn(page, '.tile-grid', [{ name: 'good.png', type: 'image/png' }]);
	await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.', { timeout: 15_000 });
});

test('a 200 without a usable url fails the tile instead of storing nothing', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: '{}' })
	);

	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	await dropOn(page, '.dropzone', [{ name: 'a.png', type: 'image/png' }]);

	// Same guard as the sticker and VR forms: a row pointing at nothing would
	// be silently dropped at save time, so the tile fails here and says so.
	await expect(page.locator('.tile-error')).toHaveCount(1, { timeout: 15_000 });
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('');
	await expect(page.locator(LIVE_REGION)).toHaveText(
		'Upload finished with errors. Each file that failed shows the reason.'
	);
});
