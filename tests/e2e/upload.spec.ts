import { test, expect, type Page, type Request, type Route } from '@playwright/test';
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

// Record every text the live region is handed. A batch writes it three times in
// quick succession — the added/refused counts, "Uploading...", then the outcome
// — and only the last survives long enough for a polling locator assertion to
// see it, so a MutationObserver is the only way to assert the earlier ones.
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
	// The live region counts only the file that really entered the batch as
	// added; the refused one gets its own count, and the two are joined as the
	// separate sentences they are.
	await expect
		.poll(announced)
		.toContain("1 image(s) added. 1 file(s) couldn't be added");
	// The image in that same drop still uploads...
	await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x2.png', {
		timeout: 15_000
	});
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
	await expect(page.locator('.alert-message')).toHaveText('1 image(s) skipped — max 8');
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
	await page.waitForTimeout(300);
	expect(uploads.counters.total).toBe(0);
});

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
