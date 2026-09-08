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

/** Two done tiles: the first is the parent, the second a variant. The whole
 * multi-tile half of the spec (per-tile lookups, the parent split) only exists
 * above one file. */
async function twoDoneTiles(page: Page) {
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
	);
	await page.goto('/admin/upload');
	await waitForDropAttachment(page, '.dropzone');
	await dropOn(page, '.dropzone', [
		{ name: 'front.png', type: 'image/png' },
		{ name: 'back.png', type: 'image/png' }
	]);
	await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x1.png', { timeout: 15_000 });
}

/** A confident match whose local artist is somebody else — what the variant
 * tile's "Different artist" line is about. */
function otherArtistBody() {
	return matchedBody({
		localArtists: [{ matchIndex: 0, artists: [{ id: 2, name: 'Avatar Artist' }] }]
	});
}

const tileLookup = (page: Page) => page.locator('button.tile-lookup');
const sourceInput = (page: Page) => page.locator('input[name="sourcePostUrl"]');
const dateInput = (page: Page) => page.locator('input[name="commissionedAt"]');
// Seeded by tests/e2e/fixtures/seed.sql, credited to Avatar Artist (id 2).
const EDIT_IMAGE = '/admin/images/10/edit';

/** In `vite dev` the client modules stream in, so a click fired right after
 * goto can land before Svelte attaches its handlers — and a value typed before
 * hydration is thrown away by it. Toggling the artist control and back is a
 * probe that leaves the form exactly as it was found. */
async function gotoEditHydrated(page: Page) {
	await page.goto(EDIT_IMAGE);
	// Retry the CLICK, not the navigation: `vite dev` compiles this route's
	// modules on first request, and re-navigating would restart that every time.
	await expect(async () => {
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await expect(page.locator('input[name="artistName"]')).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Select Existing' }).click();
	await expect(page.locator('select[name="artistId"]')).toBeVisible();
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
		// Private, so the file leaving for a lookup that then FAILED still has to
		// be disclosed — the notice is not for results only (SONA-156 round 1).
		await page.check('input[name="published"]');
		await pill(page).click();

		await expect(panel(page)).toContainText(
			'FuzzySearch is limiting how often your site can search right now.'
		);
		await expect(panel(page)).toContainText(
			'This image is private. Sona sent the file to FuzzySearch for this lookup.'
		);
		await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();

		// Close puts the panel away and leaves the form alone. The region itself
		// stays mounted (collapsed to nothing) so its next message is announced.
		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toBeHidden();
		await expect(page.locator('form.upload-form button[type="submit"]')).toBeEnabled();
	});

	// The rule the module's own comment calls the one thing the operator cannot
	// undo with a click. Everything else here fills EMPTY fields; this is the
	// case where they are not empty, on both pages.
	test('a lookup never overwrites what the operator typed first', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await sourceInput(page).fill('https://example.test/mine/');
		await dateInput(page).fill('2020-01-02');
		await pill(page).click();

		await expect(panel(page)).toBeVisible();
		// The negatives below are only worth anything against a lookup that
		// demonstrably found something: a failure panel would satisfy them all.
		await expect(panel(page)).toContainText('kuttoya');
		await expect(panel(page)).toContainText('Exact match');
		await expect(sourceInput(page)).toHaveValue('https://example.test/mine/');
		await expect(dateInput(page)).toHaveValue('2020-01-02');
		// Nothing was filled, so nothing is tagged as filled.
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		// And the status line claims no field either.
		await expect(panel(page)).not.toContainText('Sona filled');
	});

	test('the edit page keeps the values already on the image', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page);
		await sourceInput(page).fill('https://example.test/mine/');
		await dateInput(page).fill('2020-01-02');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		// Same reason as above: prove the lookup landed a match before reading
		// anything into the fields it left alone.
		await expect(panel(page)).toContainText('kuttoya');
		await expect(panel(page)).toContainText('Exact match');
		await expect(sourceInput(page)).toHaveValue('https://example.test/mine/');
		await expect(dateInput(page)).toHaveValue('2020-01-02');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
	});

	test('the edit page never changes the artist without a click', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page);
		const select = page.locator('select[name="artistId"]');
		await expect(select).toHaveValue('2');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		// The result names Test Artist (id 1); the select is untouched until the
		// operator says so.
		await expect(select).toHaveValue('2');

		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();
		await expect(select).toHaveValue('1');
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
	});

	test('the edit page keeps a new-artist name the operator typed', async ({ page }) => {
		// No local artist behind the handle: the `new` outcome, which flips the
		// page to its inline new-artist form and seeds it.
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await gotoEditHydrated(page);
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await page.fill('input[name="artistName"]', 'My Own Name');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		// The typed name survives and carries no tag; the empty link field is
		// filled and tagged.
		await expect(page.locator('input[name="artistName"]')).toHaveValue('My Own Name');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveCount(0);
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(
			'https://www.furaffinity.net/user/kuttoya/'
		);
		await expect(page.locator('#furaffinity-lookup-tag')).toBeVisible();

		// Editing the seeded field drops its tag, like every other lookup tag.
		await page.fill('input[name="furaffinity"]', 'furaffinity.net/user/someone/');
		await expect(page.locator('#furaffinity-lookup-tag')).toHaveCount(0);
	});

	// SvelteKit reuses one component across a route-param change, so an edit page
	// that moved to another image in the same tab would otherwise keep the
	// previous image's applied artist, filled fields and "From lookup" tags. The
	// source pin can only see that a reset exists; this is the only thing that
	// proves it runs.
	test('moving to another image in the same tab drops the previous lookup', async ({ page }) => {
		// A result whose local artist is somebody OTHER than the destination
		// image's own artist, so the select cannot read right by accident.
		await stubLookup(page, otherArtistBody());
		await page.goto('/admin/images/3/edit');
		await expect(async () => {
			await pill(page).click();
			await expect(panel(page)).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 30_000 });

		await panel(page).getByRole('button', { name: 'Use Avatar Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('2');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();

		// A same-tab link between two edit pages: SvelteKit's router intercepts
		// clicks on any same-origin anchor, so this is the client-side navigation
		// the reset exists for. The flag proves the page did not simply reload,
		// which would reset everything by remounting and prove nothing.
		await page.evaluate(() => {
			(window as unknown as { __e2eSameTab?: boolean }).__e2eSameTab = true;
			const link = document.createElement('a');
			link.href = '/admin/images/1/edit';
			link.id = 'e2e-inapp-link';
			link.textContent = 'go';
			document.body.appendChild(link);
		});
		await page.click('#e2e-inapp-link');
		await expect(page.locator('h1')).toBeVisible();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
		expect(
			await page.evaluate(() => (window as unknown as { __e2eSameTab?: boolean }).__e2eSameTab)
		).toBe(true);

		// Nothing of the previous image's lookup survives the move: the region is
		// back to idle (it stays mounted by design) and holds no result.
		await expect(panel(page)).toHaveClass(/idle/);
		await expect(panel(page)).not.toContainText('kuttoya');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(sourceInput(page)).toHaveValue('');
	});

	test('a variant tile rates its own tile and leaves the shared fields alone', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		// The second tile is not the parent, so its result is its own.
		await tileLookup(page).nth(1).click();
		const tileTag = page.locator('.tile-nsfw-row .rating-tag');
		await expect(tileTag).toHaveCount(1);
		await expect(tileTag).toHaveText('Rated General on FurAffinity');
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#shared-rating-tag')).toHaveCount(0);

		// Removing the tile discards the result with it.
		await page.getByRole('button', { name: 'Remove file' }).nth(1).click();
		await expect(page.locator('.tile-nsfw-row .rating-tag')).toHaveCount(0);
	});

	test('the parent drives the shared fields, and moving it re-derives them', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();

		// The shared fields describe whatever the parent is now: the second tile
		// has no result of its own, so they clear rather than keep the first's.
		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
	});

	test('a variant crediting somebody else says so on its tile', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		// Apply the parent's artist first — the warn line compares against it.
		await tileLookup(page).nth(0).click();
		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();

		// The later route wins: the variant's match names a different artist.
		await stubLookup(page, otherArtistBody());
		await tileLookup(page).nth(1).click();
		await expect(page.locator('.tile-result-warn')).toHaveText(
			'Different artist: kuttoya on FurAffinity'
		);
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
