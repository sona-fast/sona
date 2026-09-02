import { test, expect, type Route } from '@playwright/test';
import { adminLogin } from './admin-login';
import { dropOn, dragOver, expectDragOverHighlight, waitForDropAttachment } from './drop-files';

// VR avatar admin form smoke (SONA-124, T1): VrAvatarForm and the /admin/vr/new
// page never executed in any test before this. (The SONA-124 early-access gate
// retired at GA — SONA-157 — so the form needs no bypass to be reachable.)
//
// Runs on the SHARED read-only DB/server under fullyParallel: everything here
// READS and types into the client-side form without ever submitting it, so it
// cannot perturb the other specs.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
// The model zone; the showcase media zone shares the class.
const MODEL_ZONE = 'label.upload-zone:not(.media-zone)';

test('the create form renders its fields, dropzones and credit control', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	await expect(page.getByRole('heading', { name: 'Add avatar' })).toBeVisible();
	await expect(page.locator('input[name="name"]')).toBeVisible();
	await expect(page.locator('input[name="slug"]')).toBeVisible();
	await expect(page.locator('select[name="characterId"]')).toBeVisible();

	// Model dropzone.
	await expect(page.getByText(/Choose a \.vrm or \.fbx file, or drag it here/)).toBeVisible();
	// Format expectations under the dropzone (VR feedback round): which VRM
	// versions the viewer takes, and that FBX is download-only.
	await expect(page.getByText(/VRM 0\.x and 1\.0 both work in the 3D viewer/)).toBeVisible();
	await expect(page.getByText(/offer FBX files as a download/)).toBeVisible();
	// The hint is wired to the file input, not just placed near it (a11y): on
	// the create form only the dropzone branch renders, so this is unambiguous.
	await expect(page.locator('input.sr-file[accept=".vrm,.fbx"]')).toHaveAttribute(
		'aria-describedby',
		'vr-model-hint'
	);

	// Showcase media manager (SP1) with its own dropzone.
	await expect(page.getByRole('heading', { name: 'Showcase media' })).toBeVisible();
	await expect(page.getByText(/Choose screenshots or short \.webm clips, or drag them here/)).toBeVisible();

	// Credits editor entry point.
	await expect(page.getByRole('button', { name: 'Add credit' })).toBeVisible();
	// The gallery/sticker artist affordance is reused here: each credit row's
	// select carries a New-artist button (registry search lives inside the
	// dialog when connected). Rows start empty on /new, so add one first —
	// with the hydration-retry shape: a pre-hydration click silently no-ops.
	await expect(async () => {
		await page.getByRole('button', { name: 'Add credit' }).click();
		await expect(page.getByRole('button', { name: 'New artist for credit 1' })).toBeVisible({
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	// Visibility switches are named (a11y wiring, not just visuals).
	await expect(page.getByRole('checkbox', { name: 'Offer model download' })).toBeAttached();
	// The honesty note on the download toggle (VR feedback round): hiding the
	// button is not access control, because for VRM the viewer fetches the
	// same file anyway.
	await expect(page.getByText(/hides the download button without preventing access/)).toBeVisible();
	// …and the note is wired to the checkbox via aria-describedby (partial
	// match: the accessible description concatenates the state text and hint).
	await expect(page.getByRole('checkbox', { name: 'Offer model download' })).toHaveAccessibleDescription(
		/hides the download button without preventing access/
	);
	await expect(page.getByRole('checkbox', { name: 'Mark as NSFW' })).toBeAttached();
	await expect(page.getByRole('checkbox', { name: 'Published' })).toBeAttached();
});

test('the model section links to the export guide', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// Entry point to /admin/vr/guide (SONA-162): sits right below the
	// model-format hint, on both /new and /[id]/edit via the shared form.
	// The full composed accessible name, including the sr-only "(opens in a
	// new tab)" suffix and the space separating it from the visible label.
	const link = page.getByRole('link', { name: /How to export a VRM from VRChat \(opens in a new tab\)/ });
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute('href', '/admin/vr/guide');
	// New tab: a docs link must not navigate away from a half-filled form.
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('rel', 'noopener');
});

test("poster picker cells stay square even when the button's aspect-ratio is ignored", async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// CI simulates an engine that ignores aspect-ratio on form controls (the
	// override below) so the IMG's own aspect-ratio must hold the cell square;
	// the sizing rationale lives on the .poster-option img rule in VrAvatarForm.
	await page.waitForSelector('.poster-option img');
	await page.addStyleTag({ content: '.poster-option { aspect-ratio: auto !important; }' });
	// Assert the computed style directly so the check can't go vacuous if a
	// future fixture happens to be square (or still loading) by coincidence.
	await expect(page.locator('.poster-option img').first()).toHaveCSS('aspect-ratio', '1 / 1');
	const box = await page.locator('.poster-option').first().boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeGreaterThan(40);
	expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
});

test("the name placeholder names the site's own character and follows the select", async ({
	page
}) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// Seeded characters: 'Taro' (id 1, sorts first) and 'Thistle' (id 2, is_owner).
	// With nothing selected the example must be the SITE'S sona, so neither the
	// old hardcoded 'Taro' nor a first-row-by-name fallback can satisfy this.
	await expect(page.locator('input[name="name"]')).toHaveAttribute(
		'placeholder',
		'e.g. Thistle (VRChat)'
	);

	// Picking a character re-derives the example (hydration-retry shape: a
	// pre-hydration selection does not re-render the placeholder).
	await expect(async () => {
		await page.selectOption('select[name="characterId"]', { label: 'Taro' });
		await expect(page.locator('input[name="name"]')).toHaveAttribute(
			'placeholder',
			'e.g. Taro (VRChat)',
			{ timeout: 2000 }
		);
	}).toPass({ timeout: 20_000 });
});

test('the edit form seeds the placeholder from the avatar\'s own character', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/1/edit');

	// Avatar 1 belongs to 'Taro' (id 1), so the selected character must win over
	// the site's own 'Thistle'. Scope honestly: 'Taro' is ALSO first by name, so
	// this cannot discriminate a first-row-by-name regression (mutation-checked)
	// — it pins the selected-character arm on a real edit load, and that the page
	// no longer shows the old hardcoded example. The owner arm is unreachable
	// here anyway: vr_avatars.character_id is NOT NULL, so one is always selected.
	await expect(page.locator('input[name="name"]')).toHaveAttribute(
		'placeholder',
		'e.g. Taro (VRChat)'
	);
});

test('typing a name auto-suggests the slug until the slug is touched', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	// Hydration-retry shape (see upload.spec.ts): typing before Svelte attaches
	// its delegated listeners silently does nothing, so retype until the
	// suggestion appears. Client-side only — the form is never submitted.
	await expect(async () => {
		await page.fill('input[name="name"]', '');
		await page.fill('input[name="name"]', 'Taro VRChat!');
		await expect(page.locator('input[name="slug"]')).toHaveValue('taro-vrchat', {
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });

	// Adding a credit row exercises the credits editor client path.
	await page.getByRole('button', { name: 'Add credit' }).click();
	await expect(page.locator('select[name="credit[0][artistId]"]')).toBeVisible();
});

test('dropping a file on the showcase media zone uploads it, and a wrong type is rejected without a request', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	// Stub the upload endpoint: this spec shares a read-only server with the rest
	// of the suite, so a real POST would leave an orphaned stored file behind.
	// `hold`, when set, keeps a request in flight so the busy zone can be probed.
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

	await page.goto('/admin/vr/new');
	await expect(page.getByText(/Choose screenshots or short \.webm clips, or drag them here/)).toBeVisible();

	// Hydration-retry shape (see upload.spec.ts): a drop dispatched before the
	// attachment has run silently does nothing. The counter resets per attempt.
	await expect(async () => {
		uploads = 0;
		await dropOn(page, '.media-zone', [{ name: 'shot.png', type: 'image/png' }]);
		await expect(page.locator('input[name="media[0][url]"]')).toHaveValue('/x.png', {
			timeout: 2000
		});
		expect(uploads).toBe(1);
	}).toPass({ timeout: 20_000 });

	// A dropped file skips the input's accept filter, so the zone has to reject
	// the wrong type itself: the bad-type banner, and no POST.
	const before = uploads;
	await dropOn(page, '.media-zone', [{ name: 'notes.txt', type: 'text/plain' }]);
	await expect(page.getByText(/That file type isn't supported/)).toBeVisible();
	expect(uploads).toBe(before);
	// The status region moves on from the previous batch's success text too.
	await expect(page.getByText(/Media upload finished with errors/)).toBeAttached();

	// While an upload runs the zone dims, but it must keep receiving pointer and
	// drag events: `pointer-events: none` on .disabled would let the next drop
	// reach the document and navigate the tab to the file. It still refuses the
	// drop — no highlight — it just has to be the one refusing.
	hold = new Promise<void>((resolve) => (release = resolve));
	// Resting border, read while the zone is idle: keeping pointer events also
	// keeps :hover alive, so the busy zone must hold this colour instead of
	// lighting up primary as if it would take a click.
	const restingBorder = await page
		.locator('.media-zone')
		.evaluate((el) => getComputedStyle(el).borderColor);
	await dropOn(page, '.media-zone', [{ name: 'slow.png', type: 'image/png' }]);
	const busy = page.locator('.media-zone.disabled');
	await expect(busy).toBeVisible();
	expect(await busy.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe('none');
	await dragOver(page, '.media-zone');
	await expect(busy).not.toHaveClass(/drag-over/);
	await busy.hover();
	// Past the zone's 0.15s border-color transition: read any sooner and a border
	// that IS heading for primary still measures as the resting colour, which
	// would make the assertion below pass either way (mutation-checked).
	await page.waitForTimeout(400);
	expect(await busy.evaluate((el) => getComputedStyle(el).borderColor)).toBe(restingBorder);
	release();
	await expect(page.locator('.media-zone.disabled')).toHaveCount(0);

	// The picker path partitions too: `accept` is only a filter the OS dialog
	// can override, and setInputFiles bypasses it the same way.
	const beforePick = uploads;
	await page.locator('.media-zone input[type="file"]').setInputFiles({
		name: 'notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('nope')
	});
	await expect(page.getByText(/That file type isn't supported/)).toBeVisible();
	await page.waitForTimeout(300);
	expect(uploads).toBe(beforePick);
});

test('dropping a model file on the model zone uploads one, and a wrong type is rejected without a request', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);

	// Stubbed for the same reason as the media endpoint above: this spec shares a
	// read-only server, so a real POST would leave a stored file behind.
	// `hold`, when set, keeps a request in flight so the progress bar can be
	// probed while it is on screen.
	let uploads = 0;
	let hold: Promise<void> | null = null;
	let release = () => {};
	await page.route('**/api/admin/vr-model*', async (route) => {
		uploads++;
		if (hold) await hold;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/m.vrm', size: 4, format: 'vrm' })
		});
	});

	await page.goto('/admin/vr/new');
	// The model zone, not the showcase-media one — both carry .upload-zone.
	const zone = page.locator(MODEL_ZONE);
	await expect(zone).toBeVisible();

	// Files dropped from a file manager often arrive with an empty type, so the
	// extension is all the accept match has to work from. That is safe here and
	// not on the media zone: this endpoint keys off the filename, /api/upload
	// off the declared MIME type.
	const drop = (names: string[]) =>
		dropOn(
			page,
			MODEL_ZONE,
			names.map((name) => ({ name, type: '' }))
		);

	// Wrong type first: a successful drop swaps the zone for the model card, so
	// this branch has to run while the zone is still on screen.
	await expect(async () => {
		uploads = 0;
		await drop(['notes.txt']);
		await expect(page.getByText(/That file doesn't look like a VRM or FBX model/)).toBeVisible({
			timeout: 2000
		});
		expect(uploads).toBe(0);
	}).toPass({ timeout: 20_000 });

	// The same error twice: the banner is remounted per error, because a screen
	// reader announces role="alert" on insertion only — leaving the first node in
	// place would make the second drop silent. Tag the node, then prove the tag
	// (and so the node) is gone.
	await page.locator('.banner.err').evaluate((el) => el.setAttribute('data-first-error', ''));
	await drop(['notes.txt']);
	await expect(page.locator('.banner.err[data-first-error]')).toHaveCount(0);
	await expect(page.getByText(/That file doesn't look like a VRM or FBX model/)).toBeVisible();

	await expectDragOverHighlight(page, MODEL_ZONE);

	// Two files, one model slot: only the first is uploaded, and only one
	// request goes out.
	const before = uploads;
	await drop(['a.vrm', 'b.vrm']);
	await expect(page.locator('.model-name')).toHaveText('a.vrm');
	expect(uploads).toBe(before + 1);

	// While an upload runs the progress bar takes the zone's place. A drop there
	// misses every zone, so the page-wide guard has to cancel it or the browser
	// navigates the tab to the file, losing the form. dropOn reports whether
	// preventDefault was called, which is the cancellation itself — a dispatched
	// DragEvent never navigates on its own.
	// A drop that misses the Replace button and lands on the card is swallowed:
	// cancelled, no request, so the browser never navigates to the file.
	const beforeCard = uploads;
	expect(await dropOn(page, '.model-card', [{ name: 'x.vrm', type: '' }])).toBe(true);
	expect(uploads).toBe(beforeCard);
	// The Replace button is a drop target too, and paints its own highlight.
	await expectDragOverHighlight(page, 'label.btn-sm');
	hold = new Promise<void>((resolve) => (release = resolve));
	const url = page.url();
	const during = uploads;
	await dropOn(page, 'label.btn-sm', [{ name: 'c.vrm', type: '' }]);
	await expect(page.locator('.upload-progress')).toBeVisible();
	expect(await dropOn(page, '.upload-progress', [{ name: 'd.vrm', type: '' }])).toBe(true);
	expect(uploads).toBe(during + 1);
	expect(page.url()).toBe(url);
	release();
	await expect(page.locator('.model-name')).toHaveText('c.vrm');

	// With a model in place, the Replace button is gated on a save in flight the
	// same way the zones are. Hold the POST inside the browser; the shared
	// read-only server never sees it.
	let holdPost = (_route: Route) => {};
	const posted = new Promise<Route>((resolve) => (holdPost = resolve));
	await page.route('**/admin/vr/new**', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.fallback();
			return;
		}
		holdPost(route);
	});
	await page.fill('input[name="name"]', 'Save gate');
	await page.fill('input[name="slug"]', 'save-gate');
	await page.selectOption('select[name="characterId"]', { label: 'Taro' });
	await page.getByRole('button', { name: 'Create avatar' }).click();
	await expect(page.locator('form.form button[type="submit"]')).toBeDisabled();
	const replace = page.locator('label.btn-sm');
	await expect(replace).toHaveClass(/disabled/);
	// Remove mutates modelUrl the same way a replace does, so it waits too.
	await expect(page.locator('.model-actions button')).toBeDisabled();
	const beforeSave = uploads;
	await dropOn(page, 'label.btn-sm', [{ name: 'e.vrm', type: '' }]);
	await page.waitForTimeout(300);
	expect(uploads).toBe(beforeSave);
	await expect(page.locator('.model-name')).toHaveText('c.vrm');
	await (await posted).fulfill({
		contentType: 'application/json',
		body: JSON.stringify({ type: 'failure', status: 400, data: '[{"error":1},"Held by the test"]' })
	});
	await expect(replace).not.toHaveClass(/disabled/);
});

test('the showcase media zone refuses files while a save is in flight', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	let modelUploads = 0;
	await page.route('**/api/admin/vr-model**', async (route) => {
		modelUploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/m.vrm', size: 4, format: 'vrm' })
		});
	});

	await page.goto('/admin/vr/new');
	// Also the hydration probe: the attachment runs at hydration, so a click
	// before it would submit the form for real instead of through enhance.
	await waitForDropAttachment(page, '.media-zone');

	// Hold the form POST so `saving` stays true. page.route intercepts inside the
	// browser, so the shared read-only server never sees the request.
	let holdPost = (_route: Route) => {};
	const posted = new Promise<Route>((resolve) => (holdPost = resolve));
	await page.route('**/admin/vr/new**', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.fallback();
			return;
		}
		holdPost(route);
	});

	await page.fill('input[name="name"]', 'Save gate');
	await page.fill('input[name="slug"]', 'save-gate');
	await page.selectOption('select[name="characterId"]', { label: 'Taro' });
	// By role first, then by selector: the button's label swaps to "Saving..."
	// while the submit is in flight, so an accessible-name locator stops
	// matching exactly when the assertions need it.
	await page.getByRole('button', { name: 'Create avatar' }).click();
	const save = page.locator('form.form button[type="submit"]');
	await expect(save).toBeDisabled();
	await expect(page.locator('.media-zone')).toHaveClass(/disabled/);

	// A drop landing now would upload and append a row the already-serialized
	// submit never sees, orphaning the file in storage.
	const before = uploads;
	await dropOn(page, '.media-zone', [{ name: 'late.png', type: 'image/png' }]);
	await dragOver(page, '.media-zone');
	await expect(page.locator('.media-zone')).not.toHaveClass(/drag-over/);
	// Past the moment a drop that DID land would have posted (mutation-checked).
	await page.waitForTimeout(300);
	expect(uploads).toBe(before);
	await expect(page.locator('input[name="media[0][url]"]')).toHaveCount(0);

	// The model zone is gated the same way: a model dropped mid-save would
	// rewrite modelUrl after the body was serialized.
	const modelZone = page.locator(MODEL_ZONE);
	await expect(modelZone).toHaveClass(/disabled/);
	await dropOn(page, MODEL_ZONE, [{ name: 'late.vrm', type: '' }]);
	await dragOver(page, MODEL_ZONE);
	await expect(modelZone).not.toHaveClass(/drag-over/);
	await page.waitForTimeout(300);
	expect(modelUploads).toBe(0);
	await expect(page.locator('input[name="modelUrl"]')).toHaveValue('');

	// A drop that misses every zone (here: the form itself) is swallowed page-
	// wide, so the browser never navigates to the file.
	expect(await dropOn(page, 'form.form', [{ name: 'stray.png', type: 'image/png' }])).toBe(true);
	expect(uploads).toBe(before);

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
	await expect(page.locator('.media-zone')).not.toHaveClass(/disabled/);
	await expect(modelZone).not.toHaveClass(/disabled/);
});

test('a 200 without a usable url is a media failure, not a broken tile', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	// Same guard as the sticker form: a 2xx the form cannot read a URL out of
	// must land as a named failure, not a media row pointing at nothing.
	let body = '{}';
	await page.route('**/api/upload', async (route) => {
		await route.fulfill({ contentType: 'application/json', body });
	});

	await page.goto('/admin/vr/new');
	await waitForDropAttachment(page, '.media-zone');

	await dropOn(page, '.media-zone', [{ name: 'a.png', type: 'image/png' }]);
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/a\.png — Upload failed\. Check your connection and try again\./
	]);
	await expect(page.locator('input[name="media[0][url]"]')).toHaveCount(0);

	body = '{"url":""}';
	await dropOn(page, '.media-zone', [{ name: 'b.png', type: 'image/png' }]);
	await expect(page.locator('.banner.err .banner-line')).toHaveText([
		/b\.png — Upload failed\. Check your connection and try again\./
	]);
	await expect(page.locator('input[name="media[0][url]"]')).toHaveCount(0);
});

test('the same media status twice is announced twice', async ({ page }) => {
	await adminLogin(page, PASSWORD);

	await page.route('**/api/upload', async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/vr/new');
	await waitForDropAttachment(page, '.media-zone');
	// The form has two role="status" regions (model upload progress, then the
	// media status); the media one comes last in the document.
	const status = page.locator('span.sr-only[role="status"]').last();

	await dropOn(page, '.media-zone', [{ name: 'a.png', type: 'image/png' }]);
	await expect(status).toHaveText('Media upload finished.');

	// Re-assigning the text the region already holds touches no DOM and is not
	// announced; the keyed inner node must be replaced (see the sticker spec).
	await status.locator('span').evaluate((el) => el.setAttribute('data-first-status', ''));
	await dropOn(page, '.media-zone', [{ name: 'b.png', type: 'image/png' }]);
	await expect(page.locator('input[name="media[1][url]"]')).toHaveValue('/x.png');
	await expect(status.locator('span[data-first-status]')).toHaveCount(0);
	await expect(status).toHaveText('Media upload finished.');
});
