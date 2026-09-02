import { test, expect, type Route } from '@playwright/test';
import { adminLogin } from './admin-login';
import {
	dropOn,
	dragOver,
	expectDragOverHighlight,
	waitForDropAttachment
} from './drop-files';

// Sticker-pack form drop zone (SONA-216). Like vr-admin-form.spec.ts this runs
// on the SHARED read-only DB/server under fullyParallel: it drops files onto the
// client-side form and never submits it, and /api/upload is stubbed so no stored
// file is left behind.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

const ZONE = '.upload-zone.multi';

// $lib/config's MAX_BUFFER_BYTES, restated rather than imported: config.ts
// imports $app/environment, which does not resolve outside the Vite build (the
// upload spec restates the same cap for the same reason). Drift is caught by
// the unit test that pins MAX_BUFFER_BYTES to this value.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

test('dropping a sticker adds a row, and a wrong type is rejected without a request', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	// `hold`, when set, keeps a request in flight so the "Uploading…" state can be
	// read off the live region before the done message replaces it.
	let uploads = 0;
	let hold: Promise<void> | null = null;
	let release = () => {};
	await page.route('**/api/upload', async (route) => {
		uploads++;
		if (hold) await hold;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/stickers/manual');
	const zone = page.locator(ZONE);
	await expect(zone).toBeVisible();
	// The idle label names both ways in, and the two formats the zone takes —
	// the accept filter is invisible until a drop is refused otherwise.
	await expect(zone).toContainText('Choose PNG or WebP images, or drag them here');
	// The stickers section's always-mounted live region.
	const status = page.locator('span.sr-only[role="status"]');

	// A drop dispatched before the attachment has run silently does nothing, so
	// wait for it rather than retrying the drop: the held request below keeps the
	// zone disabled, and a retried drop could never recover anyway.
	await waitForDropAttachment(page, ZONE);

	hold = new Promise<void>((resolve) => (release = resolve));
	await dropOn(page, ZONE, [{ name: 'sticker.png', type: 'image/png' }]);
	// The held request keeps the zone busy, so a drop that landed shows up as
	// the in-progress announcement rather than a finished row.
	await expect(status).toHaveText('Uploading...');
	expect(uploads).toBe(1);
	release();
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x.png');
	// …and the same region reports the finish, as a real plural rather than
	// "1 sticker(s) added".
	await expect(status).toHaveText('1 sticker added');
	hold = null;

	await expectDragOverHighlight(page, ZONE);

	// A dropped file skips the input's accept filter, so the zone rejects the
	// wrong type itself: a persistent banner naming the file, and no POST.
	const before = uploads;
	const banner = page.locator('.banner.err');
	await dropOn(page, ZONE, [{ name: 'notes.txt', type: 'text/plain' }]);
	await expect(banner).toBeVisible();
	await expect(banner.locator('.banner-line')).toHaveText([
		/notes\.txt — That file type isn't supported\. Use PNG or WebP\./
	]);
	expect(uploads).toBe(before);
	// Nothing to upload, so the live region says the batch ended badly rather
	// than keeping the previous batch's success text.
	await expect(status).toHaveText('Sticker upload finished with errors. Each file that failed shows the reason.');

	// The list is uncapped and per-file: a folder dropped whole names every file
	// it refused instead of collapsing to a count.
	await dropOn(
		page,
		ZONE,
		['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => ({ name, type: 'text/plain' }))
	);
	await expect(banner.locator('.banner-line')).toHaveCount(4);
	await expect(banner.locator('.banner-line').first()).toContainText('a.txt');
	await expect(banner.locator('.banner-line').last()).toContainText('d.txt');
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

test('the sticker format comes from the MIME type, not the file name', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	let calls = 0;
	await page.route('**/api/upload', async (route) => {
		calls++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${calls}.png` })
		});
	});

	await page.goto('/admin/stickers/manual');
	const status = page.locator('span.sr-only[role="status"]');
	await waitForDropAttachment(page, ZONE);

	// An uppercase extension and no extension at all: both are ordinary for a
	// dropped file, and both defeat a name-based derivation.
	await dropOn(page, ZONE, [
		{ name: 'IMG.PNG', type: 'image/png' },
		{ name: 'sticker', type: 'image/webp' }
	]);
	await expect(page.locator('input[name="sticker[0][format]"]')).toHaveValue('png');
	await expect(page.locator('input[name="sticker[1][format]"]')).toHaveValue('webp');
	// Two files in one drop, so the live region takes the plural branch.
	await expect(status).toHaveText('2 stickers added');
});

test('the sticker zone dims while an upload runs and refuses a drop without lighting up', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	let hold: Promise<void> | null = null;
	let release = () => {};
	await page.route('**/api/upload', async (route) => {
		uploads++;
		if (hold) await hold;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/stickers/manual');
	await waitForDropAttachment(page, ZONE);

	// Resting border, read while the zone is idle: the busy zone keeps pointer
	// events (see below), which keeps :hover alive, so it must hold this colour
	// instead of lighting up primary as if it would take a click.
	const restingBorder = await page.locator(ZONE).evaluate((el) => getComputedStyle(el).borderColor);

	hold = new Promise<void>((resolve) => (release = resolve));
	await dropOn(page, ZONE, [{ name: 'slow.png', type: 'image/png' }]);
	const busy = page.locator(`${ZONE}.disabled`);
	await expect(busy).toBeVisible();
	// Polled past the zone's 0.15s opacity transition.
	// Below the resting 1, not pinned to the end value: a backgrounded worker
	// tab can leave the 0.15s transition parked mid-way.
	await expect.poll(() => busy.evaluate((el) => parseFloat(getComputedStyle(el).opacity))).toBeLessThan(0.7);
	// `pointer-events: none` on .disabled would let the next drop reach the
	// document and navigate the tab to the file. The zone still refuses the
	// drop — no highlight — it just has to be the one refusing.
	expect(await busy.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe('none');
	await dragOver(page, ZONE);
	await expect(busy).not.toHaveClass(/drag-over/);
	await busy.hover();
	// Past the border-color transition: read any sooner and a border that IS
	// heading for primary still measures as the resting colour.
	await page.waitForTimeout(400);
	expect(await busy.evaluate((el) => getComputedStyle(el).borderColor)).toBe(restingBorder);
	// Saving mid-upload would store the pack without the pending file, so the
	// submit is gated on the upload too (same guard as the VR form).
	const save = page.getByRole('button', { name: 'Save pack' });
	await expect(save).toBeDisabled();
	release();
	await expect(page.locator(`${ZONE}.disabled`)).toHaveCount(0);
	await expect(save).toBeEnabled();

	// A drop that misses the zone (here: the form itself) is swallowed page-wide.
	const beforeStray = uploads;
	expect(await dropOn(page, 'form.form', [{ name: 'stray.png', type: 'image/png' }])).toBe(true);
	expect(uploads).toBe(beforeStray);
});

test('a failed upload keeps the successes, and the banner names the file that failed', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	// The form awaits each POST in turn, so the call index picks out which file
	// fails.
	let calls = 0;
	let failCalls: number[] = [];
	await page.route('**/api/upload', async (route) => {
		calls++;
		if (failCalls.includes(calls)) {
			await route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' });
			return;
		}
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${calls}.png` })
		});
	});

	await page.goto('/admin/stickers/manual');
	const status = page.locator('span.sr-only[role="status"]');
	await waitForDropAttachment(page, ZONE);

	failCalls = [2];
	await dropOn(page, ZONE, [
		{ name: 'a.png', type: 'image/png' },
		{ name: 'b.png', type: 'image/png' }
	]);
	// The one that landed is kept rather than discarded with the batch…
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x1.png');
	await expect(page.locator('input[name="sticker[1][imageUrl]"]')).toHaveCount(0);
	// …and the banner names the one that didn't, rather than a count that leaves
	// the operator guessing which file to re-add.
	const banner = page.locator('.banner.err');
	await expect(banner.locator('.banner-line')).toHaveText([
		/b\.png — Upload failed\. Check your connection and try again\./
	]);
	// The live region says the batch finished badly; the banner carries the names.
	await expect(status).toHaveText('Sticker upload finished with errors. Each file that failed shows the reason.');
	// Theme-safe text: the banner takes the theme's own foreground, so it stays
	// readable on the tinted background in every theme rather than assuming one.
	const [bannerColor, foreground] = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--foreground)';
		document.body.appendChild(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return [getComputedStyle(document.querySelector('.banner.err')!).color, resolved];
	});
	expect(bannerColor).toBe(foreground);

	// A fresh batch replaces the previous batch's lines rather than appending to
	// files the operator has already dealt with.
	calls = 0;
	failCalls = [1];
	await dropOn(page, ZONE, [{ name: 'c.png', type: 'image/png' }]);
	await expect(banner.locator('.banner-line')).toHaveText([
		/c\.png — Upload failed\. Check your connection and try again\./
	]);

	// A batch that fully succeeds takes the banner away entirely, rather than
	// leaving a stale alert beside rows that all landed.
	calls = 0;
	failCalls = [];
	await dropOn(page, ZONE, [{ name: 'd.png', type: 'image/png' }]);
	await expect(page.locator('input[name="sticker[1][imageUrl]"]')).toHaveValue('/x1.png');
	await expect(page.locator('.banner.err')).toHaveCount(0);
	// …and the live region goes back to the added count instead of holding the
	// previous batch's failure text.
	await expect(status).toHaveText('1 sticker added');
});

test('the sticker zone refuses files while a save is in flight', async ({ page }) => {
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
	await waitForDropAttachment(page, ZONE);

	// Hold the form POST so `saving` stays true. page.route intercepts inside the
	// browser, so the shared read-only server never sees the request.
	let holdPost = (_route: Route) => {};
	const posted = new Promise<Route>((resolve) => (holdPost = resolve));
	await page.route('**/admin/stickers/manual**', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.fallback();
			return;
		}
		holdPost(route);
	});

	await page.fill('input[name="name"]', 'Save gate');
	// By role first, then by selector: the button's label swaps to "Saving..."
	// while the submit is in flight, so an accessible-name locator stops
	// matching exactly when the assertions need it.
	await page.getByRole('button', { name: 'Save pack' }).click();
	const save = page.locator('form.form button[type="submit"]');
	await expect(save).toBeDisabled();
	await expect(page.locator(ZONE)).toHaveClass(/disabled/);

	// A drop landing now would upload and append a row the already-serialized
	// submit never sees, orphaning the file in storage.
	const before = uploads;
	await dropOn(page, ZONE, [{ name: 'late.png', type: 'image/png' }]);
	await dragOver(page, ZONE);
	await expect(page.locator(ZONE)).not.toHaveClass(/drag-over/);
	// Past the moment a drop that DID land would have posted (mutation-checked).
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveCount(0);

	// The zone comes back once the submit settles, so a failed save is still
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
	await expect(save).toBeEnabled();
	await expect(page.locator(ZONE)).not.toHaveClass(/disabled/);
});

test('picking a sticker resets the input, and a picked wrong type is rejected', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${uploads}.png` })
		});
	});

	await page.goto('/admin/stickers/manual');
	await waitForDropAttachment(page, ZONE);
	const input = page.locator(`${ZONE} input[type="file"]`);

	await input.setInputFiles({
		name: 'sticker.png',
		mimeType: 'image/png',
		buffer: Buffer.from([1, 2, 3, 4])
	});
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x1.png');
	// Reset after the pick: left alone the input keeps a fakepath value, and
	// picking the same file again after a failure would fire no change event.
	await expect(input).toHaveValue('');

	// The picker's accept attribute is a filter the OS dialog can override, so a
	// JPEG can arrive from the input too and has to be rejected the way a dropped
	// one is. setInputFiles bypasses accept, which is what makes this
	// discriminate.
	const before = uploads;
	await input.setInputFiles({
		name: 'photo.jpg',
		mimeType: 'image/jpeg',
		buffer: Buffer.from([1, 2, 3, 4])
	});
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/photo\.jpg — That file type isn't supported\. Use PNG or WebP\./
	]);
	expect(uploads).toBe(before);
	await expect(page.locator('input[name="sticker[1][imageUrl]"]')).toHaveCount(0);
});

test('an oversized sticker is refused client-side, without a POST', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${uploads}.png` })
		});
	});

	await page.goto('/admin/stickers/manual');
	const status = page.locator('span.sr-only[role="status"]');
	await waitForDropAttachment(page, ZONE);

	// One byte past the cap /api/upload enforces. Without the client-side check
	// the whole 64 MB goes up the wire just to collect a 413, so the assertion
	// that matters is the absent request, not only the message.
	await dropOn(page, ZONE, [
		{ name: 'huge.png', type: 'image/png', size: MAX_BUFFER_BYTES + 1 },
		{ name: 'small.png', type: 'image/png' }
	]);
	// The rest of the batch still uploads — one bad file doesn't sink the drop.
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/x1.png');
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/huge\.png — This file is over 64\.0 MB\. Try a smaller image\./
	]);
	expect(uploads).toBe(1);
	await expect(status).toHaveText(
		'Sticker upload finished with errors. Each file that failed shows the reason.'
	);
});

test('a 413 reads as too large and a 415 as an unsupported type', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	// The form awaits each POST in turn, so the call index picks the status each
	// file gets back.
	let calls = 0;
	const statuses: Record<number, number> = { 1: 413, 2: 415 };
	await page.route('**/api/upload', async (route) => {
		calls++;
		const status = statuses[calls];
		if (status) {
			await route.fulfill({ status, contentType: 'text/plain', body: 'nope' });
			return;
		}
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: `/x${calls}.png` })
		});
	});

	await page.goto('/admin/stickers/manual');
	await waitForDropAttachment(page, ZONE);

	// Both files pass the client-side checks (right type, small enough), so the
	// reason on each line can only have come from the server's status code.
	await dropOn(page, ZONE, [
		{ name: 'big.png', type: 'image/png' },
		{ name: 'odd.png', type: 'image/png' }
	]);
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/big\.png — This file is over 64\.0 MB\. Try a smaller image\./,
		/odd\.png — That file type isn't supported\. Use PNG or WebP\./
	]);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveCount(0);
});

test('a 200 without a usable url is a failure, not a row pointing nowhere', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	// A 2xx the form cannot read a URL out of. Stored as-is it would add a
	// sticker row whose imageUrl is empty, and the pack would save broken.
	let body = '{}';
	await page.route('**/api/upload', async (route) => {
		await route.fulfill({ contentType: 'application/json', body });
	});

	await page.goto('/admin/stickers/manual');
	await waitForDropAttachment(page, ZONE);

	await dropOn(page, ZONE, [{ name: 'a.png', type: 'image/png' }]);
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/a\.png — Upload failed\. Check your connection and try again\./
	]);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveCount(0);

	// An empty string is a url the body does carry, so only a non-empty check
	// keeps it out of a row.
	body = '{"url":""}';
	await dropOn(page, ZONE, [{ name: 'b.png', type: 'image/png' }]);
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/b\.png — Upload failed\. Check your connection and try again\./
	]);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveCount(0);
});

test('the same status twice is announced twice', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	await page.route('**/api/upload', async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/stickers/manual');
	await waitForDropAttachment(page, ZONE);
	const status = page.locator('span.sr-only[role="status"]');

	await dropOn(page, ZONE, [{ name: 'a.png', type: 'image/png' }]);
	await expect(status).toHaveText('1 sticker added');

	// Two single-file drops produce the same text, and a screen reader only
	// announces a live region that CHANGES: re-assigning the string it already
	// holds touches no DOM and says nothing. Tag the node inside the region,
	// then prove the tag (and so the node) is gone — the same shape as the model
	// banner's remount test in vr-admin-form.spec.ts.
	await status.locator('span').evaluate((el) => el.setAttribute('data-first-status', ''));
	await dropOn(page, ZONE, [{ name: 'b.png', type: 'image/png' }]);
	await expect(page.locator('input[name="sticker[1][imageUrl]"]')).toHaveValue('/x.png');
	await expect(status.locator('span[data-first-status]')).toHaveCount(0);
	await expect(status).toHaveText('1 sticker added');
});
