import { test, expect, type Page } from '@playwright/test';

// The mosaic homepage on wide screens. The seed fixture leaves landingLayout at
// its default, so the shared read-only server renders the mosaic hero with the
// seeded published SFW pieces. The strip of tilted image rows used to be a
// fixed 1700px wide: at 2560 it stopped a third of the way across and the
// banner showed plain background, and the 3-degree tilt opened the top-left
// and bottom-right corners even at 1440.
//
// Read-only throughout. This asserts geometry, not pixels: it samples a grid
// of points over the banner and asks the browser what is under each one.

/**
 * Samples a grid over the banner and returns the points with no mosaic cell
 * under them. A point is covered when a cell is under it or under a neighbour
 * 8px away: the 6px gaps between cells show the background by design.
 */
async function uncoveredPoints(page: Page) {
	return page.evaluate(() => {
		const banner = document.querySelector('.mosaic-banner')!.getBoundingClientRect();
		const cell = (x: number, y: number) =>
			document.elementsFromPoint(x, y).some((e) => e.classList.contains('mosaic-cell'));
		// Diagonals too: where a row gap crosses a cell gap, every straight
		// neighbour is still in a gap band.
		const covered = (x: number, y: number) =>
			[0, 8, -8].some((ox) => [0, 8, -8].some((oy) => cell(x + ox, y + oy)));
		const bad: [number, number][] = [];
		const xs: number[] = [];
		for (let x = banner.left + 2; x < banner.right - 2; x += 20) xs.push(x);
		xs.push(banner.right - 2);
		const ys: number[] = [];
		for (let y = banner.top + 2; y < banner.bottom - 2; y += 20) ys.push(y);
		ys.push(banner.bottom - 2);
		for (const y of ys) {
			for (const x of xs) {
				if (!covered(x, y)) bad.push([Math.round(x - banner.left), Math.round(y - banner.top)]);
			}
		}
		return { width: banner.width, height: banner.height, bad };
	});
}

for (const [width, height] of [
	[1440, 900],
	[2560, 1440],
	[3840, 1600]
]) {
	test(`the mosaic hero covers the whole banner at ${width}x${height}`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto('/');
		const banner = page.locator('.mosaic-banner');
		await expect(banner).toBeVisible();
		// Wider than the server's layout, the client re-lays the strip after
		// hydration, so wait for the inline geometry to land before sampling.
		if (width > 1920) {
			await expect(page.locator('.mosaic-tilt')).toHaveAttribute('style', /width:/);
		}

		// The banner as rendered, kept with the test output so a pass can be
		// looked at afterwards.
		await banner.screenshot({ path: test.info().outputPath(`mosaic-${width}.png`) });
		const result = await uncoveredPoints(page);
		expect(result.width).toBeGreaterThan(width - 40);
		expect(result.bad, `uncovered banner points (x, y)`).toEqual([]);
	});
}

test('a phone keeps the stylesheet geometry and is still fully covered', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expect(page.locator('.mosaic-banner')).toBeVisible();
	await expect(page.locator('.mosaic-tilt')).not.toHaveAttribute('style', /width:/);
	const result = await uncoveredPoints(page);
	expect(result.bad, `uncovered banner points (x, y)`).toEqual([]);
});
