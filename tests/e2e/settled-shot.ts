import { expect, type Page } from '@playwright/test';

// A full-page screenshot taken once the page has stopped moving. A capture
// straight after a navigation or a save can land mid view-transition, with the
// old page cross-faded over the new one, and then it isn't evidence of
// anything. The caller asserts what the page should show first; this then
// waits until no animation is running (view transitions included) and shoots.
export async function settledShot(page: Page, path: string) {
	await expect
		.poll(() => page.evaluate(() => document.getAnimations().length), {
			message: 'the page finishes animating before the screenshot'
		})
		.toBe(0);
	await page.screenshot({ path, fullPage: true });
}
