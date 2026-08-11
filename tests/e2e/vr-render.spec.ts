import { test, expect } from '@playwright/test';

// The real three.js render path (SONA-124 follow-up): every other VR spec stops
// at the "View in 3D" button because e2e-avatar's model is a 47-byte text stub
// that exists only to satisfy the R2 head probe — clicking through always ends
// in the error banner, so the GLTFLoader + three-vrm pipeline had zero e2e
// coverage. This spec drives the seeded e2e-textured avatar (avatar 4, whose
// R2 key serves the committed REAL fixture tests/e2e/fixtures/e2e-textured.vrm:
// a minimal VRM 1.0 — one quad with an embedded solid red-orange PNG as its
// baseColorTexture, plus the 15 humanoid bones three-vrm requires; generated
// by fixtures/generate-vr-fixture.mjs) through the viewer's actual code path:
// dynamic three/three-vrm imports, same-origin model fetch, GLTFLoader.parse,
// VRMLoaderPlugin, WebGL render.
//
// Runs on the SHARED read-only DB/server under fullyParallel: it only reads
// avatar 4's seeded row and R2 object, never submits a form.
//
// WebGL in CI comes from SwiftShader (see launchOptions in
// playwright.config.ts). If the context can't be created the spec fails
// loudly on the webgl-fallback assertion below rather than silently passing.

type Violation = { directive: string; blocked: string; source: string };

test('View in 3D renders the textured model: canvas mounts, texture pixels reach the screen, zero CSP violations', async ({
	page
}) => {
	// Cold dev servers transform three + three-vrm on first import; CI runners
	// rasterize on the CPU. Both overrun the default budget.
	test.slow();

	// CSP collector, same pattern as csp-check.spec.ts: the listener must be
	// installed before navigation and read from the page's window afterwards.
	await page.addInitScript(() => {
		(window as unknown as { __csp: Violation[] }).__csp = [];
		document.addEventListener('securitypolicyviolation', (e) => {
			(window as unknown as { __csp: Violation[] }).__csp.push({
				directive: e.violatedDirective,
				blocked: e.blockedURI,
				source: `${e.sourceFile}:${e.lineNumber}`
			});
		});
	});

	const pageErrors: string[] = [];
	page.on('pageerror', (e) => pageErrors.push(e.message));
	// Console errors, minus resource-load 404s: the seed's poster/media URLs are
	// same-origin placeholders that 404 by design (fixtures/seed.sql), and those
	// 404s surface as "Failed to load resource" console errors unrelated to the
	// model path under test.
	const consoleErrors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
			consoleErrors.push(msg.text());
		}
	});

	const resp = await page.goto('/vr/e2e-textured', { waitUntil: 'domcontentloaded' });
	// A 404 here means the seed drifted — fail before blaming the viewer.
	expect(resp?.status(), '/vr/e2e-textured seeded and published').toBe(200);

	// Click-until-it-takes: right after domcontentloaded the button exists in
	// the SSR markup but hydration may not have attached its listener yet, so a
	// single early click can be a silent no-op (observed on a cold dev server).
	// Retry the click until the viewer visibly reacts (loading panel or stage).
	await expect(async () => {
		if ((await page.locator('.loading-panel, .stage').count()) > 0) return;
		await page.getByRole('button', { name: 'View in 3D' }).click({ timeout: 2000 });
		await expect(page.locator('.loading-panel, .stage')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });

	// If WebGL context creation failed (missing SwiftShader flags, headless
	// regression), VrViewer renders this fallback instead of loading anything —
	// surface that as THE failure rather than a canvas-wait timeout.
	await expect(
		page.locator('.webgl-fallback'),
		'WebGL unavailable — check the SwiftShader launch args in playwright.config.ts'
	).toHaveCount(0);

	// Fetch → GLTFLoader.parse → VRMLoaderPlugin → renderer mount. The canvas
	// appearing at all already proves the fixture parsed as a valid VRM (a parse
	// or "not a VRM model" failure lands in the error banner, no canvas).
	await expect(page.locator('.stage canvas')).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('.load-error'), 'viewer error banner').toHaveCount(0);

	// Texture assertion. VrViewer exposes no scene handle (nothing on window),
	// and the WebGL drawing buffer can't be wrapped in a 2d context — so the
	// strongest available signal is rendered-pixel sampling: toDataURL read
	// inside a requestAnimationFrame callback. preserveDrawingBuffer is false,
	// but the component's render loop re-registers its own rAF before ours each
	// frame, so a callback registered while the loop runs executes AFTER that
	// frame's render and BEFORE compositing clears the buffer — the read sees
	// real pixels. Retried across frames in case the first reads race the mount.
	//
	// What red pixels prove: the fixture's material has NO baseColorFactor
	// (default white) and both scene lights are white, so red-dominant pixels
	// can only exist if the embedded PNG (solid 230,40,20) was decoded by
	// GLTFLoader's texture pipeline, attached as material.map, uploaded to the
	// GPU, and sampled during a real draw. A texture-load failure renders the
	// quad in flat white/gray (factor-only shading) and yields zero red pixels
	// — so this catches exactly the "model loads but textures silently don't"
	// regression class the stub could never see.
	const sample = await page.evaluate(async () => {
		const canvas = document.querySelector('.stage canvas') as HTMLCanvasElement | null;
		if (!canvas) return { pixels: 0, drawn: 0, red: 0 };
		const readFrame = () =>
			new Promise<string>((resolve) =>
				requestAnimationFrame(() => resolve(canvas.toDataURL('image/png')))
			);
		const count = async (dataUrl: string) => {
			const img = new Image();
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = reject;
				img.src = dataUrl;
			});
			const scratch = document.createElement('canvas');
			scratch.width = img.width;
			scratch.height = img.height;
			const ctx = scratch.getContext('2d')!;
			ctx.drawImage(img, 0, 0);
			const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
			let drawn = 0;
			let red = 0;
			for (let i = 0; i < data.length; i += 4) {
				// Anything opaque was drawn by the renderer (alpha:true clears to
				// transparent, so background pixels have alpha 0).
				if (data[i + 3] > 8) drawn++;
				if (
					data[i + 3] > 200 &&
					data[i] > 100 &&
					data[i] > 2 * data[i + 1] &&
					data[i] > 2 * data[i + 2]
				) {
					red++;
				}
			}
			return { pixels: data.length / 4, drawn, red };
		};
		let last = { pixels: 0, drawn: 0, red: 0 };
		for (let frame = 0; frame < 90; frame++) {
			last = await count(await readFrame());
			if (last.red > 0) break;
		}
		return last;
	});

	// Nonzero drawn pixels: the renderer actually rasterized something.
	expect(sample.drawn, `canvas has drawn pixels (of ${sample.pixels})`).toBeGreaterThan(0);
	// The texture's color on screen. 100px is far below the quad's real footprint
	// (tens of thousands of pixels at the framed camera distance) but far above
	// anything noise could produce.
	expect(sample.red, 'red texture pixels reached the screen').toBeGreaterThan(100);

	// The whole path ran under the page's real CSP — worker-src 'none',
	// connect-src 'self' blob: data: — with zero violations, and without any
	// uncaught error or three.js console error.
	const violations = await page.evaluate(
		() => (window as unknown as { __csp: Violation[] }).__csp ?? []
	);
	expect(violations, 'browser reported CSP violations').toEqual([]);
	expect(pageErrors, 'uncaught page errors').toEqual([]);
	expect(consoleErrors, 'console errors during model load/render').toEqual([]);
});
