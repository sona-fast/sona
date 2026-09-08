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
	// Retried whole, the way the tab opener and the save step are: in `vite dev`
	// the first request compiles the route, and a navigation or a drop that lands
	// mid-hydration would otherwise sink the rest of the serial block. The goto
	// is inside the block, so each attempt starts from a clean upload page.
	await expect(async () => {
		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [{ name: 'piece.png', type: 'image/png' }]);
		await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});
	}).toPass({ timeout: 30_000 });
}

/** Two done tiles: the first is the parent, the second a variant. The whole
 * multi-tile half of the spec (per-tile lookups, the parent split) only exists
 * above one file. */
async function twoDoneTiles(page: Page) {
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
	);
	// Same retry shape as oneDoneTile, for the same reason.
	await expect(async () => {
		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [
			{ name: 'front.png', type: 'image/png' },
			{ name: 'back.png', type: 'image/png' }
		]);
		await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});
	}).toPass({ timeout: 30_000 });
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
async function gotoEditHydrated(page: Page, path = EDIT_IMAGE) {
	// The first request to this route compiles it, which can outrun goto's own
	// timeout and leave nothing to click. Three tries, and the compile the timed
	// out attempt started carries into the next one.
	for (let attempt = 1; ; attempt++) {
		try {
			await page.goto(path);
			break;
		} catch (e) {
			if (attempt === 3) throw e;
		}
	}
	// Past the navigation, retry the CLICK and not the navigation: re-navigating
	// would throw away the hydration this is waiting on and start it over.
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

		// The status line names the fields still attributable to the lookup, so it
		// says both until one of them is typed over.
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL and commissioned date'
		);

		await page.fill('input[name="commissionedAt"]', '2026-05-06');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator('input[name="commissionedAt"]')).not.toHaveAttribute(
			'aria-describedby',
			'commissioned-lookup-tag'
		);
		// The other field's tag is untouched, and so is its half of the line. The
		// edited date is neither claimed nor called untouched: "left the commissioned
		// date as it was" would be a false claim about a date Sona filled itself.
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL from the FurAffinity post. You can change it before you save.'
		);
		await expect(panel(page)).not.toContainText('left the commissioned date as it was');

		// Typing over the second filled field leaves nothing attributable, so the
		// line goes away rather than claiming a field the operator now owns.
		await page.fill('input[name="sourcePostUrl"]', 'https://example.com/mine');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(panel(page)).not.toContainText('Sona filled the source post URL');
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
		await stubLookup(page, { enabled: true, error: 'key_refused', forwarded: true }, 424);
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
		await stubLookup(page, { enabled: true, error: 'rate_limited', forwarded: true }, 429);
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

	// A second lookup used to read the first one's URL as something the operator
	// typed, fill nothing, and leave a "From lookup" tag sitting on a value from
	// the other post. Only the source pin can see the reset exists; this is what
	// proves the second result actually replaces the first.
	test('a second lookup replaces what the first one filled', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(page.locator('#source-lookup-tag')).toBeVisible();

		const second = 'https://www.furaffinity.net/view/67890/';
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '67890',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: '2026-05-06T10:00:00Z',
						rating: 'general',
						postUrl: second
					}
				]
			})
		);
		await pill(page).click();
		await expect(panel(page)).toContainText('Exact match');
		await expect(sourceInput(page)).toHaveValue(second);
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		// One tag, on the value the second lookup wrote.
		await expect(page.locator('#source-lookup-tag')).toHaveCount(1);
	});

	// The reset only undoes what the LAST lookup wrote. A URL the operator typed
	// over the filled one carries no tag, so the second lookup has to leave it
	// alone while still replacing the date it does still own.
	test('a second lookup leaves a URL typed over the first one alone', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// Typing over the filled URL drops its tag; the date keeps its own.
		await sourceInput(page).fill('https://example.test/mine/');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '67890',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: '2026-05-06T10:00:00Z',
						rating: 'general',
						postUrl: 'https://www.furaffinity.net/view/67890/'
					}
				]
			})
		);
		await pill(page).click();
		await expect(panel(page)).toContainText('Exact match');
		await expect(sourceInput(page)).toHaveValue('https://example.test/mine/');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		// The date was still the lookup's, so the second result replaces it.
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();
	});

	// Image 1 already has a variant (image 2 in the seed), so it can't become
	// one: the panel drops "Add as a variant" and says why instead.
	test('a piece that already has variants is told why it cannot be one', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				sourceClash: {
					imageId: 10,
					title: 'Lookup Edit Target',
					isVariant: false,
					parentImageId: null,
					variantCount: 0,
					thumbnailUrl: null,
					artistName: 'Avatar Artist',
					uploadedAt: '2026-07-05T00:00:00.000Z',
					width: 900,
					height: 700
				}
			})
		);
		await gotoEditHydrated(page, '/admin/images/1/edit');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText('Lookup Edit Target');
		await expect(panel(page)).toContainText(
			"The image you're editing already has variants of its own"
		);
		await expect(panel(page).getByRole('button', { name: 'Add as a variant' })).toHaveCount(0);
	});

	// A clash answers "this post is already here"; it says nothing about WHICH of
	// two same-named artists drew it. The pick list belongs inside the clash body
	// for that reason, and the source URL still stays out of the form — the post
	// URL already belongs to the other piece.
	test('asks which artist under a clash, and fills no source URL either way', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				// The picked artist is listed SECOND on purpose: the select already
				// holds the first one, so a build that applied candidates[0] instead
				// of the radio would pass a test that picked the first row.
				localArtists: [
					{
						matchIndex: 0,
						artists: [
							{ id: 2, name: 'Avatar Artist', pieces: 1 },
							{ id: 1, name: 'Test Artist', pieces: 3 }
						]
					}
				],
				sourceClash: {
					imageId: 1,
					title: 'Test Image',
					isVariant: false,
					parentImageId: null,
					variantCount: 0,
					thumbnailUrl: null,
					artistName: 'Test Artist',
					uploadedAt: '2026-07-01T00:00:00.000Z',
					width: 1200,
					height: 900
				}
			})
		);
		await gotoEditHydrated(page);
		const select = page.locator('select[name="artistId"]');
		await expect(select).toHaveValue('2');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText('Test Image');
		// The radios render under the clash, not only in the plain ambiguous state.
		const picks = panel(page).locator('.pick-list input[type="radio"]');
		await expect(picks).toHaveCount(2);

		const useSelected = panel(page).getByRole('button', { name: 'Use selected artist' });
		await expect(useSelected).toBeDisabled();

		await panel(page).locator('.pick-row', { hasText: 'Test Artist' }).first().click();
		await expect(useSelected).toBeEnabled();
		await useSelected.click();
		await expect(select).toHaveValue('1');
		// The clash's whole point: the post URL already belongs to another piece.
		await expect(sourceInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
	});

	// prefillForResult skips the source URL on ANY clash, whatever the field
	// holds, so the "left it empty" sentence was a false claim to an operator who
	// pasted one first — the field is visibly not empty.
	test('does not call a pasted source URL empty under a clash', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				sourceClash: {
					imageId: 1,
					title: 'Test Image',
					isVariant: false,
					parentImageId: null,
					variantCount: 0,
					thumbnailUrl: null,
					artistName: 'Test Artist',
					uploadedAt: '2026-07-01T00:00:00.000Z',
					width: 1200,
					height: 900
				}
			})
		);
		await gotoEditHydrated(page);
		const pasted = 'https://www.furaffinity.net/view/99999/';
		await sourceInput(page).fill(pasted);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();

		// The URL the operator pasted is still there, untagged and unclaimed.
		await expect(sourceInput(page)).toHaveValue(pasted);
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(panel(page)).toContainText(
			'left your source post URL as it was, because that post is already the source of Test Image'
		);
		await expect(panel(page)).not.toContainText('left the source post URL empty');

		// The sentence describes what the lookup did, once. Clearing the field now
		// is the operator's doing, and the panel must not restate it as Sona's.
		await sourceInput(page).fill('');
		await expect(panel(page)).toContainText('left your source post URL as it was');
		await expect(panel(page)).not.toContainText('left the source post URL empty');
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

	// The image already has an artist, and a handle Sona does not hold is a
	// suggestion about it. Flipping the form here would insert a duplicate
	// artist and re-credit the piece on the next save.
	test('the edit page keeps its artist when the result is a new one', async ({ page }) => {
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText("kuttoya isn't in your artist list yet.");
		// Still the select, still the image's own artist, and no inline form.
		await expect(page.locator('select[name="artistId"]')).toHaveValue('2');
		await expect(page.locator('input[name="artistName"]')).toHaveCount(0);

		// Only the panel's own action opens the form and seeds it.
		await panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' }).click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('#artist-name-lookup-tag')).toBeVisible();
	});

	test('the edit page keeps a new-artist name the operator typed', async ({ page }) => {
		// No local artist behind the handle: the `new` outcome, whose action opens
		// the inline new-artist form and seeds it.
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await gotoEditHydrated(page);
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await page.fill('input[name="artistName"]', 'My Own Name');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' }).click();
		// The typed name survives and carries no tag; the empty link field is
		// filled and tagged.
		await expect(page.locator('input[name="artistName"]')).toHaveValue('My Own Name');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveCount(0);
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(
			'https://www.furaffinity.net/user/kuttoya/'
		);
		await expect(page.locator('#furaffinity-lookup-tag')).toBeVisible();
		await expect(panel(page)).toContainText("Sona filled the new artist's FurAffinity link.");

		// Editing the seeded field drops its tag, like every other lookup tag —
		// and with it the sentence, which has no seeded field left to name.
		await page.fill('input[name="furaffinity"]', 'furaffinity.net/user/someone/');
		await expect(page.locator('#furaffinity-lookup-tag')).toHaveCount(0);
		await expect(panel(page)).not.toContainText("Sona filled the new artist's");
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

	// Left at the 'new' outcome, the panel kept offering "Add kuttoya as a new
	// artist" after the artist existed, and POST /api/artists enforces no name
	// uniqueness on a non-registry create — so the second click made a duplicate
	// row the operator then had to find and merge.
	test('stops offering to add an artist it just created', async ({ page }) => {
		let creates = 0;
		// POSTs only: the count is pinning the create, and a GET added to this URL
		// later would otherwise fail this test for a reason it says nothing about.
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			creates += 1;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 77, name: 'kuttoya' })
			});
		});
		// No local artist behind the handle: the 'new' outcome, whose action opens
		// the dialog.
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await oneDoneTile(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();

		// The dialog's fields carry ids rather than names, and this one arrives
		// seeded with the handle the panel offered.
		await expect(page.locator('#new-artist-name')).toHaveValue('kuttoya');
		await page.getByRole('button', { name: 'Create Artist' }).click();

		// The select holds the artist that was just created.
		await expect(page.locator('select[name="artistId"]')).toHaveValue('77');
		// And the panel has moved off the 'new' outcome, so there is nothing left
		// to click a second time.
		await expect(addNew).toHaveCount(0);
		await expect(panel(page)).toContainText('kuttoya');
		expect(creates).toBe(1);
		// That swap destroyed the button the dialog captured as its opener, so
		// without a deliberate landing spot focus falls to <body> and the next Tab
		// restarts at the top of the page (2.4.3).
		expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
		await expect(
			panel(page).getByRole('button', { name: 'Using kuttoya' })
		).toBeFocused();
	});

	// The same dialog opens from the standalone "+ Add New Artist" button above
	// the panel, with no lookup seed. An artist created there has nothing to do
	// with the match on screen: credited to it, the panel claimed the handle was
	// "already in your artist list as <unrelated name>" and the real add-new
	// action disappeared.
	test('does not credit the result with an artist created beside it', async ({ page }) => {
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 78, name: 'Bob Smith' })
			});
		});
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await oneDoneTile(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await expect(addNew).toBeVisible();

		// The standalone button, not the panel's action: no seed, so the dialog
		// opens empty.
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await expect(page.locator('#new-artist-name')).toHaveValue('');
		await page.locator('#new-artist-name').fill('Bob Smith');
		await page.getByRole('button', { name: 'Create Artist' }).click();

		await expect(page.locator('select[name="artistId"]')).toHaveValue('78');
		// The result is untouched: it still offers the artist it actually found,
		// and never says kuttoya is Bob Smith.
		await expect(addNew).toBeVisible();
		await expect(panel(page)).not.toContainText('Bob Smith');
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

	// parentIndex is submitted as the hidden field the server picks the parent
	// with, so a tile removed ahead of the parent must move it along: otherwise
	// the piece that saves is a different file than the shared artist, date and
	// source URL describe.
	test('removing a tile ahead of the parent keeps the parent and its fields', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await page.route('**/api/upload', (route) =>
			route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
		);
		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [
			{ name: 'first.png', type: 'image/png' },
			{ name: 'middle.png', type: 'image/png' },
			{ name: 'last.png', type: 'image/png' }
		]);
		await expect(page.locator('input[name="imageUrl_2"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});

		// The middle tile is the parent, and its result fills the shared fields.
		await page.getByRole('radio', { name: 'Parent: middle.png' }).check();
		await tileLookup(page).nth(1).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await page.getByRole('button', { name: 'Remove file' }).nth(0).click();

		await expect(page.getByRole('radio', { name: 'Parent: middle.png' })).toBeChecked();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
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

	// The shared artist is far more often picked from the select than applied
	// from the panel, and the warning used to be silent in exactly that case.
	test('says so for an artist picked from the select by hand', async ({ page }) => {
		await twoDoneTiles(page);
		await page.locator('select[name="artistId"]').selectOption({ label: 'Test Artist' });

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
