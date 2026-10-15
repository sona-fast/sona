import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';
import { failOnPageErrors } from './page-errors';
import { contrastRatio } from './contrast';

// The commission ledger saved through the real form (SONA-236 PR 2): create an
// entry, move it to Delivered, refuse an out-of-date save from a second tab and
// bring the typed note back, then delete it. Its own writable server (the
// 'commissions' project in playwright.config.ts), where E2E_COMMISSION_GATE
// opens the early-access gate. The tests run in order on one ledger. Each step
// saves a screenshot under test-results.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

failOnPageErrors();
const TITLE = 'E2E ref sheet';

test.describe.configure({ mode: 'serial' });

/** A fresh document that has hydrated, so the status select and use:enhance
 * are attached before the test touches them. */
async function open(page: Page, url: string) {
	await gotoAfterLogin(page, url);
	await waitForHydration(page);
}

const section = (page: Page, heading: 'Active' | 'Finished') =>
	page.locator('section', { has: page.getByRole('heading', { level: 2, name: heading }) });

test('creates an entry that lists under Active', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');

	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(TITLE);
	await page.locator('label.char-chip', { hasText: 'Taro' }).click();
	await page.locator('label.char-chip', { hasText: 'Thistle' }).click();
	await page.getByLabel('Price').fill('120.00');
	await page.getByLabel('Currency').fill('USD');
	await page.getByLabel('Requested').fill('2026-10-02');

	// Hold the save so a second click and an Enter land while it's in flight.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let posts = 0;
	const createPost = (url: URL) => url.pathname === '/admin/commissions/new';
	await page.route(
		createPost,
		async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posts += 1;
			await held;
			await route.continue();
		}
	);
	const save = page.locator('form.entry-form button[type="submit"]');
	await save.click();
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(save).toBeFocused();
	await save.click({ force: true });
	await page.keyboard.press('Enter');
	await expect(save).toBeFocused();
	expect(posts).toBe(1);
	release();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	expect(posts).toBe(1);
	await page.unroute(createPost);
	// One save, one entry.
	await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toHaveCount(1);
	const row = section(page, 'Active').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Test Artist');
	await expect(row).toContainText('Taro, Thistle');
	await expect(row).toContainText('Applied');
	await expect(row).toContainText('Unpaid');
	await expect(section(page, 'Finished')).toContainText('Entries you mark Delivered, Not picked, or Canceled move here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-created.png'));

	// At tablet width the section is under the 760px the seven columns need, so
	// each row becomes a card: no header row, and the row lays out as a block.
	await page.setViewportSize({ width: 744, height: 1024 });
	await expect(section(page, 'Active').locator('thead')).toBeHidden();
	await expect(row).toHaveCSS('display', 'block');
	await settledShot(page, testInfo.outputPath('commission-ledger-cards-744.png'));
});

test('moving the entry to Delivered lists it under Finished', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// The saved price comes back in its typed form.
	await expect(page.getByLabel('Price')).toHaveValue('120.00');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).not.toHaveValue('');
	// A date the owner picks, which Add to gallery must keep later.
	await page.getByLabel('Delivered', { exact: true }).fill('2026-01-02');
	await settledShot(page, testInfo.outputPath('commission-entry-edit.png'));
	await page.getByRole('button', { name: 'Save changes' }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Delivered');
	await expect(row).toContainText('Not in your gallery');
	await expect(section(page, 'Active')).toContainText('Entries you mark Applied, Waitlisted, Accepted, or In progress show here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-finished.png'));
});

// One small PNG: the upload is stubbed below, so only the browser reads it.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

/** Uploads one file and saves it as `title`. The file goes to storage first;
 * the stub answers with an asset the site already serves, so the piece
 * renders. setInputFiles doesn't reach Svelte's delegated change handler, so
 * the change is dispatched by hand, retried until hydration attaches it. */
async function uploadPiece(page: Page, title: string, lands: RegExp = /\/admin\/commissions\?added=\d+$/) {
	await page.route(
		(url) => url.pathname === '/api/upload',
		(route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: '/e2e-avatar.svg' }) })
	);
	await expect(async () => {
		await page.setInputFiles('input[type="file"]', { name: 'piece.png', mimeType: 'image/png', buffer: PNG });
		await page.evaluate(() =>
			document.querySelector('input[type="file"]')!.dispatchEvent(new Event('change', { bubbles: true }))
		);
		await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/e2e-avatar.svg', { timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	await page.locator('input[name="title"]').fill(title);
	await page.getByRole('button', { name: 'Upload Artwork' }).click();
	await expect(page).toHaveURL(lands);
}

const galleryPanel = (page: Page) =>
	page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Gallery' }) });

test("leaving an entry's upload for a plain one drops everything the entry filled", async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await section(page, 'Finished').getByRole('link', { name: `Add to gallery: ${TITLE}` }).click();
	await expect(page.getByRole('note')).toContainText(`From your commission: ${TITLE}.`);
	await waitForHydration(page);
	await expect(page.locator('input[name="commissionId"]')).toHaveCount(1);

	// The sidebar's Upload is the same page with no entry: SvelteKit keeps the
	// page mounted across it unless something makes it start over.
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Upload' }).click();
	await expect(page).toHaveURL(/\/admin\/upload$/);
	await expect(page.getByText('From your commission')).toHaveCount(0);
	await expect(page.locator('input[name="commissionId"]')).toHaveCount(0);
	await expect(page.locator('select[name="artistId"]')).toHaveValue('');
	await expect(page.locator('input[name="char-1"]')).not.toBeChecked();
	await expect(page.locator('input[name="char-2"]')).not.toBeChecked();
	await expect(page.locator('input[name="published"]')).not.toBeChecked();
	await settledShot(page, testInfo.outputPath('commission-upload-plain-after-entry.png'));

	// Saved, it's an ordinary upload, and the entry stays as it was.
	await page.locator('select[name="artistId"]').selectOption({ label: 'Test Artist' });
	await uploadPiece(page, 'E2E unrelated piece', /\/admin\/images$/);
	await open(page, '/admin/commissions');
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Not in your gallery');
	await expect(row.getByRole('link', { name: 'E2E unrelated piece' })).toHaveCount(0);
});

test('Add to gallery uploads a new piece and links it to the entry', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Delivered and not in the gallery yet: the panel offers Add to gallery.
	const panel = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Gallery' }) });
	await expect(panel).toContainText('Not in your gallery');
	await expect(panel).toContainText('Opens the upload form with this entry');
	await expect(panel.getByRole('link', { name: 'Add to gallery' })).toHaveClass(/btn-primary/);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-delivered.png'));
	await panel.getByRole('link', { name: 'Add to gallery' }).click();

	await expect(page.getByRole('heading', { level: 1, name: 'Upload New Artwork' })).toBeVisible();
	await waitForHydration(page);
	await expect(page.getByRole('note')).toContainText(`From your commission: ${TITLE}.`);
	await expect(page.getByRole('note')).toContainText('This becomes a new piece.');
	// The artist and characters come from the entry. The title, source, and date
	// stay empty, and the piece starts private.
	await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
	await expect(page.locator('input[name="char-1"]')).toBeChecked();
	await expect(page.locator('input[name="char-2"]')).toBeChecked();
	await expect(page.locator('input[name="title"]')).toHaveValue('');
	await expect(page.locator('input[name="sourcePostUrl"]')).toHaveValue('');
	await expect(page.locator('input[name="commissionedAt"]')).toHaveValue('');
	await expect(page.locator('input[name="published"]')).toBeChecked();
	// No Look up artist and no prompt to set one up: it would send the image to
	// FuzzySearch, and the entry already names the artist.
	await expect(page.getByRole('button', { name: 'Look up artist' })).toHaveCount(0);
	await expect(page.locator('#lookup-hint')).toHaveCount(0);
	// A new piece can still become the owner's reference sheet.
	await expect(page.locator('input[name="useAsReference"]')).toHaveCount(1);
	await settledShot(page, testInfo.outputPath('commission-upload-prefilled.png'));

	await uploadPiece(page, 'E2E Snowfall');

	const notice = page.locator('.notice.ok');
	await expect(notice).toContainText('Added to your gallery as a private piece: E2E Snowfall.');
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row.getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await expect(row.locator('.thumb img')).toHaveAttribute('src', /e2e-avatar\.svg/);
	await settledShot(page, testInfo.outputPath('commission-ledger-linked.png'));

	// The entry's panel now shows the piece and offers a variant instead. Opened
	// by its address: a click straight after the upload's client-side redirect
	// can land before the ledger finishes settling and go nowhere.
	const editUrl = await row.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');
	await open(page, editUrl!);
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await expect(panel.getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await expect(panel.getByRole('link', { name: 'Add a variant' })).toHaveAttribute('href', /\/admin\/upload\?commission=\d+$/);
	await expect(panel.getByRole('link', { name: 'Add to gallery' })).toHaveCount(0);
	// The Delivered date the owner set stays as it was.
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue('2026-01-02');

	// Add a variant opens the upload for that piece: no group choice, and no
	// reference-sheet box, since a variant can't be the reference sheet.
	await panel.getByRole('link', { name: 'Add a variant' }).click();
	await expect(page.getByRole('note')).toContainText('This adds a variant to the piece E2E Snowfall.');
	await waitForHydration(page);
	await expect(page.getByText('Variant of', { exact: true })).toBeVisible();
	await expect(page.locator('input[name="groupMode"]')).toHaveCount(0);
	await expect(page.locator('input[name="useAsReference"]')).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-upload-variant.png'));
});

test('phone width: the ledger and the prefilled upload, light and dark', async ({ page }, testInfo) => {
	const title = 'E2E delivered';
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Status').selectOption('delivered');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);

	// One linked entry and one delivered entry not in the gallery yet.
	await page.setViewportSize({ width: 390, height: 844 });
	const shoot = async (name: string) => {
		for (const mode of ['light', 'dark']) {
			await page.evaluate((m) => document.documentElement.setAttribute('data-theme', m), mode);
			await settledShot(page, testInfo.outputPath(`${name}-390-${mode}.png`));
		}
	};
	await open(page, '/admin/commissions');
	await expect(section(page, 'Finished').getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await shoot('commission-ledger-phone');

	await section(page, 'Finished').getByRole('link', { name: `Add to gallery: ${title}` }).click();
	// The upload page drops its heading at phone width, so wait on the note.
	await expect(page.getByRole('note')).toContainText(`From your commission: ${title}.`);
	await waitForHydration(page);
	await shoot('commission-upload-prefilled-phone');

	// Leave the ledger as the next steps expect it: one entry.
	await page.setViewportSize({ width: 1280, height: 720 });
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: `Edit ${title}` }).getAttribute('href');
	await open(page, editUrl!);
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('link', { name: `Edit ${title}` })).toHaveCount(0);
});

test("an entry with no Delivered date gets the browser's date when added to the gallery", async ({ page }, testInfo) => {
	const title = 'E2E in progress';
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Status').selectOption('cancelled');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const editUrl = await page.getByRole('link', { name: `Edit ${title}` }).getAttribute('href');

	// Canceled: nothing to add.
	await open(page, editUrl!);
	await expect(galleryPanel(page)).toContainText("You can't add an entry marked Not picked or Canceled to your gallery.");
	await expect(galleryPanel(page).getByRole('link')).toHaveCount(0);
	await expect(galleryPanel(page).getByRole('button')).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-closed.png'));

	// In progress, with no Delivered date.
	await page.getByLabel('Status').selectOption('in_progress');
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue('');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await open(page, editUrl!);
	const add = galleryPanel(page).getByRole('link', { name: 'Add to gallery' });
	await expect(add).toBeVisible();
	await expect(add).toHaveClass(/btn-secondary/);
	await expect(galleryPanel(page)).toContainText('Saving the upload marks this entry Delivered.');
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-active.png'));

	// Unsaved changes hold the button back until they're saved or undone.
	await page.getByLabel('Notes').fill('Not saved yet');
	const held = galleryPanel(page).getByRole('button', { name: 'Add to gallery' });
	await expect(held).toHaveAttribute('aria-disabled', 'true');
	await expect(galleryPanel(page)).toContainText('Save your changes first.');
	// Held, it reads as not ready: the secondary fill, hover included, with a
	// label that still clears 4.5:1 as rendered.
	await held.hover();
	await expect.poll(() => held.evaluate((el) => el.getAnimations().length)).toBe(0);
	const [label, fill, secondary] = await held.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--secondary)';
		document.body.append(probe);
		const style = getComputedStyle(el);
		const found = [style.color, style.backgroundColor, getComputedStyle(probe).backgroundColor];
		probe.remove();
		return found;
	});
	expect(fill).toBe(secondary);
	expect(contrastRatio(label, fill)).toBeGreaterThanOrEqual(4.5);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-dirty.png'));
	await page.getByLabel('Notes').fill('');
	await expect(add).toBeVisible();

	await add.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Upload New Artwork' })).toBeVisible();
	await waitForHydration(page);
	await uploadPiece(page, 'E2E Second piece');

	// Delivered now, dated by the browser that saved it.
	const today = await page.evaluate(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	});
	await open(page, editUrl!);
	await expect(page.getByLabel('Status')).toHaveValue('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue(today);

	// Leave the ledger as the next steps expect it: one entry.
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('link', { name: `Edit ${title}` })).toHaveCount(0);
});

test('an out-of-date save is refused, and Reload entry brings the typed note back', async ({ page, context }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');

	// This tab opens the form first.
	await open(page, editUrl!);

	// Another tab changes the entry and saves.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByLabel('Title').fill(`${TITLE} (renamed)`);
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	// This tab, still on the old copy, changes the note and the payment.
	await page.getByLabel('Notes').fill('Typed before the reload.');
	await page.getByLabel('Payment').selectOption('deposit');

	// Record every text the alert ever shows, from the moment it's added, so a
	// first render with half the message (read out, then rewritten) is caught.
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { alertTexts: string[] }).alertTexts = seen;
		const record = (el: Element) => {
			const text = el.textContent?.trim() ?? '';
			if (seen.at(-1) !== text) seen.push(text);
		};
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
				for (const node of mutation.addedNodes) {
					if (node instanceof Element) node.querySelectorAll('[role="alert"]').forEach(record);
					if (node instanceof Element && node.matches('[role="alert"]')) record(node);
				}
				const alert = target?.closest('[role="alert"]');
				if (alert) record(alert);
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	await page.getByRole('button', { name: 'Save changes' }).click();

	const alert = page.getByRole('alert').filter({ hasText: 'changed after you opened it' });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText('Your note comes with it, but your changes to Payment don');
	await expect(alert).toBeFocused();
	const texts = await page.evaluate(() => (window as unknown as { alertTexts: string[] }).alertTexts);
	expect(texts.length, JSON.stringify(texts)).toBeGreaterThan(0);
	expect(texts[0]).toContain('your changes to Payment');
	expect(new Set(texts).size, JSON.stringify(texts)).toBe(1);
	await page.getByText('Why did this happen?').click();
	await expect(page.getByText('Another tab or device changed this entry')).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-stale.png'));

	await page.getByRole('button', { name: 'Reload entry' }).click();
	const notes = page.getByLabel('Notes');
	await expect(notes).toHaveValue('Typed before the reload.');
	await expect(notes).toBeFocused();
	await expect(page.getByLabel('Title')).toHaveValue(`${TITLE} (renamed)`);
	await expect(page.getByLabel('Payment')).toHaveValue('unpaid');
	await expect(page.getByText("Your note from before the reload isn't saved yet. Save changes to keep it.")).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-reloaded.png'));

	// The reloaded form carries the current version, so this save goes through.
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(section(page, 'Finished').getByRole('row', { name: /renamed/ })).toBeVisible();
});

test('an entry deleted elsewhere: save says so, and delete counts as done', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Both actions answer as the server does once the entry is gone. The stubs
	// never reach the server, so the entry is still there for the next test.
	const missing = { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'failure', status: 404, data: '[{"missing":1},true]' }) };
	const action = (name: string) => (url: URL) => url.pathname.endsWith('/edit') && url.search === `?/${name}`;
	await page.route(action('save'), (route) => route.fulfill(missing));
	await page.route(action('delete'), (route) => route.fulfill(missing));

	await page.getByRole('button', { name: 'Save changes' }).click();
	const alert = page.getByRole('alert').filter({ hasText: 'This entry was deleted somewhere else' });
	await expect(alert).toBeVisible();
	await expect(alert).toBeFocused();
	await expect(alert.getByRole('link', { name: 'Go back to your ledger' })).toHaveAttribute('href', '/admin/commissions');
	await expect(page.getByRole('status').filter({ hasText: "Couldn't save the entry" })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-missing.png'));

	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('status').filter({ hasText: "Couldn't delete the entry" })).toHaveCount(0);
});

test('deleting the entry empties the ledger', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Hovered, the label keeps 4.5:1 against what the browser actually paints.
	const deleteButton = page.getByRole('button', { name: 'Delete entry' });
	await deleteButton.hover();
	// The button eases its background, and reduced motion doesn't stop that, so
	// read the colors only once the hover has finished.
	await expect.poll(() => deleteButton.evaluate((el) => el.getAnimations().length)).toBe(0);
	const [color, background, pageBackground] = await deleteButton.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--background)';
		document.body.append(probe);
		const style = getComputedStyle(el);
		const found = [style.color, style.backgroundColor, getComputedStyle(probe).backgroundColor];
		probe.remove();
		return found;
	});
	expect(background).toBe(pageBackground);
	expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
	await deleteButton.click();
	const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
	await expect(dialog).toContainText('Test Artist stays in your artist list');
	await settledShot(page, testInfo.outputPath('commission-entry-delete.png'));
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-ledger-emptied.png'));
});
