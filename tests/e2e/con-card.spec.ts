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

// Before it, for the locked half. Both dates are fixed points rather than
// offsets from the real clock, so neither test changes meaning when the flag
// actually reaches GA — the gate is a $derived over `new Date()` in the
// browser, and page.clock is what that reads.
const BEFORE_GA = new Date('2026-01-05T12:00:00.000Z');

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
/** The front face: the one carrying the name, species and pronouns lines. */
const frontFace = (page: Page) => conCard(page).locator('figure').nth(0).locator('.face');

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
		// empty await block until it lands. Three things have to happen before it
		// does: hydration, the gate re-deriving against the faked clock, and the
		// chunk request itself. On a cold CI runner that does not fit in the default
		// 5s expect timeout — it failed its first attempt on every CI run and was
		// green only because Playwright retried it, which reports the suite as flaky
		// and would hide a real break behind a passing retry.
		await expect(conCard(page)).toBeVisible({ timeout: 30_000 });
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

	test('turning the pronouns off redraws the front without them (SONA-210)', async ({ page }) => {
		// The seed sets pronouns, so the box is there and starts ticked: an operator
		// who filled the setting in has already said yes to printing it.
		const box = conCard(page)
			.getByRole('group', { name: 'Include' })
			.getByRole('checkbox', { name: 'Pronouns' });
		await expect(box).toBeChecked();
		await expect(frontFace(page)).toContainText('they/them');

		await expect(async () => {
			await box.uncheck();
			await expect(box).not.toBeChecked({ timeout: 1500 });
		}).toPass();

		// Same as the handle toggle: the preview is inlined markup so it repaints,
		// and the line the operator just turned off is gone from what will print.
		await expect(frontFace(page)).not.toContainText('they/them');
	});

	test('saves the back to the phone as a PNG, and says nothing when it worked', async ({
		page
	}) => {
		const download = page.waitForEvent('download');
		await conCard(page).getByRole('button', { name: 'Save the back to your phone' }).click();

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
	test('prints the operator\'s face, not an initial where the face should be', async ({
		page
	}) => {
		// The one assertion nobody wrote. The card embeds the avatar by reading its
		// bytes, which no unit test exercises (they hand the builder a finished
		// data: URI) and no other e2e reaches (the only download test saves the
		// back, which draws no avatar). A whole release shipped with this silently
		// falling back to an initial circle.
		const download = page.waitForEvent('download');
		await conCard(page).getByRole('button', { name: /print/i }).click();
		const svg = await (await download).createReadStream();
		let body = '';
		for await (const chunk of svg) body += chunk;

		// An embedded raster, not a reference the printer would have to resolve.
		expect(body).toMatch(/<image[^>]+href="data:image\//);
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

test.describe('admin settings con card, before its GA date', () => {
	// The seed mints no supporter key, so a pre-GA clock puts this admin on the
	// locked side of the gate. Worth a browser: the locked branch is the one an
	// operator without a key sees for the whole head-start week, and until now it
	// was only pinned as source text.
	test.beforeEach(async ({ page }) => {
		await page.clock.setFixedTime(BEFORE_GA);
		await adminLogin(page, PASSWORD);
		await openSettings(page);
	});

	test('offers the key instead of the generator', async ({ page }) => {
		const section = page.locator('section.security-section', {
			has: page.getByRole('heading', { name: 'Con card' })
		});
		// The hint names a date and points at the field that fixes it. Matched on the
		// sentence rather than the date itself: early-access.ts owns that value and a
		// unit test already pins it, so repeating it here would just be a second copy
		// to update.
		await expect(section.getByText(/open to everyone on/)).toBeVisible();
		await expect(section.getByRole('link', { name: 'Add your key' })).toHaveAttribute(
			'href',
			'#supporter-key'
		);
		// And the generator is not rendered — checked twice, with a wait between,
		// which is the whole point. The server renders this branch from its own real
		// clock, so an immediate assertion only observes the server's answer and
		// passes even when the browser is about to disagree. The second check runs
		// after hydration has had time to re-render, so it is the client gate being
		// tested. Verified by moving this clock past GA: the first assertion still
		// passes, the second one fails.
		await expect(conCard(page)).toHaveCount(0);
		await page.waitForTimeout(3000);
		await expect(conCard(page)).toHaveCount(0);
		await expect(section.getByText(/open to everyone on/)).toBeVisible();
	});
});
