import { test, expect, type Page, type Request } from '@playwright/test';
import { adminLogin } from './admin-login';

// Artist lookup key settings (SONA-156), driven in a real browser: the four
// states of the section on the Connections tab, and the two transitions that
// only exist client-side — the removal confirmation opening, and Keep putting
// the connected state back. Nothing renders Svelte under vitest, so the unit
// suite can only grep the source for these (page.server.test.ts does); whether
// the states actually swap is only answerable here.
//
// Mutating, and deliberately narrow about it: this spec submits exactly two
// actions, saveFuzzysearchKey and removeFuzzysearchKey, and ends with the key
// removed — which is the seeded state every other spec sees. The invalid-key
// submission below persists nothing (it fails the shape check server-side).

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// Printable ASCII, over eight characters: passes the action's shape check. Not
// a real FuzzySearch key — nothing here calls out.
const FAKE_KEY = 'e2e-fuzzysearch-key-8901';

const section = (page: Page) => page.locator('section.lookup-section');
const keyInput = (page: Page) => page.locator('input[name="fuzzysearchApiKey"]');
const saveButton = (page: Page) =>
	page.locator('form[action="?/saveFuzzysearchKey"] button[type="submit"]');
const removeButton = (page: Page) => section(page).locator('button.btn-remove');
const confirmPanel = (page: Page) => section(page).locator('.remove-confirm');
const keyRecord = (page: Page) => section(page).locator('.key-record');
const replaceLine = (page: Page) => section(page).locator('.replace-line');

// The confirmation ignores a click for the first half second it is open, so
// every deliberate confirm in this file waits the guard out first.
const REFLEX_GUARD_MS = 550;
async function confirmRemoval(page: Page) {
	await page.waitForTimeout(REFLEX_GUARD_MS);
	await confirmPanel(page).getByRole('button', { name: 'Remove', exact: true }).click();
}

// Opening the confirmation can put the destructive button under the pointer:
// the section is the last block on the tab, so focusing Keep scrolls the page
// up under a stationary pointer, and one more wrapped line in the confirmation
// sentence is enough for confirm Remove to land on the pixel Remove key was
// just clicked. Geometry cannot be made safe for every wrap, so what is proved
// here is the guard: a second click at that same pixel, straight away, removes
// nothing.
// The click goes through page.mouse at a point measured after centring the
// button, because locator.click() scrolls the button into view itself — after
// which the point belongs to a frame nothing else was measured in, and at 390px
// the button's centre sits under the bottom tab bar, so the click that "worked"
// was a click at some other pixel entirely.
async function openConfirmAndReflexClick(page: Page) {
	await removeButton(page).evaluate((el) => el.scrollIntoView({ block: 'center' }));
	const box = await removeButton(page).boundingBox();
	if (!box) throw new Error('Remove key has no bounding box');
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	// The pixel has to belong to Remove key itself, or the click below opens the
	// panel from somewhere else and the comparison proves nothing.
	const owner = await page.evaluate(
		({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.className ?? '',
		point
	);
	expect(owner, `the clicked pixel is Remove key at ${page.viewportSize()?.width}px`).toContain(
		'btn-remove'
	);
	const frame = await page.evaluate(() => window.scrollY);
	await page.mouse.click(point.x, point.y);
	await expect(confirmPanel(page)).toBeVisible();
	// The mechanism that holds the block still: the replace line stays rendered
	// while the confirmation is open, so the swap does not pull the block up.
	await expect(replaceLine(page)).toBeVisible();
	// Checked here rather than after the click below, which takes focus off Keep
	// wherever it lands: every button involved unmounts as the panel opens, so
	// without this a keyboard user is back on <body>.
	await expect(confirmPanel(page).getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
	const confirm = confirmPanel(page).getByRole('button', { name: 'Remove', exact: true });
	const after = await confirm.boundingBox();
	if (!after) throw new Error('Remove (confirm) has no bounding box');
	// Both boxes are viewport-relative, which is the frame the pointer lives in:
	// focusing Keep can scroll the page, and whatever that scroll brings under
	// the pointer is exactly what a second click would hit. Reported for
	// diagnosis only — whether the confirm covers the point varies with the
	// font metrics that decide how the sentence wraps, and either way the key
	// has to survive the click below.
	const scrolled = (await page.evaluate(() => window.scrollY)) - frame;
	const covers =
		point.x >= after.x &&
		point.x <= after.x + after.width &&
		point.y >= after.y &&
		point.y <= after.y + after.height;
	const where = `at ${page.viewportSize()?.width}px (page scrolled ${scrolled}px, confirm Remove ${covers ? 'covers' : 'clears'} the clicked point)`;

	// The reflex second click: same pixel, no pause. The listener pins the guard
	// at the wire rather than through the sleep — a swallowed click never submits,
	// so no removal POST may leave the page while the window is open.
	const removePosts: string[] = [];
	const watchRemovePosts = (request: Request) => {
		if (
			request.method() === 'POST' &&
			decodeURIComponent(request.url()).includes('?/removeFuzzysearchKey')
		)
			removePosts.push(request.url());
	};
	page.on('request', watchRemovePosts);
	await page.mouse.click(point.x, point.y);
	// Asserted after the guard window, not before it: an unguarded removal takes
	// a moment to come back, and checking too early passes while it is in flight.
	// The wait doubles as the one the caller needs before clicking for real.
	await page.waitForTimeout(REFLEX_GUARD_MS);
	page.off('request', watchRemovePosts);
	expect(removePosts, `the reflex click submitted nothing ${where}`).toEqual([]);
	await expect(confirmPanel(page), `the confirmation stayed open ${where}`).toBeVisible();
	await expect(keyRecord(page), `the key was not removed ${where}`).toContainText('8901');
	await expect(replaceLine(page), `the block held still ${where}`).toBeVisible();
}

// The connections sections are hidden by CSS until the tab is active, and the
// toggle is client JS — so the click only "takes" once hydrated (the
// supporter-key spec's retry shape).
async function openConnectionsTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Connections', exact: true }).click();
		await expect(section(page)).toBeVisible({ timeout: 1500 });
	}).toPass();
}

// Serial: the two tests below share one settings row, and the second one's
// starting point is the state the seed leaves behind.
test.describe.configure({ mode: 'serial' });

test.describe('admin settings artist lookup key', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
	});

	test('the unconnected state discloses what leaves the site and takes a key', async ({
		page
	}) => {
		// The disclosure is the reason the section leads with prose: an operator
		// has to read what gets sent before pasting a key.
		await expect(section(page)).toContainText('sends that image file to FuzzySearch');
		await expect(section(page)).toContainText('independent service, not part of Sona');
		await expect(keyInput(page)).toBeVisible();
		// Nothing saved yet: no masked record, no removal action.
		await expect(keyRecord(page)).toHaveCount(0);
		await expect(removeButton(page)).toHaveCount(0);
		// The link to a key comes before the button that wants one.
		const hint = section(page).locator('.hint');
		await expect(hint).toContainText('api.fuzzysearch.net/selfserve');
	});

	test('a malformed key is refused with the error wired to the field', async ({ page }) => {
		await keyInput(page).fill('nope');
		await saveButton(page).click();

		const error = section(page).locator('.field-error#fuzzysearch-key-error');
		await expect(error).toHaveText(/That doesn't look like a key\./);
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
		await expect(keyInput(page)).toHaveAttribute('aria-describedby', 'fuzzysearch-key-error');
		// Rejected before the write: the section is still the unconnected one.
		await expect(keyRecord(page)).toHaveCount(0);
	});

	test('saving connects, Keep backs out of removal, and Remove disconnects', async ({ page }) => {
		// Save is hydration-sensitive the same way the tab is: a click that lands
		// before use:enhance is attached posts the form natively, and the reload
		// resets the tab — the connected eyebrow is then in the DOM but hidden, so
		// every assertion below fails and the key stays saved in the shared seeded
		// DB. Retry until the save goes through the enhanced path: the marker only
		// survives if the page never reloaded.
		await expect(async () => {
			// Start every attempt from a known page: a retry that died with the
			// removal confirmation open would otherwise never see the Remove
			// button (it lives in the panel's else branch) and spin to the timeout.
			await page.goto('/admin/settings');
			await openConnectionsTab(page);
			if ((await removeButton(page).count()) > 0) {
				// The aborted attempt saved the key: put the section back to
				// unconnected before trying again.
				await removeButton(page).click();
				await confirmRemoval(page);
				await expect(keyInput(page)).toBeVisible();
				await openConnectionsTab(page);
			}
			await page.evaluate(() => {
				(window as unknown as Record<string, boolean>).__sonaSaveMarker = true;
			});
			await keyInput(page).fill(FAKE_KEY);
			await saveButton(page).click();
			// Connected: the eyebrow, and the mask — never the key itself.
			await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible({
				timeout: 1500
			});
			expect(
				await page.evaluate(
					() => (window as unknown as Record<string, boolean>).__sonaSaveMarker === true
				),
				'Save posted through use:enhance rather than reloading the page'
			).toBe(true);
		}).toPass();

		await expect(keyRecord(page)).toContainText('8901');
		await expect(keyRecord(page)).not.toContainText('e2e-fuzzysearch');
		await expect(keyInput(page)).toHaveCount(0);
		// The save form unmounts and takes the focused Save button with it, so the
		// button that replaces it has to pick focus up.
		await expect(removeButton(page)).toBeFocused();

		// Removal asks first, moves focus onto the safe choice, and swallows the
		// reflex second click at the pixel Remove key was on (both checked in the
		// helper).
		await openConfirmAndReflexClick(page);

		// Keep restores the connected state and hands focus back.
		await confirmPanel(page).getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(confirmPanel(page)).toHaveCount(0);
		await expect(keyRecord(page)).toContainText('8901');
		await expect(removeButton(page)).toBeFocused();

		// Again at 390, where the block is taller and the shift used to be larger.
		const desktop = page.viewportSize();
		await page.setViewportSize({ width: 390, height: 844 });
		await openConfirmAndReflexClick(page);
		await confirmPanel(page).getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(confirmPanel(page)).toHaveCount(0);
		if (desktop) await page.setViewportSize(desktop);

		// The guard is pointer-only, and the keyboard is the one modality that
		// cannot suffer the hazard: Shift+Tab from Keep onto confirm Remove and
		// press Enter with no pause at all — the key goes.
		await removeButton(page).click();
		await expect(
			confirmPanel(page).getByRole('button', { name: 'Keep', exact: true })
		).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		const confirmRemove = confirmPanel(page).getByRole('button', { name: 'Remove', exact: true });
		await expect(confirmRemove).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(keyRecord(page)).toHaveCount(0);
		await expect(keyInput(page)).toBeVisible();

		// Put the key back so the deliberate pointer removal below still has
		// something to remove. The page is hydrated by now (every click above went
		// through the enhanced path), so this needs no retry.
		await keyInput(page).fill(FAKE_KEY);
		await saveButton(page).click();
		await expect(keyRecord(page)).toContainText('8901');

		// Remove, confirmed, clears the key and returns the section to its
		// unconnected state — the state the seed hands every other spec.
		await removeButton(page).click();
		await confirmRemoval(page);
		await expect(keyRecord(page)).toHaveCount(0);
		await expect(keyInput(page)).toBeVisible();
		// Both confirmation buttons are gone, so focus has to land on the field
		// that replaced them rather than on <body>.
		await expect(keyInput(page)).toBeFocused();
	});
});

// The save above writes to the SHARED seeded DB. If anything between it and the
// final Remove fails, the key stays saved: the CI retry restarts this serial
// block at the unconnected-state test, which then fails for the wrong reason,
// and every later spec sees a connected section. Put the row back the way this
// file found it (legal.spec.ts carries the same guard for privacyPolicy).
test.afterAll(async ({ browser }) => {
	const page = await browser.newPage();
	try {
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
		if ((await removeButton(page).count()) === 0) return;
		await removeButton(page).click();
		await confirmRemoval(page);
		await expect(keyRecord(page)).toHaveCount(0);
	} finally {
		await page.close();
	}
});
