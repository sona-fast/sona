import { test, expect, type Page } from '@playwright/test';
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

// Opening the confirmation must not move the destructive button under the
// pointer: while the block's top edge shifted up on the swap, the confirm
// Remove landed on the pixel Remove key was just clicked, so a double click or
// an impatient second tap removed the key without the question being read.
// Clicks Remove key at its own centre and asks where that point ends up.
// Both boxes are read in one coordinate frame: the button is centred in the
// viewport first and the click goes through page.mouse at that exact point,
// because locator.click() scrolls the button into view itself — after which the
// "before" box belongs to a frame the confirm button was never measured in, and
// at 390px the button's centre sits under the bottom tab bar, so the click that
// "worked" was a click at some other pixel entirely.
async function openConfirmClearOfThePointer(page: Page) {
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
	const confirm = confirmPanel(page).getByRole('button', { name: 'Remove', exact: true });
	const after = await confirm.boundingBox();
	if (!after) throw new Error('Remove (confirm) has no bounding box');
	// Both boxes are viewport-relative, which is the frame the pointer lives in:
	// focusing Keep can scroll the page, and whatever that scroll brings under
	// the pointer is exactly what a second click would hit. So the shift is
	// reported, not corrected for.
	const scrolled = (await page.evaluate(() => window.scrollY)) - frame;
	const covers =
		point.x >= after.x &&
		point.x <= after.x + after.width &&
		point.y >= after.y &&
		point.y <= after.y + after.height;
	expect(
		covers,
		`confirm Remove covers the clicked point at ${page.viewportSize()?.width}px (page scrolled ${scrolled}px)`
	).toBe(false);
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
		await keyInput(page).fill(FAKE_KEY);
		await saveButton(page).click();

		// Connected: the eyebrow, and the mask — never the key itself.
		await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible();
		await expect(keyRecord(page)).toContainText('8901');
		await expect(keyRecord(page)).not.toContainText('e2e-fuzzysearch');
		await expect(keyInput(page)).toHaveCount(0);
		// The save form unmounts and takes the focused Save button with it, so the
		// button that replaces it has to pick focus up.
		await expect(removeButton(page)).toBeFocused();

		// Removal asks first, and moves focus onto the safe choice — every button
		// involved unmounts as the panel opens, so without that a keyboard user
		// lands back on <body>.
		await openConfirmClearOfThePointer(page);
		const keep = confirmPanel(page).getByRole('button', { name: 'Keep', exact: true });
		await expect(keep).toBeFocused();

		// Keep restores the connected state and hands focus back.
		await keep.click();
		await expect(confirmPanel(page)).toHaveCount(0);
		await expect(keyRecord(page)).toContainText('8901');
		await expect(removeButton(page)).toBeFocused();

		// Again at 390, where the block is taller and the shift used to be larger.
		const desktop = page.viewportSize();
		await page.setViewportSize({ width: 390, height: 844 });
		await openConfirmClearOfThePointer(page);
		await confirmPanel(page).getByRole('button', { name: 'Keep', exact: true }).click();
		await expect(confirmPanel(page)).toHaveCount(0);
		if (desktop) await page.setViewportSize(desktop);

		// Remove, confirmed, clears the key and returns the section to its
		// unconnected state — the state the seed hands every other spec.
		await removeButton(page).click();
		await confirmPanel(page).getByRole('button', { name: 'Remove', exact: true }).click();
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
		await confirmPanel(page).getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(keyRecord(page)).toHaveCount(0);
	} finally {
		await page.close();
	}
});
