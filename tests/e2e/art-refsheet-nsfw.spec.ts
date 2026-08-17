import { test, expect, type Page } from '@playwright/test';

// /art's NSFW reference sheet (SONA-18). The seed designates a published,
// non-variant NSFW image on the owner character, so the operator's designation
// is honored and the sheet arrives behind the same blur-and-reveal shield the
// gallery hero uses. The unit tests pin the query and the markup; this spec is
// the only thing that proves the load-to-page wiring holds in a browser and
// that the overlay is actually clickable where it is drawn.

const SHEET = '/gallery/mature-ref-sheet';

const frame = (page: Page) => page.locator('.ref-sheet.shielded');
const revealBtn = (page: Page) => page.locator('.ref-sheet .reveal-btn');
const sheetImg = (page: Page) => page.locator('.ref-sheet img');
const sheetLink = (page: Page) => page.locator(`a.ref-sheet[href="${SHEET}"]`);
const captionLink = (page: Page) => page.locator(`.caption a[href="${SHEET}"]`);

test.describe('/art NSFW reference sheet', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/art');
	});

	test('the designated NSFW sheet is shown, blurred, and not wrapped in the gallery link', async ({
		page
	}) => {
		await expect(frame(page)).toHaveCount(1);
		await expect(sheetImg(page)).toHaveClass(/blurred/);
		await expect(revealBtn(page)).toBeVisible();
		// Shielded, the frame must NOT be the link — a link under the overlay
		// would give one image two competing targets.
		await expect(sheetLink(page)).toHaveCount(0);
	});

	test('the caption keeps a working route to the gallery while shielded', async ({ page }) => {
		// The only route onward without JS, so it has to navigate, not just exist.
		await expect(captionLink(page)).toBeVisible();
		await captionLink(page).click();
		await expect(page).toHaveURL(new RegExp(`${SHEET}$`));
	});

	test('revealing clears the blur and lands focus on the now-linked sheet', async ({ page }) => {
		// Hydration-retry headroom for the reveal-click loop below (SONA-164).
		test.slow();
		// Reveal is a client action; retry until the click lands post-hydration.
		// Each attempt restarts from a fresh pre-reveal page, because a click that
		// landed late leaves no button for a click-only retry to hit.
		await expect(async () => {
			await page.goto('/art');
			await expect(revealBtn(page)).toHaveCount(1);
			await revealBtn(page).click();
			await expect(revealBtn(page)).toHaveCount(0, { timeout: 1500 });
		}).toPass({ timeout: 45_000 });

		await expect(frame(page)).toHaveCount(0);
		await expect(sheetImg(page)).not.toHaveClass(/blurred/);
		// Focus has to follow the button that just unmounted itself.
		await expect(sheetLink(page)).toBeFocused();
		await expect(page.locator('[role="status"]')).not.toBeEmpty();
	});
});
