import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// VR avatar admin form smoke (SONA-124, T1): VrAvatarForm and the /admin/vr/new
// page never executed in any test before this. (The SONA-124 early-access gate
// retired at GA — SONA-157 — so the form needs no bypass to be reachable.)
//
// Runs on the SHARED read-only DB/server under fullyParallel: everything here
// READS and types into the client-side form without ever submitting it, so it
// cannot perturb the other specs.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('the create form renders its fields, dropzones and credit control', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/new');

	await expect(page.getByRole('heading', { name: 'Add avatar' })).toBeVisible();
	await expect(page.locator('input[name="name"]')).toBeVisible();
	await expect(page.locator('input[name="slug"]')).toBeVisible();
	await expect(page.locator('select[name="characterId"]')).toBeVisible();

	// Model dropzone.
	await expect(page.getByText(/Choose a \.vrm or \.fbx file to upload/)).toBeVisible();
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
	await expect(page.getByText(/Add screenshots or short \.webm clips/)).toBeVisible();

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
	let uploads = 0;
	await page.route('**/api/upload', async (route) => {
		uploads++;
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ url: '/x.png' })
		});
	});

	await page.goto('/admin/vr/new');
	await expect(page.getByText(/Add screenshots or short \.webm clips/)).toBeVisible();

	// The browser can't be driven to drag a real file in, so build a DataTransfer
	// in the page and dispatch the drop the attachment listens for.
	const drop = (name: string, type: string) =>
		page.evaluate(
			({ name, type }) => {
				const dt = new DataTransfer();
				dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name, { type }));
				document
					.querySelector('.media-zone')!
					.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
			},
			{ name, type }
		);

	// Hydration-retry shape (see upload.spec.ts): a drop dispatched before the
	// attachment has run silently does nothing. The counter resets per attempt.
	await expect(async () => {
		uploads = 0;
		await drop('shot.png', 'image/png');
		await expect(page.locator('input[name="media[0][url]"]')).toHaveValue('/x.png', {
			timeout: 2000
		});
	}).toPass({ timeout: 20_000 });
	expect(uploads).toBe(1);

	// A dropped file skips the input's accept filter, so the zone has to reject
	// the wrong type itself: the bad-type banner, and no POST.
	const before = uploads;
	await drop('notes.txt', 'text/plain');
	await expect(page.getByText(/That file type isn't supported/)).toBeVisible();
	expect(uploads).toBe(before);
});
