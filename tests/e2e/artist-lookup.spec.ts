import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';
import { dropOn, waitForDropAttachment } from './drop-files';

// "Look up artist" on the upload page (SONA-156), driven in a real browser.
// Nothing renders Svelte under vitest, so the unit suite can only grep the
// source; whether the panel actually appears, what it fills, and whether a tag
// clears when the field is edited are only answerable here.
//
// /api/admin/artist-lookup is ALWAYS stubbed with page.route — this spec never
// calls FuzzySearch, and the key it saves is a throwaway string that no request
// ever carries anywhere.
//
// Runs on the "upload" project (its own dev server + seeded DB, workers: 1):
// the button's presence is decided by a site_settings row, and saving one on
// the shared server would race every other spec. The last test removes the key
// again, leaving the DB as the seed built it.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';
// Printable ASCII, over eight characters: passes the save action's shape check.
// Not a real key — nothing in this file calls out.
const FAKE_KEY = 'e2e-artist-lookup-key-01';

const POST_URL = 'https://www.furaffinity.net/view/12345/';

/** One confident FurAffinity match, with the seeded artist behind it. */
function matchedBody(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		matches: [
			{
				site: 'FurAffinity',
				siteId: '12345',
				handles: ['kuttoya'],
				distance: 0,
				band: 'exact',
				postedAt: '2026-03-04T10:00:00Z',
				rating: 'general',
				postUrl: POST_URL
			}
		],
		localArtists: [{ matchIndex: 0, artists: [{ id: 1, name: 'Test Artist' }] }],
		nameMatches: [],
		sourceClash: null,
		...over
	};
}

async function stubLookup(page: Page, body: unknown, status = 200) {
	await page.route('**/api/admin/artist-lookup', (route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
	);
}

/** Stub the upload path and get one tile to `done` on the upload page. */
async function oneDoneTile(page: Page) {
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
	);
	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	await dropOn(page, '.dropzone', [{ name: 'piece.png', type: 'image/png' }]);
	await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/x1.png', { timeout: 15_000 });
}

const section = (page: Page) => page.locator('section.lookup-section');

// The tab is a client-side swap, so the section is in the DOM but hidden until
// hydration has attached the tab handler — retry the click until it shows.
async function openConnectionsTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Connections', exact: true }).click();
		await expect(section(page)).toBeVisible({ timeout: 1500 });
	}).toPass();
}

const pill = (page: Page) => page.locator('button.lookup-pill');
const panel = (page: Page) => page.getByRole('region', { name: 'Artist lookup' });

test('without a key there is no button, only a pointer at Settings', async ({ page }) => {
	test.setTimeout(60_000);
	await adminLogin(page, PASSWORD);
	await oneDoneTile(page);

	await expect(pill(page)).toHaveCount(0);
	const hint = page.locator('#lookup-hint');
	await expect(hint).toContainText('add a FuzzySearch key in');
	await expect(hint.getByRole('link', { name: 'Settings' })).toHaveAttribute(
		'href',
		'/admin/settings?tab=connections'
	);
});

// Serial: every test below runs against one settings row — the first saves it,
// the last takes it away, and the ones in between need it there.
test.describe.configure({ mode: 'serial' });

test.describe('with a key saved', () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(90_000);
		await adminLogin(page, PASSWORD);
	});

	test('saving a key puts the button on the upload page', async ({ page }) => {
		// Hydration-sensitive the same way the tab is: a click that lands before
		// use:enhance is attached posts natively, and the reload resets the tab,
		// leaving the connected state in the DOM but hidden.
		await expect(async () => {
			await page.goto('/admin/settings');
			await openConnectionsTab(page);
			if ((await section(page).locator('button.btn-remove').count()) > 0) return;
			await section(page).locator('input[name="fuzzysearchApiKey"]').fill(FAKE_KEY);
			await section(page).locator('button[type="submit"]').click();
			await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible({
				timeout: 1500
			});
		}).toPass();

		await oneDoneTile(page);
		await expect(pill(page)).toBeVisible();
	});

	test('a match prefills the source URL and date, and tags both fields', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await expect(pill(page)).toBeVisible();
		await pill(page).click();

		await expect(panel(page)).toBeVisible();
		await expect(page.locator('input[name="sourcePostUrl"]')).toHaveValue(POST_URL);
		await expect(page.locator('input[name="commissionedAt"]')).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveText('From lookup');
		// The tag describes the input; it is not part of its name.
		await expect(page.locator('input[name="sourcePostUrl"]')).toHaveAttribute(
			'aria-describedby',
			'source-lookup-tag'
		);
		// The result link opens elsewhere without handing over the opener.
		const link = panel(page).getByRole('link', { name: /View post/ });
		await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
		await expect(link).toHaveAttribute('target', '_blank');
	});

	test('editing a tagged field drops its tag', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);
		await pill(page).click();
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		await page.fill('input[name="commissionedAt"]', '2026-05-06');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator('input[name="commissionedAt"]')).not.toHaveAttribute(
			'aria-describedby',
			'commissioned-lookup-tag'
		);
		// The other field's tag is untouched.
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
	});

	test('Use artist applies it, and changing the select by hand reverts the button', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);
		await pill(page).click();

		const use = panel(page).getByRole('button', { name: 'Use Test Artist' });
		await expect(use).toBeVisible();
		await use.click();

		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();

		// Back to the empty option: the panel stops claiming its artist is in use.
		await page.selectOption('select[name="artistId"]', '');
		await expect(panel(page).getByRole('button', { name: 'Use Test Artist' })).toBeVisible();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toHaveCount(0);
	});

	test('the rating shows beside NSFW without touching the checkbox', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '12345',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: null,
						rating: 'adult',
						postUrl: POST_URL
					}
				]
			})
		);
		await oneDoneTile(page);
		const nsfw = page.locator('input[name="nsfw"]');
		await expect(nsfw).not.toBeChecked();

		await pill(page).click();

		const tag = page.locator('#shared-rating-tag');
		await expect(tag).toHaveText('Rated Adult on FurAffinity');
		await expect(nsfw).not.toBeChecked();
		await expect(nsfw).toHaveAttribute('aria-describedby', 'shared-rating-tag');
		// The pill is a sibling, so clicking it must not toggle the box.
		await tag.click();
		await expect(nsfw).not.toBeChecked();
	});

	test('a refused key says so and offers Settings, not a retry', async ({ page }) => {
		await stubLookup(page, { enabled: true, error: 'key_refused' }, 424);
		await oneDoneTile(page);
		await pill(page).click();

		await expect(panel(page)).toContainText("FuzzySearch didn't accept your API key.");
		await expect(panel(page).getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
			'href',
			'/admin/settings?tab=connections'
		);
		await expect(panel(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
		// Nothing was filled.
		await expect(page.locator('input[name="sourcePostUrl"]')).toHaveValue('');
	});

	test('a rate limit pauses the lookup and keeps the upload usable', async ({ page }) => {
		await stubLookup(page, { enabled: true, error: 'rate_limited' }, 429);
		await oneDoneTile(page);
		await pill(page).click();

		await expect(panel(page)).toContainText('FuzzySearch is rate limiting your site right now.');
		await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();

		// Close puts the panel away and leaves the form alone.
		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toHaveCount(0);
		await expect(page.locator('form.upload-form button[type="submit"]')).toBeEnabled();
	});

	// Last: leaves the DB as the seed built it, for whatever runs next on this
	// server. Not an afterAll — a hook failure is silent about which state it
	// left behind, and this is the one action that matters to other specs.
	test('removing the key takes the button away again', async ({ page }) => {
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
		await section(page).locator('button.btn-remove').click();
		// The confirmation ignores a click for its first half second.
		await page.waitForTimeout(550);
		await section(page)
			.locator('.remove-confirm')
			.getByRole('button', { name: 'Remove', exact: true })
			.click();
		await expect(section(page).locator('input[name="fuzzysearchApiKey"]')).toBeVisible({
			timeout: 15_000
		});

		await oneDoneTile(page);
		await expect(pill(page)).toHaveCount(0);
	});
});
