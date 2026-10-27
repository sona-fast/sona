import { test, expect, type Page } from '@playwright/test';
import { loginRetrying } from './admin-login';

// The per-type storage breakdown (SONA-192) on the admin Storage tab: under R2
// the loader lists the bucket and the tab renders a segmented bar + breakdown
// table; under UploadThing there is no per-prefix listing, so the table must be
// absent and the R2-only pointer shown instead. Unit tests cover the loader and
// the view module; only rendering the page proves the table's accessible
// structure (sr-only caption, column headers, fixed row order) and that the
// aria-hidden bar/table split survives markup changes.
//
// Runs against the ut-stat project's dedicated server (see playwright.config.ts):
// it flips the storage provider, which would race the shared server's specs. The
// R2 test also seeds one real object through /api/upload so a segment and a
// non-zero row render; the remaining rows stay zero rows.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';

// 1×1 transparent PNG (68 bytes) — a real raster so the server-side sniff
// passes; same fixture as upload.spec.ts.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

// Same retry pattern as ut-stat.spec.ts: the panel is display:none until the
// hydrated tab click lands.
async function openStorageTab(page: Page) {
	const tab = page.getByRole('tab', { name: 'Storage', exact: true });
	await expect(async () => {
		await tab.click();
		await expect(page.getByText('Provider', { exact: true })).toBeVisible({ timeout: 1500 });
	}).toPass();
}

// Select a provider via the real radio + save path (see ut-stat.spec.ts for why
// the wrapping label is clicked instead of the visually hidden input).
async function setProvider(page: Page, provider: 'uploadthing' | 'r2') {
	await openStorageTab(page);
	const radio = page.getByRole('radio', {
		name: provider === 'r2' ? /Cloudflare R2/ : /UploadThing/
	});
	await expect(async () => {
		await radio.locator('..').click();
		await expect(radio).toBeChecked({ timeout: 1500 });
	}).toPass();
	await page.getByRole('button', { name: 'Save storage settings' }).click();
	const expected = provider === 'r2' ? 'Cloudflare R2' : 'UploadThing';
	await expect(page.getByText('Provider', { exact: true }).locator('..')).toContainText(expected);
}

// The two tests flip the provider on one seeded DB — keep them off each other.
test.describe.configure({ mode: 'serial' });

test.describe('admin settings storage breakdown', () => {
	test.beforeEach(async ({ page }) => {
		await loginRetrying(page, PASSWORD);
		await page.goto('/admin/settings');
	});

	test('renders the accessible breakdown table and segmented bar under R2', async ({ page }) => {
		await setProvider(page, 'r2');

		// Seed one real artwork object into the local bucket through the real
		// upload endpoint (the page's admin session cookie rides along), so a
		// bar segment and a non-zero row have data to render.
		const upload = await page.request.post('/api/upload', {
			multipart: {
				file: { name: 'e2e-breakdown.png', mimeType: 'image/png', buffer: PNG },
				folder: 'artwork'
			}
		});
		expect(upload.ok()).toBe(true);
		await page.goto('/admin/settings');
		await openStorageTab(page);

		const table = page.locator('table.breakdown');
		await expect(table).toBeVisible();
		// The sr-only caption names the table for screen readers.
		await expect(table.locator('caption')).toHaveText('Storage by content type');

		// Four column headers, in order; the Files header is sr-only by design.
		// The Share header holds a hidden short twin for ≤520px, so its visible
		// (innerText) rendering is asserted rather than raw textContent —
		// case-insensitively, since innerText reflects the uppercase transform.
		const headers = table.locator('thead th');
		await expect(headers).toHaveCount(4);
		await expect(headers.nth(0)).toHaveText('Content type');
		await expect(headers.nth(1)).toHaveText('Files');
		await expect(headers.nth(2)).toHaveText('Size');
		await expect(headers.nth(3)).toHaveText(/^share of used$/i, { useInnerText: true });

		// ≤520px the short "Share" shows instead, with the full phrase sr-only
		// (kept in the accessibility tree, clipped off-screen — clipped text
		// still rides innerText, so the two spans are asserted separately).
		await page.setViewportSize({ width: 320, height: 800 });
		await expect(headers.nth(3).locator('.share-short')).toBeVisible();
		await expect(headers.nth(3).locator('.share-short')).toHaveText('Share');
		await expect(headers.nth(3).locator('.share-full')).toHaveText('Share of used');
		await page.setViewportSize({ width: 1280, height: 720 });

		// Seven rows in the fixed kind order: fursuit photos sixth, the
		// catch-all bucket last. Each type cell is a row header, so screen
		// readers announce the type with every value cell.
		const rows = table.locator('tbody tr');
		await expect(rows).toHaveCount(7);
		await expect(table.locator('tbody th[scope="row"]')).toHaveCount(7);
		await expect(rows.nth(5)).toContainText('Fursuit photos');
		await expect(rows.nth(6)).toContainText('Avatars & other files');

		// The seeded object shows up: an artwork segment with a real inline
		// width, and the artwork row carries a formatted non-zero size (68
		// bytes → 0.1 KB). The seed data also stages VR model files in the
		// bucket, so assert the artwork segment, not a total segment count.
		const seg = page.locator('.storage-seg.seg-artwork');
		await expect(seg).toHaveCount(1);
		const width = await seg.evaluate((el) => parseFloat((el as HTMLElement).style.width));
		expect(width).toBeGreaterThan(0);
		await expect(rows.nth(0)).toContainText('0.1 KB');

		// The segmented bar is redundant with the table, so it must stay out of
		// the accessibility tree.
		await expect(page.locator('.storage-bar[aria-hidden="true"]')).toHaveCount(1);

		// The bucket-derived file-count stat tile renders alongside the table,
		// labelled with its source so it can't be read as the D1 image count.
		await expect(
			page.locator('.storage-info .stat-label', { hasText: 'Bucket files' })
		).toBeVisible();
	});

	// The bar measures each type against the 10 GB plan limit, so on a small
	// instance most types are a fraction of a pixel. An earlier version only
	// checked the inline style width (always > 0) while Chrome drew those
	// segments as nothing but the 2px page-background separator: no color at
	// all. These assertions read what is actually rendered.
	test('every non-zero type shows a visible, ordered sliver of its color', async ({
		page
	}, testInfo) => {
		await setProvider(page, 'r2');
		const upload = await page.request.post('/api/upload', {
			multipart: {
				file: { name: 'e2e-breakdown-bar.png', mimeType: 'image/png', buffer: PNG },
				folder: 'artwork'
			}
		});
		expect(upload.ok()).toBe(true);
		await page.goto('/admin/settings');
		await openStorageTab(page);

		const bar = page.locator('.storage-bar[aria-hidden="true"]');
		await expect(bar).toBeVisible();
		// Kept on disk in the test's output folder so a pass can be checked by eye.
		const shot = async (name: string) => {
			const path = testInfo.outputPath(`${name}.png`);
			await bar.screenshot({ path });
			await testInfo.attach(name, { path, contentType: 'image/png' });
		};

		// Rendered geometry and color of each segment, plus the track it sits on.
		const measure = () =>
			bar.evaluate((barEl) => {
				const track = barEl.getBoundingClientRect();
				return {
					track: { left: track.left, right: track.right },
					trackColor: getComputedStyle(barEl).backgroundColor,
					segs: [...barEl.querySelectorAll<HTMLElement>('.storage-seg')].map((el) => {
						const r = el.getBoundingClientRect();
						const cs = getComputedStyle(el);
						const border = parseFloat(cs.borderLeftWidth);
						return {
							kind: [...el.classList].find((c) => c.startsWith('seg-'))!.slice(4),
							left: r.left,
							right: r.right,
							border,
							colorPx: r.width - border,
							color: cs.backgroundColor
						};
					})
				};
			});

		// Non-zero rows, in table order, are the segments the bar must show.
		const rowKinds = await page
			.locator('table.breakdown tbody tr:not(.zero) .swatch')
			.evaluateAll((els) =>
				els.map((el) => [...el.classList].find((c) => c.startsWith('seg-'))!.slice(4))
			);
		// The seed stages VR model files and the upload adds artwork, so there
		// are at least two segments and a separator between them.
		expect(rowKinds.length).toBeGreaterThan(1);

		const assertVisible = (m: Awaited<ReturnType<typeof measure>>, label: string) => {
			// Same kinds, same order as the table; zero-byte types draw nothing
			// (an empty segment would still paint a stray separator gap).
			expect(m.segs.map((s) => s.kind), label).toEqual(rowKinds);
			const colors = new Set<string>();
			m.segs.forEach((s, i) => {
				const what = `${label}: ${s.kind}`;
				expect(s.colorPx, what).toBeGreaterThanOrEqual(4);
				expect(s.color, what).not.toBe('rgba(0, 0, 0, 0)');
				expect(s.color, what).not.toBe(m.trackColor);
				// Separator between neighbours only; the first segment has none.
				expect(s.border, what).toBe(i === 0 ? 0 : 2);
				// Nothing is clipped by the track's overflow:hidden.
				expect(s.left, what).toBeGreaterThanOrEqual(m.track.left - 0.5);
				expect(s.right, what).toBeLessThanOrEqual(m.track.right + 0.5);
				colors.add(s.color);
			});
			// Each type keeps its own color.
			expect(colors.size, label).toBe(m.segs.length);
		};

		// Set each mode explicitly (the page's starting mode depends on the
		// server default), then put the original back.
		const setMode = (mode: string | null) =>
			page.evaluate((m) => {
				if (m === null) document.documentElement.removeAttribute('data-theme');
				else document.documentElement.setAttribute('data-theme', m);
			}, mode);
		const startMode = await page.locator('html').getAttribute('data-theme');

		await setMode('dark');
		const dark = await measure();
		assertVisible(dark, 'dark');
		await shot('storage-bar-dark');

		await setMode('light');
		const light = await measure();
		assertVisible(light, 'light');
		await shot('storage-bar-light');

		// Proves the mode switch reached the bar: each mode has its own palette.
		expect(light.segs.map((s) => s.color)).not.toEqual(dark.segs.map((s) => s.color));
		await setMode(startMode);

		// Narrowest supported viewport: the minimum widths still fit the track.
		await page.setViewportSize({ width: 320, height: 800 });
		assertVisible(await measure(), '320px');
		await shot('storage-bar-320');
		await page.setViewportSize({ width: 1280, height: 720 });

		// A nearly full bar: the first segment takes almost the whole track, as
		// a big type does near the 10 GB cap. The tiny types must still fit
		// inside the track rather than being pushed past overflow:hidden.
		await bar
			.locator('.storage-seg')
			.first()
			.evaluate((el) => ((el as HTMLElement).style.width = '99.9%'));
		assertVisible(await measure(), 'near full');
		await shot('storage-bar-near-full');
	});

	test('hides the table and shows the R2-only note under UploadThing', async ({ page }) => {
		await setProvider(page, 'uploadthing');

		await expect(page.locator('table.breakdown')).toHaveCount(0);
		await expect(
			page.getByText('Usage by content type is only available on Cloudflare R2.')
		).toBeVisible();
	});
});
