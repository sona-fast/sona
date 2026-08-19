import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { adminLogin } from './admin-login';

// The con card generator (SONA-115), driven in a real browser. Everything below
// only works there: the two fieldsets and the preview are unit-pinned as SOURCE
// in con-card-markup.test.ts (nothing renders the component under vitest), and
// the phone save runs an SVG through an <img>, a <canvas> and toBlob: three
// browser APIs whose failure modes are exactly what a source pin cannot see.
//
// Read-only: no test here writes to the shared e2e DB.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// Past the con-card flag's GA date in src/lib/early-access.ts, so the generator
// is open to everyone and this spec does not need a supporter key minted into
// the seed. setFixedTime rather than install(): it fakes Date and leaves the
// timers running, which everything else on the settings page depends on.
const AFTER_GA = new Date('2026-12-01T12:00:00.000Z');

// ?tab=account rather than clicking the tab: the tab click sets component state
// that afterNavigate clears, and this spec arrives mid-hydration. The param
// resolves reactively and survives, which is the SONA-114 deep link's whole job.
//
// The gate is decided at RENDER from `new Date()`, and the clock is only faked
// in the browser, so the server pass renders the locked hint and the browser
// re-renders the generator over it. That the section ends up present is the
// assertion the beforeEach makes.
async function openSettings(page: Page) {
	await page.goto('/admin/settings?tab=account');
	await expect(page.locator('.settings-tabs')).toHaveAttribute('data-active-tab', 'account');
}

const conCard = (page: Page) => page.locator('.con-card');
/** The back face's inlined SVG: the face that carries the QR and the handles. */
const backFace = (page: Page) => conCard(page).locator('figure').nth(1).locator('.face');

// Serial on purpose. This suite logs in, rasterizes through a canvas and waits
// on a download event, and the shared server's admin session flow has a
// documented history of flaking once parallel specs are added beside it (the
// upload project runs workers: 1 for the same reason).
test.describe.configure({ mode: 'serial' });

test.describe('admin settings con card', () => {
	test.beforeEach(async ({ page }) => {
		await page.clock.setFixedTime(AFTER_GA);
		await adminLogin(page, PASSWORD);
		await openSettings(page);
		// The component is a deferred chunk, so the section is a heading and an
		// empty await block until it lands.
		await expect(conCard(page)).toBeVisible();
	});

	test('groups the card options as two fieldsets: what goes on it, then which accounts', async ({
		page
	}) => {
		// Per the approved mock. A <fieldset> is a group, and its <legend> names it,
		// which is the whole reason the handles are not just more checkboxes.
		await expect(conCard(page).getByRole('group', { name: 'Include' })).toBeVisible();
		await expect(conCard(page).getByRole('group', { name: 'Handles' })).toBeVisible();
		// Both faces are previewed, and each is labelled.
		await expect(conCard(page).getByText('Front', { exact: true })).toBeVisible();
		await expect(conCard(page).getByText('Back', { exact: true })).toBeVisible();
	});

	test('turning a handle off redraws the card without it', async ({ page }) => {
		const handles = conCard(page).getByRole('group', { name: 'Handles' }).locator('.handle-row');
		// The seed carries two socials (Instagram + FurAffinity), and the card starts
		// with both ticked: two is the mock's guidance.
		await expect(handles).toHaveCount(2);

		const before = await backFace(page).innerHTML();
		const box = handles.first().getByRole('checkbox');
		await expect(async () => {
			await box.uncheck();
			await expect(box).not.toBeChecked({ timeout: 1500 });
		}).toPass();

		// The preview is inlined markup, not an <img>, precisely so a toggle repaints
		// it: the operator has to see what they are about to print.
		await expect(async () => {
			expect(await backFace(page).innerHTML()).not.toBe(before);
		}).toPass();
	});

	test('saves the back to the phone as a PNG, and says nothing when it worked', async ({
		page
	}) => {
		const download = page.waitForEvent('download');
		await conCard(page).getByRole('button', { name: 'Save to phone' }).click();

		// Photos on iPhone refuses an SVG, so this path rasterizes through a canvas.
		// The suffix is the assertion that the canvas half actually ran: a straight
		// SVG save would come back .svg.
		const saved = await download;
		expect(saved.suggestedFilename()).toMatch(/\.png$/);

		// And the file behind the name is a real PNG: a filename is set by the code
		// that starts the save, before anything has been encoded, so an empty or
		// truncated blob keeps the .png and lands on the phone unopenable.
		const path = await saved.path();
		const bytes = readFileSync(path);
		expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(bytes.length).toBeGreaterThan(1000);

		// The live region exists whether or not anything failed (a region created
		// together with its text is not reliably announced), so "it worked" is the
		// region being present and EMPTY, not the region being absent.
		const status = conCard(page).locator('.status-line');
		await expect(status).toHaveAttribute('role', 'status');
		await expect(status).toHaveText('');
	});
});

// The fullscreen scan target. It sits outside every route group and reads no
// settings, which is what lets it answer during a D1 outage: the case admin
// itself fails closed on.
test.describe('/connect/qr', () => {
	test('renders the code with its accessible name, and the domain to type instead', async ({
		page
	}) => {
		await page.goto('/connect/qr');

		// role="img" plus a label: the code is the page, and a bare <svg> is
		// nothing at all to a screen reader.
		await expect(page.getByRole('img', { name: /QR code for .*\/connect$/ })).toBeVisible();
		// Printed under it for whoever cannot scan, scheme stripped for reading out.
		await expect(page.locator('.url')).toHaveText(/^localhost:\d+\/connect$/);
		await expect(page.locator('.who')).toHaveText('E2E Test Gallery');
	});

	// NOT covered here: the D1-outage case this route exists for. Taking the DB
	// binding away needs a server booted without it, and the harness builds a
	// server per wrangler config + persist dir, and a fifth one for a single
	// assertion costs every run a seed and a boot. What actually holds the
	// property is structural and is pinned as such in
	// src/routes/connect/qr/page.server.test.ts: the load touches no database,
	// and the route sits outside every group whose layout does.
});
