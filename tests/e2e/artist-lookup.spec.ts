import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';
import { dropOn, waitForDropAttachment } from './drop-files';
import { stubSuggestions } from './tag-suggestions-helpers';

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

// An X status the tag-suggestion pill also recognises. The two features only
// meet on a post BOTH of them can read: FuzzySearch matches it, and the pill
// runs on Bluesky and X links alone — so a FurAffinity match leaves the
// suggestion control refusing and only one pill on the page.
const X_POST = 'https://x.com/kuttoya/status/1789012345678901234';

const X_MATCH = {
	site: 'Twitter',
	siteId: '1789012345678901234',
	handles: ['kuttoya'],
	distance: 0,
	band: 'exact',
	postedAt: '2026-03-04T10:00:00Z',
	rating: 'adult',
	postUrl: X_POST
};

/** One confident match on that X post, rated adult, so the lookup fills the
 * source field with a URL the suggestion pill will accept. `over` changes that
 * one match, which is how the repeat-lookup tests name another post without
 * restating the other seven fields. */
function xMatchBody(over: Record<string, unknown> = {}) {
	return matchedBody({ matches: [{ ...X_MATCH, ...over }] });
}

// A second X status, for the case where a repeat lookup lands somewhere else.
const X_POST_2 = 'https://x.com/kuttoya/status/1789012345678909999';
const X_SITE_ID_2 = '1789012345678909999';
/** The same match on that second post: what a repeat lookup that lands
 * elsewhere comes back with. */
const SECOND_POST = {
	siteId: X_SITE_ID_2,
	postUrl: X_POST_2,
	postedAt: '2026-03-05T10:00:00Z'
};

/** The clash row itself: a piece that already claims the matched post. */
function sourceClash(imageId: number, title: string) {
	return {
		imageId,
		title,
		isVariant: false,
		parentImageId: null,
		variantCount: 0,
		thumbnailUrl: null,
		artistName: 'Test Artist',
		uploadedAt: '2026-07-09T00:00:00.000Z',
		width: 1200,
		height: 900
	};
}

/** The same confident match, plus a source clash on a piece the page never
 * loaded an option for. */
function clashBody(imageId: number, title: string) {
	return matchedBody({ sourceClash: sourceClash(imageId, title) });
}

async function stubLookup(page: Page, body: unknown, status = 200) {
	await page.route('**/api/admin/artist-lookup', (route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
	);
}

/** A lookup stub the test releases by hand. The role a tile plays is only
 * readable at two different moments if the request can be held open while the
 * operator moves the parent or the group mode under it. */
async function deferredLookup(page: Page, body: unknown, status = 200) {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route('**/api/admin/artist-lookup', async (route) => {
		await held;
		await route.fulfill({
			status,
			contentType: 'application/json',
			body: JSON.stringify(body)
		});
	});
	return release;
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
	// A goto that timed out on the route compile can leave that navigation still
	// in flight; waiting for the page's own select once settles it, so the click
	// retry below is not absorbing a late navigation that detaches the button.
	await expect(page.locator('select[name="artistId"]')).toBeVisible({ timeout: 30_000 });
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

/** Save the throwaway key on the settings page, unless it is already there.
 * Hydration-sensitive the same way the tab is: a click that lands before
 * use:enhance is attached posts natively, and the reload resets the tab, leaving
 * the connected state in the DOM but hidden. */
async function saveLookupKey(page: Page) {
	await expect(async () => {
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
		if ((await section(page).locator('button.btn-remove').count()) > 0) return;
		await section(page).locator('input[name="fuzzysearchApiKey"]').fill(FAKE_KEY);
		await section(page).locator('button[type="submit"]').click();
		await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible({ timeout: 1500 });
	}).toPass();
}

const pill = (page: Page) => page.locator('button.lookup-pill');
// The tag-suggestion control's own pill, beside the Tags field (SONA-220).
const suggestPill = (page: Page) => page.getByRole('button', { name: 'Suggest tags', exact: true });
// The page's own polite region (the admin layout has a separate one, a <p>).
const LIVE_REGION = 'div.sr-only[aria-live="polite"]';

/** The suggestion every chips test stubs: three tags and a rating, from the X
 * post the lookup fills the source field with. */
const THREE_TAG_SUGGESTION = {
	source: 'x',
	tags: ['mammal', 'canine', 'fox'],
	rating: 'explicit',
	imageCount: 1
};

const panel = (page: Page) => page.getByRole('region', { name: 'Artist lookup' });

/** The sentence a parent move onto a tile with no lookup of its own leaves on
 * screen. The panel's status region draws it and speaks it, so it is one node:
 * visible, drawn as a report of what the two fields just did rather than in the
 * muted colour the advice lines use, and left in the accessibility tree instead
 * of spoken and gone (4.1.3). */
async function expectMovedEmptiedSentence(page: Page) {
	const emptied = panel(page)
		.locator('p.lookup-status')
		.filter({
			hasText: 'cleared the source post URL and commissioned date the last lookup filled'
		});
	await expect(emptied).toBeVisible();
	await expect(emptied).toHaveClass(/lookup-emptied/);
	await expect(emptied).not.toHaveAttribute('aria-hidden', /.*/);
	// And the panel is the open card, not the collapsed idle one it would be
	// with nothing to draw.
	await expect(panel(page)).toBeVisible();
}

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
	// A new tab, like the other two Settings remedies: the batch on this page
	// would go with a same-tab navigation, and the name says where the click goes.
	await expect(hint.getByRole('link', { name: 'Settings' })).toHaveAttribute('target', '_blank');
	await expect(hint.getByRole('link', { name: 'Settings' })).toHaveAttribute(
		'rel',
		'noopener noreferrer'
	);
	await expect(hint.getByRole('link', { name: 'Settings' })).toHaveAccessibleName(
		'Settings (opens in a new tab)'
	);
});

// Serial: every test below runs against one settings row — the first saves it,
// the last takes it away, and the ones in between need it there.
test.describe.configure({ mode: 'serial' });

test.describe('with a key saved', () => {
	// The key is what puts the button on the page, so every test here needs it
	// saved. It used to be the first test that saved it, which made a filtered
	// run (`-g`) fail on whatever it selected: the row was never written.
	test.beforeAll(async ({ browser }) => {
		// The retry loop inside runs until the hook's own budget, not the test's.
		test.setTimeout(90_000);
		const page = await browser.newPage();
		try {
			await adminLogin(page, PASSWORD);
			await saveLookupKey(page);
		} finally {
			await page.close();
		}
	});

	test.beforeEach(async ({ page }) => {
		test.setTimeout(90_000);
		await adminLogin(page, PASSWORD);
	});

	test('the saved key puts the button on the upload page', async ({ page }) => {
		await page.goto('/admin/settings');
		await openConnectionsTab(page);
		// What the save left behind: the section reports the connection and offers
		// to take it away again.
		await expect(section(page).locator('.key-eyebrow.connected')).toBeVisible();
		await expect(section(page).locator('button.btn-remove')).toBeVisible();

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
		// The date's hint is a sibling of its input rather than inside the label,
		// so it reaches a screen reader only through aria-describedby. The tag
		// joins the hint instead of replacing it.
		await expect(page.locator('input[name="commissionedAt"]')).toHaveAttribute(
			'aria-describedby',
			'commissioned-hint commissioned-lookup-tag'
		);
		await expect(page.locator('input[name="commissionedAt"]')).toHaveAccessibleDescription(
			/Any date that's meaningful to you works here/
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
		// The tag goes, the hint stays described.
		await expect(page.locator('input[name="commissionedAt"]')).toHaveAccessibleDescription(
			/Any date that's meaningful to you works here/
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
		// The swap destroys the button that was just clicked, so without a landing
		// spot focus falls to <body> and the next Tab restarts at the top (2.4.3).
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeFocused();

		// Back to the empty option: the panel stops claiming its artist is in use.
		await page.selectOption('select[name="artistId"]', '');
		await expect(panel(page).getByRole('button', { name: 'Use Test Artist' })).toBeVisible();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toHaveCount(0);
	});

	// The artist options are a page-load snapshot too. An artist created in
	// another tab since then comes back as a candidate the select has no option
	// for, so Use said "Using {name}" over an empty select and `required` refused
	// the save the operator was told had been set up.
	test('Use holds an artist the upload page never loaded an option for', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				localArtists: [{ matchIndex: 0, artists: [{ id: 987, name: 'Made In Another Tab' }] }]
			})
		);
		await oneDoneTile(page);
		const select = page.locator('select[name="artistId"]');
		await expect(select.locator('option[value="987"]')).toHaveCount(0);

		await pill(page).click();
		await panel(page).getByRole('button', { name: 'Use Made In Another Tab' }).click();

		await expect(select).toHaveValue('987');
		await expect(select.locator('option[value="987"]')).toHaveText('Made In Another Tab');

		// And it stays. A carried clash parent belongs to the lookup that found it
		// and goes when the next result does not name it, but an artist is a global
		// record: once this page knows it exists it is in the list, and a second
		// lookup must not take the operator's chosen artist away.
		await stubLookup(page, matchedBody());
		await pill(page).click();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(select.locator('option[value="987"]')).toHaveCount(1);
		await expect(select).toHaveValue('987');
	});

	// The clash row renders the same Use button from the same snippet, so it
	// destroys its own button too. The landing spot lives in the panel rather
	// than in either page, which is what makes both rows behave the same.
	test('Use under a clash lands focus on the applied button too', async ({ page }) => {
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
		await oneDoneTile(page);
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		// The clash row's own action is there, so this is the clash branch and not
		// the plain "existing artist" one.
		await expect(panel(page).getByRole('button', { name: 'Add as a variant' })).toBeVisible();
		// The row's link to the piece it collided with is the fourth new-tab link
		// in the feature, and it says so in its name like the other three.
		const clashOpen = panel(page).getByRole('link', { name: 'Open Test Image' });
		await expect(clashOpen).toHaveAttribute('target', '_blank');
		await expect(clashOpen).toHaveAccessibleName('Open Test Image (opens in a new tab)');

		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();

		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeFocused();
	});

	// The third row that applies an artist: the handle is in nobody's list, but
	// an artist already carries that name. It rendered its own Use button, so it
	// never swapped to "Using" and looked like the click did nothing.
	test('a name match swaps to Using and keeps focus, like the other rows', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				localArtists: [],
				nameMatches: [{ matchIndex: 0, artists: [{ id: 1, name: 'Test Artist' }] }]
			})
		);
		await oneDoneTile(page);
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		// The 'new' outcome's other action, so this is the name-match row.
		await expect(
			panel(page).getByRole('button', { name: 'Add as a new artist instead' })
		).toBeVisible();

		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();

		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeFocused();
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

	// ---- Both rating pills at once (SONA-156 + SONA-220) --------------------
	// The merge put two classifiers beside ONE checkbox, and nothing here or in
	// tag-suggestions.spec.ts had ever drawn them together: that spec's server
	// holds no FuzzySearch key, so the lookup pill is not even on its page.
	// These run here, where the key is saved, with the suggestion endpoint
	// stubbed the same way it is over there.

	test('both rating pills sit beside the one NSFW box, and neither ticks it', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		await oneDoneTile(page);
		const nsfw = page.locator('input[name="nsfw"]');

		// The lookup fills the source field with the post it matched, which is what
		// lets the suggestion run on the same piece without anything being typed.
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#shared-rating-tag')).toHaveText('Rated Adult on Twitter');

		await expect(suggestPill(page)).toHaveAttribute('aria-disabled', 'false');
		await suggestPill(page).click();
		await expect(page.locator('#tags-rating')).toHaveText('Rated explicit by entail.dev.');

		// Both on screen, and the box points at BOTH of them: pinned to one id, the
		// describedby silently drops whichever classifier ran second.
		await expect(page.locator('#shared-rating-tag')).toBeVisible();
		const described = (await nsfw.getAttribute('aria-describedby'))?.split(' ') ?? [];
		expect(described).toContain('shared-rating-tag');
		expect(described).toContain('tags-rating');
		await expect(nsfw).toHaveAccessibleDescription(/Rated Adult on Twitter/);
		await expect(nsfw).toHaveAccessibleDescription(/Rated explicit by entail.dev/);
		// Two guesses about the artwork, still no decision about the gallery.
		await expect(nsfw).not.toBeChecked();

		// On a phone the row wraps, and everything that wraps lines up under the
		// label text rather than under the checkbox. Read as the indent rather than
		// as two boxes: the pill can now shrink its own text, so which line it
		// lands on depends on how long the site list is, while the indent that
		// decides where it lands when it wraps is the same either way. The
		// suggestion's note and button already had it; the lookup's pill did not.
		await page.setViewportSize({ width: 390, height: 900 });
		await expect(page.locator('#shared-rating-tag')).toHaveCSS('margin-left', '24px');
		await expect(page.locator('#tags-rating')).toHaveCSS('margin-left', '24px');
		await expect(page.getByRole('button', { name: 'Mark it NSFW' })).toHaveCSS(
			'margin-left',
			'24px'
		);
		// Whatever did wrap shares one left edge with the rest of the wrapped row.
		const rowTop = (await page.locator('.tag-check-row .checkbox-label').boundingBox())?.y ?? 0;
		const wrapped: number[] = [];
		for (const id of ['#shared-rating-tag', '#tags-rating']) {
			const box = await page.locator(id).boundingBox();
			if (!box) throw new Error(`${id} has no box`);
			if (box.y > rowTop) wrapped.push(box.x);
		}
		expect(wrapped.length).toBeGreaterThan(0);
		for (const x of wrapped) expect(Math.abs(x - wrapped[0])).toBeLessThanOrEqual(1);

		// And on the narrowest phone the long pill wraps its own text rather than
		// pushing the document sideways.
		await page.setViewportSize({ width: 320, height: 900 });
		await expect(page.locator('#shared-rating-tag')).toBeVisible();
		const overflow = await page.evaluate(() => {
			const el = document.scrollingElement;
			return el ? el.scrollWidth - el.clientWidth : 0;
		});
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test('the edit page draws both pills on one row too', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		// 1280 first: what the operator is most likely on, and the width the two
		// forms disagreed at.
		await page.setViewportSize({ width: 1280, height: 900 });
		await gotoEditHydrated(page);
		const nsfw = page.locator('input[name="nsfw"]');

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#lookup-rating-tag')).toHaveText('Rated Adult on Twitter');

		await expect(suggestPill(page)).toHaveAttribute('aria-disabled', 'false');
		await suggestPill(page).click();
		await expect(page.locator('#tags-rating')).toHaveText('Rated explicit by entail.dev.');

		const described = (await nsfw.getAttribute('aria-describedby'))?.split(' ') ?? [];
		expect(described).toContain('lookup-rating-tag');
		expect(described).toContain('tags-rating');
		await expect(nsfw).toHaveAccessibleDescription(/Rated Adult on Twitter/);
		await expect(nsfw).toHaveAccessibleDescription(/Rated explicit by entail.dev/);
		await expect(nsfw).not.toBeChecked();

		// All four items hold one row at this width. They want about 606px in a
		// 600px column, and flex breaks a line on content size however shrinkable
		// an item is, so "Mark it NSFW" used to drop to a row of its own here while
		// the upload form, 800px wide, kept it inline. The two pills give up the
		// difference instead and wrap their own text (SONA-220).
		await expect(page.locator('#lookup-rating-tag')).toBeVisible();
		await expect(page.locator('#tags-rating')).toBeVisible();
		// Every width below is measured in the theme's own face, so wait for the
		// self-hosted JetBrains Mono to load before reading a box (SONA-181).
		await page.evaluate(() => document.fonts.ready);
		// And say so if it did not: fonts.ready resolves on a failed fetch too, and
		// a missing face would otherwise fail below as an unexplained wrap.
		expect(await page.evaluate(() => document.fonts.check('11px "JetBrains Mono"'))).toBe(true);
		// Compared by centre, not by top: the row centres its items, and the button
		// is 36px tall beside an 18px label, so equal tops would be the wrong test
		// for "same row" — they were never equal, even before the button wrapped.
		const centre = async (selector: string) => {
			const box = await page.locator(selector).boundingBox();
			if (!box) throw new Error(`${selector} has no box`);
			return box.y + box.height / 2;
		};
		const labelCentre = await centre('.tag-check-row .checkbox-label');
		for (const selector of [
			'#lookup-rating-tag',
			'#tags-rating',
			'.tag-check-row .btn'
		]) {
			expect(Math.abs((await centre(selector)) - labelCentre)).toBeLessThanOrEqual(1);
		}
		await expect(page.locator('.tag-check-row .btn')).toHaveText('Mark it NSFW');
		// One line each, not just one row. The note wrapped "entail.dev." onto a
		// second line for an 8px shortfall, which the row's own gap pays for: three
		// gaps at 4px instead of 8px buys back 12px (SONA-220).
		const button = await page.locator('.tag-check-row .btn').boundingBox();
		if (!button) throw new Error('the button has no box');
		expect(button.height).toBeLessThan(44);
		for (const selector of ['#tags-rating', '#lookup-rating-tag']) {
			const box = await page.locator(selector).boundingBox();
			if (!box) throw new Error(`${selector} has no box`);
			expect(box.height).toBeLessThan(24);
		}
		await expect(page.locator('.tag-check-row')).toHaveCSS('gap', '4px');
		// The 4px is between the two rating items, which report the same kind of
		// thing. The action after them takes some of that separation back, and all
		// four still hold one line each — 8px here wrapped the note.
		await expect(page.locator('.tag-check-row .btn')).toHaveCSS('margin-left', '4px');
		const wideNote = await page.locator('#tags-rating').boundingBox();
		const wideButton = await page.locator('.tag-check-row .btn').boundingBox();
		if (!wideNote || !wideButton) throw new Error('the wide row has no box');
		expect(wideButton.x - (wideNote.x + wideNote.width)).toBeGreaterThanOrEqual(7);
		// And the phone is untouched by that: shrinking the pills is a rule for the
		// wide row only, so at 320 the row still wraps whole items, each onto its
		// own line under the label text rather than under the checkbox.
		await page.setViewportSize({ width: 320, height: 900 });
		const label = await page.locator('.tag-check-row .checkbox-label').boundingBox();
		if (!label) throw new Error('the checkbox label has no box');
		for (const selector of [
			'#lookup-rating-tag',
			'#tags-rating',
			'.tag-check-row .btn'
		]) {
			const box = await page.locator(selector).boundingBox();
			if (!box) throw new Error(`${selector} has no box`);
			expect(box.y).toBeGreaterThan(label.y);
			expect(box.x).toBeCloseTo(label.x + 24, 0);
		}
		// Wrapped rather than pushed: the page still does not scroll sideways.
		const overflow = await page.evaluate(() => {
			const el = document.scrollingElement;
			return el ? el.scrollWidth - el.clientWidth : 0;
		});
		expect(overflow).toBeLessThanOrEqual(0);

		// 900px: the layout is still two columns here, so this form's column is
		// 284px — far narrower than the window. That is the range the row's
		// wrapping has to be keyed to. A viewport-keyed shrink rule let both
		// rating items collapse to about one character per line in that column.
		await page.setViewportSize({ width: 900, height: 900 });
		for (const selector of ['#lookup-rating-tag', '#tags-rating']) {
			const box = await page.locator(selector).boundingBox();
			if (!box) throw new Error(`${selector} has no box`);
			// One line is 18px for the pill and 16px for the note, and each extra
			// line adds about the same again, so 60px is inside three lines. The
			// shattered state measured 88px and taller.
			expect(box.height).toBeLessThanOrEqual(60);
			// And no item is squeezed under its floor, which is what shattered the
			// text in the first place.
			expect(box.width).toBeGreaterThanOrEqual(60);
		}
		const narrowOverflow = await page.evaluate(() => {
			const el = document.scrollingElement;
			return el ? el.scrollWidth - el.clientWidth : 0;
		});
		expect(narrowOverflow).toBeLessThanOrEqual(0);

		// 1024: a wide window whose column is still under 560px. Wrapping put the
		// 24px indent on items that had not wrapped, so the row read as inline with
		// 32px gaps between its items. Stacked, every item that carries the indent
		// is on a line of its own and they share one left edge.
		await page.setViewportSize({ width: 1024, height: 900 });
		const pillBox = await page.locator('#lookup-rating-tag').boundingBox();
		const noteBox = await page.locator('#tags-rating').boundingBox();
		const buttonBox = await page.locator('.tag-check-row .btn').boundingBox();
		if (!pillBox || !noteBox || !buttonBox) throw new Error('the stacked row has no box');
		expect(buttonBox.x).toBeCloseTo(pillBox.x, 0);
		expect(noteBox.x).toBeCloseTo(pillBox.x, 0);
		// Stacked, not inline: each one sits below the one before it.
		expect(noteBox.y).toBeGreaterThan(pillBox.y);
		expect(buttonBox.y).toBeGreaterThan(noteBox.y);
	});

	// ---- The Source Post URL field's own two descriptions --------------------
	// That field can be described twice at once as well: the suggestion control's
	// hint refusing the link it holds (SONA-220) and the "From lookup" tag on the
	// value a lookup wrote into it (SONA-156). Neither spec had ever put both
	// there, so the join could have dropped one and stayed green.

	/** Lookup first so the source URL is filled AND tagged, then a refused
	 * suggestion on that same URL so the hint points at the field too. The other
	 * order pins nothing: a refusal leaves the operator's own URL in the field,
	 * which the lookup then declines to overwrite, so no tag is ever added. */
	async function bothSourceDescriptions(page: Page) {
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');

		await expect(suggestPill(page)).toHaveAttribute('aria-disabled', 'false');
		await suggestPill(page).click();
		await expect(page.locator('#tags-hint')).toHaveText(
			"Sona can't look up this link. Check the source post URL."
		);

		// Both ids, space-separated, in one attribute — and both still resolve to
		// something on the page, which is what an id in describedby is worth.
		await expect(sourceInput(page)).toHaveAttribute(
			'aria-describedby',
			'tags-hint source-lookup-tag'
		);
		await expect(page.locator('#tags-hint')).toBeVisible();
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		// Read as one description rather than as two ids, the way a screen reader
		// would announce it on focus.
		await expect(sourceInput(page)).toHaveAccessibleDescription(
			/Sona can't look up this link[\s\S]*From lookup/
		);
	}

	test('the source URL field carries the refusal and the lookup tag at once', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 422, { error: 'unsupported_source' });
		await oneDoneTile(page);
		await bothSourceDescriptions(page);
	});

	test('the edit page joins the same two descriptions on that field', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 422, { error: 'unsupported_source' });
		await gotoEditHydrated(page);
		await bothSourceDescriptions(page);
	});

	/** A repeat lookup on the SAME post, then one that fails outright. Neither is
	 * a reason to disturb the source URL field, and the suggestion standing on it
	 * survives both. The source URL used to be blanked the moment the second
	 * lookup started and refilled only when it came back, so the control saw the
	 * post change and threw away chips the operator was still choosing from. */
	async function chipsSurviveARepeatLookup(page: Page) {
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await suggestPill(page).click();
		await expect(page.locator('.tag-chip')).toHaveCount(3);

		await pill(page).click();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('.tag-chip')).toHaveCount(3);
		await expect(page.locator('#tags-rating')).toHaveText('Rated explicit by entail.dev.');

		// And a lookup that fails outright leaves the field as it was, rather than
		// emptying it with nothing to put back.
		await stubLookup(page, { enabled: true, error: 'rate_limited', forwarded: true }, 429);
		await pill(page).click();
		await expect(panel(page)).toContainText(
			'FuzzySearch is limiting how often your site can search right now.'
		);
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
		await expect(page.locator('.tag-chip')).toHaveCount(3);

		// Nothing was ever set aside, so nothing said it was. The control announces
		// that only when the post under it really changes, and neither a repeat of
		// the same post nor a failed lookup is that.
		await expect(page.locator('#tags-status')).not.toContainText('set that lookup aside');
	}

	test('a second lookup that lands on the same post keeps the suggested chips', async ({
		page
	}) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		await oneDoneTile(page);
		await chipsSurviveARepeatLookup(page);
	});

	/** The other half of the same rule: keeping the field through the round trip
	 * must not turn into keeping a URL the new result disagrees with. The
	 * replacement happens when the result lands, and the suggestion about the old
	 * post goes then — not at the click, and not never. */
	async function aRepeatLookupElsewhereReplacesTheURL(page: Page) {
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await suggestPill(page).click();
		await expect(page.locator('.tag-chip')).toHaveCount(3);

		await stubLookup(page, xMatchBody(SECOND_POST));
		await pill(page).click();

		await expect(sourceInput(page)).toHaveValue(X_POST_2);
		await expect(dateInput(page)).toHaveValue('2026-03-05');
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
		// The suggestion was about the old post, so it goes with it — and says so.
		await expect(page.locator('.tag-chip')).toHaveCount(0);
		await expect(page.locator('#tags-rating')).toHaveCount(0);
		await expect(page.locator('#tags-status')).toHaveText(
			'The source post URL changed, so Sona set that lookup aside.'
		);
	}

	test('a second lookup that lands elsewhere replaces the URL, and the chips go with it', async ({
		page
	}) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		await oneDoneTile(page);
		await aRepeatLookupElsewhereReplacesTheURL(page);
	});

	test('the edit page replaces the URL when the repeat lookup lands elsewhere', async ({
		page
	}) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		await gotoEditHydrated(page);
		await aRepeatLookupElsewhereReplacesTheURL(page);
	});

	// The click-time reset was narrowed so a repeat lookup keeps the field it is
	// about to refill. Moving the PARENT is a different question with the same
	// shape, and it keeps the full reset: the shared fields describe whichever
	// tile is parent now, so a URL filled from the old parent's post must not
	// survive under the new one still wearing "From lookup".
	test('moving the parent still clears what the last lookup filled', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await twoDoneTiles(page);

		// In a set the lookup is per tile, and the first tile is the parent.
		await tileLookup(page).first().click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile has no result of its own, so there is nothing to
		// re-derive and the fields go back to empty rather than keeping the first
		// tile's post.
		await page.getByRole('radio', { name: 'Parent: back.png' }).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		// And it says so. The new parent has no result, so the panel's idle arm is
		// what carries the sentence for the two fields that just emptied under the
		// operator (4.1.3).
		await expectMovedEmptiedSentence(page);
	});

	test('a clash after a lookup says it emptied the field, not that it was empty', async ({
		page
	}) => {
		// The clash sentence turns on what was in the field when the prefill ran.
		// The previous lookup's value is nobody's to keep, so it is not "your" URL
		// — and it is not an empty field either: this result blanked it under the
		// operator, and "left the source post URL empty" would quietly claim it had
		// been empty all along (SONA-220).
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');

		// The X match with a clash on it: the post already belongs to another
		// piece, so the prefill deliberately puts no source URL back.
		await stubLookup(page, { ...xMatchBody(), sourceClash: sourceClash(9001, 'Clash Piece') });
		await pill(page).click();

		await expect(panel(page)).toContainText(
			'cleared the source post URL the last lookup filled, because the post Sona just found is already the source of Clash Piece'
		);
		await expect(panel(page)).not.toContainText('left your source post URL as it was');
		await expect(panel(page)).not.toContainText('left the source post URL empty');
		// And drawn as a report of what just happened to the field, like every
		// other sentence that says one went blank, rather than in the muted colour
		// the advice lines use.
		await expect(
			panel(page)
				.locator('p.lookup-status')
				.filter({ hasText: 'cleared the source post URL the last lookup filled' })
		).toHaveClass(/lookup-emptied/);
		// And the sentence matches the field: the tagged value the first lookup
		// wrote is gone, because this result had nothing to put in its place.
		await expect(sourceInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);

		// The operator types a URL into the field the clash emptied. The clearing
		// is no longer theirs to be told about — but the plain clash sentence says
		// the URL was "left empty", which the text they just typed contradicts, so
		// the kept one answers instead (SONA-220).
		await sourceInput(page).fill('https://www.furaffinity.net/view/999999/');
		await expect(panel(page)).toContainText(
			'left your source post URL as it was, because that post is already the source of Clash Piece'
		);
		await expect(panel(page)).not.toContainText('left the source post URL empty');
		await expect(panel(page)).not.toContainText('cleared the source post URL');
		await expect(sourceInput(page)).toHaveValue('https://www.furaffinity.net/view/999999/');
	});

	/** A no-match is a result too, and it prefills nothing. It used to return
	 * before the clearing branches, so the first lookup's URL and date stayed on
	 * the form, still tagged "From lookup", under a panel saying Sona found
	 * nothing — the values and the sentence disagreeing on the same screen. */
	async function aNoMatchEmptiesWhatTheLastLookupFilled(page: Page) {
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		await stubLookup(page, { enabled: true, matches: [] });
		await pill(page).click();

		await expect(panel(page)).toContainText('Nothing matched on FurAffinity');
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		// The no-match arm carries no status line of its own, so the sentence is
		// rendered there beside the body rather than only under a result.
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one.'
		);
	}

	test('a no-match empties the fields the last lookup filled', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);
		await aNoMatchEmptiesWhatTheLastLookupFilled(page);
	});

	test('the edit page empties them on a no-match too', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);
		await aNoMatchEmptiesWhatTheLastLookupFilled(page);
	});

	// The record of what that no-match emptied is worked out once and rendered on
	// every frame after. The operator is free to type into either field, and the
	// sentence for a cleared one invites them to fill in something already
	// sitting in the input — so each half goes as its field is filled, and when
	// both are the panel says nothing about them at all (SONA-220).
	async function typingIntoAnEmptiedFieldDropsItsHalfOfTheSentence(page: Page) {
		await aNoMatchEmptiesWhatTheLastLookupFilled(page);

		await sourceInput(page).fill('https://www.furaffinity.net/view/999999/');
		// Half the sentence goes with it. The date is still Sona's doing, so that
		// half stands, and the URL is named by nothing.
		await expect(panel(page)).toContainText(
			'Sona cleared the commissioned date the last lookup filled, because this lookup filled no date in its place.'
		);
		await expect(panel(page)).not.toContainText('cleared the source post URL');

		await dateInput(page).fill('2026-05-06');
		await expect(panel(page)).not.toContainText('the last lookup filled');
		// And the no-match itself is still on screen: only the sentence about the
		// two fields went.
		await expect(panel(page)).toContainText('Nothing matched on FurAffinity');

		// Deleting what they typed does not hand the clearing back to Sona. The
		// field is empty again, but the operator emptied it this time, and the
		// sentence would re-attribute their own deletion — so the flag stays down
		// once their first keystroke put it there (SONA-220).
		await sourceInput(page).fill('');
		await dateInput(page).fill('');
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(panel(page)).not.toContainText('cleared the source post URL');
		await expect(panel(page)).not.toContainText('cleared the commissioned date');
		await expect(panel(page)).not.toContainText('the last lookup filled');
		await expect(panel(page)).toContainText('Nothing matched on FurAffinity');
	}

	test('typing into an emptied field stops the panel naming it', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);
		await typingIntoAnEmptiedFieldDropsItsHalfOfTheSentence(page);
	});

	test('the edit page stops naming an emptied field the operator fills too', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);
		await typingIntoAnEmptiedFieldDropsItsHalfOfTheSentence(page);
	});

	// The branch that empties the commissioned date had no test of its own: a
	// second result that carries a post but no date leaves the field the first one
	// filled with nothing to refill it, so it goes when the result lands — and the
	// panel's role="status" has to say so rather than "left the date as it was".
	test('a repeat lookup on a dateless post empties the date it filled', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		await stubLookup(page, xMatchBody({ ...SECOND_POST, postedAt: null }));
		await pill(page).click();

		// The URL took the new post, and the date it can no longer stand behind is
		// empty rather than left describing the old one.
		await expect(sourceInput(page)).toHaveValue(X_POST_2);
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL from the Twitter post and cleared the commissioned date the last lookup filled, because that post has no date.'
		);
		await expect(panel(page)).not.toContainText('left the commissioned date as it was');
	});

	// Dropping the cleared flag off a field the operator filled must not reroute
	// the sentence to url_only, which says the date was "left as it was" — this
	// result emptied it under them, and the flag going does not undo that. The
	// kept sentence claims the URL and says nothing about the date (SONA-220).
	test('a date typed over an emptied one keeps the sentence off it', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await stubLookup(page, xMatchBody({ ...SECOND_POST, postedAt: null }));
		await pill(page).click();
		await expect(dateInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText('cleared the commissioned date the last lookup filled');

		await dateInput(page).fill('2026-05-06');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL from the Twitter post. You can change it before you save.'
		);
		await expect(panel(page)).not.toContainText('cleared the commissioned date');
		await expect(panel(page)).not.toContainText('left the commissioned date as it was');
		// The date they typed is still theirs, and the URL the lookup wrote is
		// still tagged as its own.
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
	});

	/** Four lookups on the same tile, and the operator typing between two of
	 * them. The typed-into latch keeps their own text out of Sona's cleared
	 * claim, and on the upload page it outlived the result it was raised
	 * against: the parent tile has no per-lookup reset, so a latch raised while
	 * one field sat empty was still up two results later, over a URL the next
	 * lookup had refilled and tagged. The result after that blanked the field and
	 * the stale latch dropped its own cleared flag, so the panel said nothing
	 * about a field the operator watched go blank. applyShared recomputes both
	 * latches against each result now; the edit page reaches the same place
	 * through resetLookupPrefill, which runs at every lookup start (SONA-220).
	 *
	 * Both endings run the same four lookups, so the sequence lives here once and
	 * the caller supplies the refill body, the result that closes it, and what
	 * the panel has to say about the URL afterwards. `absent` is the sentence
	 * that ending must NOT produce. */
	async function aRefilledUrlIsStillSonas(
		page: Page,
		opts: { refill: unknown; closing: unknown; says: string; absent?: string }
	) {
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');

		// A no-match takes it away again, and says so. Only the URL half of that
		// sentence is pinned: the clash ending's stubs carry a date, so its
		// no-match names the date here as well.
		await stubLookup(page, { enabled: true, matches: [] });
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText('Sona cleared the source post URL');

		// A URL typed and deleted. The field is empty and theirs, which is exactly
		// the state the latch exists for.
		await sourceInput(page).fill('https://www.furaffinity.net/view/999999/');
		await sourceInput(page).fill('');

		// A matching lookup puts the URL back and tags it. Nothing in the field is
		// theirs any more.
		await stubLookup(page, opts.refill);
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');

		// And the fourth result empties it. Under the stale latch the panel said
		// nothing at all about a field that had just gone blank.
		await stubLookup(page, opts.closing);
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText(opts.says);
		if (opts.absent) await expect(panel(page)).not.toContainText(opts.absent);
	}

	/** The no-match ending: every stub has no posted date, so each sentence is
	 * about the URL alone. */
	const goesBackToBeingSonas = {
		refill: xMatchBody({ postedAt: null }),
		closing: { enabled: true, matches: [] },
		says: 'Sona cleared the source post URL the last lookup filled, because this lookup filled nothing in its place.'
	};

	/** The clash ending, which is the worse half: the stale latch dropped the
	 * cleared flag, and with a date to report the clash sentence then read "left
	 * your source post URL as it was" over a field the same result had just
	 * blanked (SONA-220). The clash fills the date and has nowhere to put its
	 * URL. */
	const isNotLeftAsItWasByAClash = {
		refill: xMatchBody(),
		closing: { ...xMatchBody(), sourceClash: sourceClash(9001, 'Clash Piece') },
		says: 'Sona filled the commissioned date from the Twitter post and cleared the source post URL the last lookup filled, because the post Sona just found is already the source of Clash Piece.',
		absent: 'left your source post URL as it was'
	};

	test('a fourth lookup still says it cleared a URL the operator once typed in', async ({
		page
	}) => {
		await stubLookup(page, xMatchBody({ postedAt: null }));
		await oneDoneTile(page);
		await aRefilledUrlIsStillSonas(page, goesBackToBeingSonas);
	});

	test('the edit page says so too', async ({ page }) => {
		await stubLookup(page, xMatchBody({ postedAt: null }));
		await gotoEditHydrated(page);
		await aRefilledUrlIsStillSonas(page, goesBackToBeingSonas);
	});

	test('and a clash after one does not say it left their URL as it was', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await oneDoneTile(page);
		await aRefilledUrlIsStillSonas(page, isNotLeftAsItWasByAClash);
	});

	test('the edit page does not say it either', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);
		await aRefilledUrlIsStillSonas(page, isNotLeftAsItWasByAClash);
	});

	// The same three cases on the edit page, which ran its full reset at the click
	// until now: a repeat lookup there dropped the chips and the rating of a
	// suggestion about the very post it was on its way back with.
	test('the edit page keeps the suggested chips through a repeat lookup', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await stubSuggestions(page, 200, THREE_TAG_SUGGESTION);
		await gotoEditHydrated(page);
		await chipsSurviveARepeatLookup(page);
	});

	test('the edit page empties both fields when the result has nothing to put back', async ({
		page
	}) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		// Nothing confident enough to prefill from: the second result offers no
		// post at all, so both fields the first one filled are emptied when it
		// lands — and the panel names them rather than claiming they were kept.
		await stubLookup(page, xMatchBody({ band: 'possible' }));
		await pill(page).click();

		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one.'
		);
		await expect(panel(page)).not.toContainText('left the source post URL as it was');
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
		// A new tab: the remedy must not navigate the upload away, batch and all —
		// and the name says so, the way every other new-tab link on the admin does.
		await expect(panel(page).getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
			'target',
			'_blank'
		);
		await expect(panel(page).getByRole('link', { name: 'Open Settings' })).toHaveAccessibleName(
			'Open Settings (opens in a new tab)'
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
			'Sona sent this file to FuzzySearch while it was marked private.'
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
		// The hint under the date is a sibling of the input here too, so it is
		// described with no tag on the field at all.
		await expect(dateInput(page)).toHaveAccessibleDescription(
			/Any date that's meaningful to you works here/
		);
	});

	// The upload page's own pair, the same two orders as the edit page's below.
	// The notice used to read the live Private box, so ticking it after a
	// resolved lookup claimed a send that was not marked private.
	test('the upload page does not call a published lookup private after the fact', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).not.toContainText('Sona sent this file to FuzzySearch');

		await page.check('input[name="published"]');
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');
		await expect(panel(page)).not.toContainText('Sona sent this file to FuzzySearch');
	});

	// And back the other way: the file that went out was the private one, so
	// unticking cannot rewrite that. The hint is about the NEXT click, so it goes.
	test('the upload page keeps the notice after Private is unticked', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		const privateBox = page.locator('input[name="published"]');
		await privateBox.check();
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText(
			'Sona sent this file to FuzzySearch while it was marked private.'
		);

		await privateBox.uncheck();
		await expect(page.locator('#lookup-hint')).not.toContainText('This image is private.');
		await expect(panel(page)).toContainText('Sona sent this file to FuzzySearch');
	});

	// The same snapshot on a variant tile, whose notice renders on the tile
	// itself rather than in the panel.
	test('a variant tile holds its own private disclosure', async ({ page }) => {
		await stubLookup(page, otherArtistBody());
		await twoDoneTiles(page);

		const privateBox = page.locator('input[name="published"]');
		await privateBox.check();
		await tileLookup(page).nth(1).click();
		await expect(page.locator('.tile-private-notice')).toContainText(
			'Sona sent this file to FuzzySearch while it was marked private.'
		);
		// The notice is a plain paragraph outside any live region, so the spoken
		// outcome has to carry the disclosure with it.
		await expect(page.locator(LIVE_REGION)).toHaveText(
			'back.png: kuttoya on FurAffinity, Exact match. Sona sent this file to FuzzySearch while it was marked private.'
		);

		// Unticking leaves the send that already happened described as it was.
		await privateBox.uncheck();
		await expect(page.locator('.tile-private-notice')).toHaveCount(1);

		// And the parent tile, never looked up, never claims a send.
		await tileLookup(page).nth(0).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).not.toContainText('Sona sent this file to FuzzySearch');
	});

	// The disclosure used to read the image as it was last SAVED, so an operator
	// who ticked Private and then ran the lookup was told nothing either before
	// the click or after it, while the file went to FuzzySearch just the same.
	// Image 1 is published in the seed, so ticking the box is a real change; the
	// spec never saves, so the row stays as seeded.
	test('the edit page discloses a lookup on an image just ticked Private', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page, '/admin/images/1/edit');
		const privateBox = page.locator('input[name="published"]');
		await expect(page.locator('#lookup-hint')).not.toContainText('This image is private.');

		await privateBox.check();
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText(
			'Sona sent this file to FuzzySearch while it was marked private.'
		);

		// And back the other way. The hint is about the NEXT click, so it goes;
		// the notice describes the file that already went out, which was the
		// private one, so unticking cannot rewrite it.
		await privateBox.uncheck();
		await expect(page.locator('#lookup-hint')).not.toContainText('This image is private.');
		await expect(panel(page)).toContainText('Sona sent this file to FuzzySearch');
	});

	// The other order. Read live, the notice claimed a private file had been sent
	// when the file that actually went out was the published one.
	test('the edit page does not call a published lookup private after the fact', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page, '/admin/images/1/edit');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).not.toContainText('Sona sent this file to FuzzySearch');

		await page.locator('input[name="published"]').check();
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');
		await expect(panel(page)).not.toContainText('Sona sent this file to FuzzySearch');
	});

	// Image 10 is unpublished in the seed. Unticking Private says what the next
	// save should do; until it happens the stored row still hides the file, so
	// the lookup is still a private-file lookup and both lines have to say so.
	test('the edit page discloses a lookup on an unpublished row with Private unticked', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await gotoEditHydrated(page);
		const privateBox = page.locator('input[name="published"]');
		await expect(privateBox).toBeChecked();
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');

		await privateBox.uncheck();
		await expect(page.locator('#lookup-hint')).toContainText('This image is private.');

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText(
			'Sona sent this file to FuzzySearch while it was marked private.'
		);
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
		// Applying swaps this button the way the other rows swap, and focus lands
		// on the replacement — it used to sit unchanged with focus on <body>.
		const applied = panel(page).getByRole('button', { name: 'Using Test Artist' });
		await expect(applied).toBeVisible();
		await expect(applied).toBeFocused();
		await expect(
			panel(page).getByRole('button', { name: 'Use selected artist' })
		).toHaveCount(0);
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

	// The parent options are built when the page loads. A clash piece uploaded in
	// another tab since then matches none of them, so the select fell back to
	// blank with the panel already closed: the operator asked for a variant and
	// the save stored no parent at all.
	test('adds a clash the page never loaded as a variant parent anyway', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				sourceClash: {
					// No such image in the seed, so no option was rendered for it.
					imageId: 999,
					title: 'Uploaded In Another Tab',
					isVariant: false,
					parentImageId: null,
					variantCount: 0,
					thumbnailUrl: null,
					artistName: 'Test Artist',
					uploadedAt: '2026-07-09T00:00:00.000Z',
					width: 1200,
					height: 900
				}
			})
		);
		await gotoEditHydrated(page);
		const parent = page.locator('select[name="parentImageId"]');
		await expect(parent.locator('option[value="999"]')).toHaveCount(0);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await panel(page).getByRole('button', { name: 'Add as a variant' }).click();

		await expect(parent).toHaveValue('999');
		await expect(parent.locator('option[value="999"]')).toHaveText('Uploaded In Another Tab');
	});

	// Same snapshot problem one control over: the artist the lookup names can be
	// one created in another tab since this page loaded.
	test('Use holds an artist the edit page never loaded an option for', async ({ page }) => {
		await stubLookup(
			page,
			matchedBody({
				localArtists: [{ matchIndex: 0, artists: [{ id: 987, name: 'Made In Another Tab' }] }]
			})
		);
		await gotoEditHydrated(page);
		const select = page.locator('select[name="artistId"]');
		await expect(select.locator('option[value="987"]')).toHaveCount(0);

		await pill(page).click();
		await panel(page).getByRole('button', { name: 'Use Made In Another Tab' }).click();

		await expect(select).toHaveValue('987');
		await expect(select.locator('option[value="987"]')).toHaveText('Made In Another Tab');

		// And it stays. A carried clash parent belongs to the lookup that found it
		// and goes when the next result does not name it, but an artist is a global
		// record: once this page knows it exists it is in the list, and a second
		// lookup must not take the operator's chosen artist away.
		await stubLookup(page, matchedBody());
		await pill(page).click();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(select.locator('option[value="987"]')).toHaveCount(1);
		await expect(select).toHaveValue('987');
	});

	// A carried option belongs to the lookup that found it. The edit page's reset
	// on a repeat lookup used to skip them, so the first clash stayed on offer
	// for a result that no longer names it — and dropping the one the operator
	// chose would blank the select instead, which is what carrying it in
	// prevented.
	test('a second lookup keeps a chosen clash parent and drops an unchosen one', async ({
		page
	}) => {
		await stubLookup(page, clashBody(999, 'Uploaded In Another Tab'));
		await gotoEditHydrated(page);
		const parent = page.locator('select[name="parentImageId"]');

		await pill(page).click();
		await panel(page).getByRole('button', { name: 'Add as a variant' }).click();
		await expect(parent).toHaveValue('999');

		// Second lookup, a different clash, and the operator's pick untouched.
		await stubLookup(page, clashBody(998, 'Also In Another Tab'));
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(parent).toHaveValue('999');
		await expect(parent.locator('option[value="999"]')).toHaveCount(1);

		// Off the carried option, and now a third lookup has no reason to keep it.
		await parent.selectOption('');
		await stubLookup(page, matchedBody());
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await expect(parent.locator('option[value="999"]')).toHaveCount(0);
		await expect(parent).toHaveValue('');
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

	// Both directions of the same switch on the edit page. The name-match result
	// offers Use and "Add as a new artist instead" together, so the form can
	// change hands twice without a second lookup.
	test('the edit form shows each panel sentence only in the mode its fields are in', async ({
		page
	}) => {
		await stubLookup(
			page,
			matchedBody({
				localArtists: [],
				nameMatches: [{ matchIndex: 0, artists: [{ id: 1, name: 'Test Artist' }] }]
			})
		);
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await panel(page).getByRole('button', { name: 'Add as a new artist instead' }).click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveText('From lookup');
		await expect(page.locator('#furaffinity-lookup-tag')).toHaveText('From lookup');
		await expect(panel(page)).toContainText(
			"Sona filled the new artist's name and FurAffinity link."
		);

		// Use puts the select back, unmounting the fields the seed sentence is
		// about: the sentence went on naming a name and a link that were gone.
		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
		await expect(page.locator('input[name="artistName"]')).toHaveCount(0);
		await expect(panel(page)).not.toContainText("Sona filled the new artist's");
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();

		// And back: the save now posts artistId=new and creates somebody else, so
		// nothing is applied any more. The panel kept saying "Using Test Artist".
		await panel(page).getByRole('button', { name: 'Add as a new artist instead' }).click();
		// The inline fields come back with their values, their "From lookup" tags,
		// and the sentence naming them together. Cleared on Use, they would have
		// come back as Sona's values with nothing saying where they came from.
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveText('From lookup');
		await expect(page.locator('#furaffinity-lookup-tag')).toHaveText('From lookup');
		await expect(panel(page)).toContainText(
			"Sona filled the new artist's name and FurAffinity link."
		);
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toHaveCount(0);
		await expect(panel(page).getByRole('button', { name: 'Use Test Artist' })).toBeVisible();

		// The toggle above the form is the same flip by hand, and it reaches the
		// panel the same way: back on the select the artist is applied again,
		// because the select is what saves; in new-artist mode it is not.
		await page.getByRole('button', { name: 'Select Existing' }).click();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
		await expect(panel(page)).not.toContainText("Sona filled the new artist's");
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toHaveCount(0);
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveText('From lookup');
		await expect(panel(page)).toContainText(
			"Sona filled the new artist's name and FurAffinity link."
		);
	});

	// The other half of the same rule. resetLookupPrefill undoes only what is
	// still tagged, so tags dropped on Use would put the first handle's name and
	// link out of the next lookup's reach: the form would come back holding a
	// name from the superseded result, and the save would create an artist
	// called that.
	test('a second lookup after Use clears the first handle from the inline form', async ({
		page
	}) => {
		await stubLookup(
			page,
			matchedBody({
				localArtists: [],
				nameMatches: [{ matchIndex: 0, artists: [{ id: 1, name: 'Test Artist' }] }]
			})
		);
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await panel(page).getByRole('button', { name: 'Add as a new artist instead' }).click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(
			/kuttoya/
		);
		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');

		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '67890',
						handles: ['sabaudon'],
						distance: 0,
						band: 'exact',
						postedAt: '2026-05-06T10:00:00Z',
						rating: 'general',
						postUrl: 'https://www.furaffinity.net/view/67890/'
					}
				],
				localArtists: [],
				nameMatches: [{ matchIndex: 0, artists: [{ id: 1, name: 'Test Artist' }] }]
			})
		);
		await pill(page).click();
		await expect(panel(page)).toContainText('Exact match');

		// Opened by hand, the form holds nothing from the first result.
		await page.getByRole('button', { name: 'Add New Artist' }).click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue('');

		// And the second result seeds its own handle into it.
		await panel(page).getByRole('button', { name: 'Add as a new artist instead' }).click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('sabaudon');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(/sabaudon/);
		await expect(page.locator('input[name="furaffinity"]')).not.toHaveValue(/kuttoya/);
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

	// The per-field seed merge and the second click's announcement were pinned by
	// source regexes only. A second click must write nothing and say so, and a
	// re-seed after the operator clears ONE field must not retract the other
	// field's value, its tag, or the sentence naming it.
	test('a second add-new click says it wrote nothing, and a partial re-seed keeps the rest', async ({
		page
	}) => {
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(
			'https://www.furaffinity.net/user/kuttoya/'
		);
		await expect(panel(page)).toContainText(
			"Sona filled the new artist's name and FurAffinity link."
		);

		// Both fields are taken now, so this click writes nothing anywhere. The
		// panel's sentence cannot change to report that, so the live region does.
		await addNew.click();
		await expect(page.locator(LIVE_REGION)).toHaveText(
			"The new artist's fields already have values, so Sona left them alone."
		);

		// Clearing the name drops its tag, so the sentence stops claiming it.
		await page.fill('input[name="artistName"]', '');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveCount(0);
		await expect(panel(page)).toContainText("Sona filled the new artist's FurAffinity link.");

		// The re-seed writes the name back and nothing else. Replaced rather than
		// merged, the record would drop the FurAffinity link while the field kept
		// its value and its tag.
		await addNew.click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue(
			'https://www.furaffinity.net/user/kuttoya/'
		);
		await expect(page.locator('#furaffinity-lookup-tag')).toBeVisible();
		// And the sentence claims both fields again. That swap is what answers this
		// click: the panel body is an atomic role="status", so it is announced.
		await expect(panel(page)).toContainText(
			"Sona filled the new artist's name and FurAffinity link."
		);
	});

	// The no_match action carries no handle, so it never had anything to fill.
	// Answered with the seed-kept line, it claimed fields "already have values,
	// so Sona left them alone" while the FurAffinity field sat empty.
	test('a repeat no-match add-new click says the form is open, not that it kept fields', async ({
		page
	}) => {
		await stubLookup(page, matchedBody({ matches: [], localArtists: [], nameMatches: [] }));
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		const addNew = panel(page).getByRole('button', { name: 'Add New Artist' });
		await addNew.click();
		await expect(page.locator(LIVE_REGION)).toHaveText(
			'Switched to the new artist form. Add the artist by hand.'
		);

		// The operator's own name, and no lookup wrote it.
		await page.fill('input[name="artistName"]', 'Hand Typed');
		await expect(page.locator('#artist-name-lookup-tag')).toHaveCount(0);

		await addNew.click();
		await expect(page.locator(LIVE_REGION)).toHaveText('The new artist form is already open.');
		await expect(page.locator(LIVE_REGION)).not.toContainText('left them alone');
		// The name is the operator's, and the click still wrote nothing.
		await expect(page.locator('input[name="artistName"]')).toHaveValue('Hand Typed');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue('');
	});

	// Weasyl is a site Sona holds no artist column for (SONA-219), so the seed
	// carries a name and never a profile URL. A repeat click answered with the
	// seed-kept line claimed the plural: fields "already have values, so Sona
	// left them alone", with the FurAffinity field empty and never a candidate.
	test('a repeat add-new click on an unlinked site says the form is open, not that it kept fields', async ({
		page
	}) => {
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'Weasyl',
						siteId: '12345',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: '2026-03-04T10:00:00Z',
						rating: 'general',
						postUrl: 'https://www.weasyl.com/~kuttoya/submissions/12345/piece'
					}
				],
				localArtists: [],
				nameMatches: []
			})
		);
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });

		// The first click fills the name and nothing else: there is no link to
		// offer for this site.
		await addNew.click();
		await expect(page.locator('input[name="artistName"]')).toHaveValue('kuttoya');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue('');
		await expect(panel(page)).toContainText("Sona filled the new artist's name.");

		// The name is taken and the link was never on offer, so this click writes
		// nothing. The answer names the form, not fields it never touched.
		await addNew.click();
		await expect(page.locator(LIVE_REGION)).toHaveText('The new artist form is already open.');
		await expect(page.locator(LIVE_REGION)).not.toContainText('left them alone');
		await expect(page.locator('input[name="furaffinity"]')).toHaveValue('');
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
		// Image 3 is published in the seed, so this tick is a real change to carry
		// (or not) across the move.
		await page.locator('input[name="published"]').check();

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
		// The tick is a seed like the rest: the destination image is published, so
		// it reads that image's own state rather than the previous one's.
		await expect(page.locator('input[name="published"]')).not.toBeChecked();
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

	// The dialog is a plain overlay with no focus trap, so the Parent radio
	// behind it stays reachable from the keyboard while it is open. Read back at
	// close, the parent was whichever tile the radio had moved to: the created
	// artist was credited to a result that never named the handle, and the tile
	// that did name it kept offering to add the artist, where the second click
	// creates the duplicate.
	test('folds a created artist into the tile that offered the handle', async ({ page }) => {
		let creates = 0;
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			creates += 1;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 79, name: 'kuttoya' })
			});
		});
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await twoDoneTiles(page);

		// front.png is the parent, so its lookup is the one driving the panel, and
		// the handle on offer is its result's.
		await tileLookup(page).nth(0).click();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();
		await expect(page.locator('#new-artist-name')).toHaveValue('kuttoya');

		// Focus, not a click: the backdrop swallows a pointer, but nothing holds
		// the keyboard inside the dialog, so a few Tabs land here for real.
		await page.getByRole('radio', { name: 'Parent: back.png' }).focus();
		await page.keyboard.press(' ');
		await expect(page.getByRole('radio', { name: 'Parent: back.png' })).toBeChecked();

		await page.getByRole('button', { name: 'Create Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('79');

		// The fold's usual landing spot is the panel's "Using {name}" button, and
		// the panel is showing back.png by now. Focus goes to the tile the handle
		// came from instead of into another tile's result, or on down to <body>
		// (2.4.3).
		expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
		await expect(tileLookup(page).nth(0)).toBeFocused();

		// back.png never ran a lookup, so it has no result for the new artist to
		// be folded into and nothing about it changed.
		await expect(page.getByRole('radio', { name: 'Parent: front.png' })).not.toBeChecked();
		await expect(addNew).toHaveCount(0);

		// front.png's result is where the artist landed: back on it, the panel has
		// moved off the 'new' outcome and there is nothing to click a second time.
		await page.getByRole('radio', { name: 'Parent: front.png' }).check();
		await expect(panel(page)).toBeVisible();
		await expect(addNew).toHaveCount(0);
		await expect(panel(page)).toContainText('kuttoya');
		expect(creates).toBe(1);
	});

	// The same move, with the tile the radio lands on holding a result of its
	// own that names the artist being created. The panel then renders the
	// "Using kuttoya" button the fold reaches for by id — but it belongs to
	// back.png's result, and front.png is where the handle came from, so
	// following the id would drop the operator into an unrelated part of the
	// page (2.4.3).
	test('lands focus on the seed tile when the parent moved onto a matching result', async ({
		page
	}) => {
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 82, name: 'kuttoya' })
			});
		});
		// back.png looks up first and already knows the artist by the id the
		// create returns; front.png's result is the 'new' outcome whose action
		// opens the dialog.
		let calls = 0;
		await page.route('**/api/admin/artist-lookup', (route) => {
			calls += 1;
			const body =
				calls === 1
					? matchedBody({ localArtists: [{ matchIndex: 0, artists: [{ id: 82, name: 'kuttoya' }] }] })
					: matchedBody({ localArtists: [] });
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(body)
			});
		});
		await twoDoneTiles(page);

		// The variant's result stays on its own tile while front.png is parent.
		await tileLookup(page).nth(1).click();
		await expect(page.locator('.tile-result')).toHaveCount(1);

		await tileLookup(page).nth(0).click();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();
		await expect(page.locator('#new-artist-name')).toHaveValue('kuttoya');

		// Focus, not a click: the backdrop swallows a pointer, but the keyboard
		// reaches the radio behind the dialog for real.
		await page.getByRole('radio', { name: 'Parent: back.png' }).focus();
		await page.keyboard.press(' ');
		await expect(page.getByRole('radio', { name: 'Parent: back.png' })).toBeChecked();

		await page.getByRole('button', { name: 'Create Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('82');

		// The id the fold used to follow is on screen, and it is back.png's.
		await expect(panel(page).locator('#lookup-applied-artist')).toBeVisible();
		expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
		await expect(tileLookup(page).nth(0)).toBeFocused();
		// Focus is on a button that says nothing about the artist, and the select
		// that took them is elsewhere, so the live region has to carry the news.
		await expect(page.locator(LIVE_REGION)).toContainText('Using kuttoya as the artist.');
	});

	// Nothing holds the keyboard inside the dialog, so the tile's own "Look up
	// artist" button is reachable behind it and a restart puts that tile back on
	// "searching". The result the dialog was opened from is gone by the time it
	// closes, taking the add-new button the dialog captured as its opener — the
	// same hole as a removed tile, which the create path used to handle only for
	// removal. Focus has to land somewhere, or the next Tab restarts at the top
	// of the admin page (2.4.3).
	test('lands focus on the tile when its lookup restarted behind the dialog', async ({
		page
	}) => {
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 80, name: 'kuttoya' })
			});
		});
		// No local artist behind the handle: the 'new' outcome, whose action opens
		// the dialog.
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await twoDoneTiles(page);

		// front.png is the parent, so the panel is showing its result.
		await tileLookup(page).nth(0).click();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();
		await expect(page.locator('#new-artist-name')).toHaveValue('kuttoya');

		// Registered second, so this one answers the restart; held open, the tile
		// is still on 'searching' when the dialog closes.
		const release = await deferredLookup(page, matchedBody({ localArtists: [] }));
		// Focus and Enter, not a click: the backdrop swallows a pointer, but the
		// keyboard reaches the tile for real.
		await tileLookup(page).nth(0).focus();
		await page.keyboard.press('Enter');
		await expect(tileLookup(page).nth(0)).toHaveAttribute('aria-busy', 'true');
		await expect(addNew).toHaveCount(0);

		await page.getByRole('button', { name: 'Create Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('80');

		// The opener is gone with the result, so this is the landing spot.
		expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
		await expect(tileLookup(page).nth(0)).toBeFocused();

		release();
	});

	// The other way the opener disappears while the dialog is open: the tile the
	// handle came from is removed outright, taking its whole result with it.
	// There is no lookup button left to land on then, so the select holding the
	// artist that was just created is the landing spot (2.4.3).
	test('lands focus on the select when the seed tile is removed behind the dialog', async ({
		page
	}) => {
		await page.route('**/api/artists', (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ id: 81, name: 'kuttoya' })
			});
		});
		await stubLookup(page, matchedBody({ localArtists: [] }));
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		const addNew = panel(page).getByRole('button', { name: 'Add kuttoya as a new artist' });
		await addNew.click();
		await expect(page.locator('#new-artist-name')).toHaveValue('kuttoya');

		// Keyboard, not a click: the backdrop swallows a pointer, and the Remove
		// button behind it is reachable from the keyboard for real.
		await page.getByRole('button', { name: 'Remove front.png' }).focus();
		await page.keyboard.press('Enter');
		await expect(tileLookup(page)).toHaveCount(0);

		await page.getByRole('button', { name: 'Create Artist' }).click();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('81');

		expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
		await expect(page.locator('select[name="artistId"]')).toBeFocused();
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

		// Removing the tile discards the result with it. Each Remove button names
		// its own file, so no nth() is needed to tell them apart.
		await page.getByRole('button', { name: 'Remove back.png' }).click();
		await expect(page.locator('.tile-nsfw-row .rating-tag')).toHaveCount(0);
	});

	// The label field used to be identified by its placeholder alone, which a
	// typed value takes away, so a screen reader had nothing to tell one tile's
	// field from another's. The name has to name the file and survive a value.
	test('the variant label field is named after the file it belongs to', async ({ page }) => {
		await twoDoneTiles(page);

		const label = page.getByRole('textbox', { name: 'Variant label for back.png' });
		await expect(label).toHaveCount(1);
		await label.fill('Transparent BG');
		await expect(page.getByRole('textbox', { name: 'Variant label for back.png' })).toHaveValue(
			'Transparent BG'
		);
		// The parent tile carries no label field, so no second name collides.
		await expect(page.getByRole('textbox', { name: 'Variant label for front.png' })).toHaveCount(0);
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

	// A parent move empties both shared fields, and the new parent's result puts
	// only one of them back. The panel used to reach url_only and call the date
	// "left as it was", over an input the operator had just watched go blank, and
	// the live region said nothing at all because the URL had been written
	// (4.1.3).
	test('a parent move that refills the URL reports the cleared date once', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile's own post: a different one, carrying no date.
		const DATELESS_POST = 'https://www.furaffinity.net/view/54321/';
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '54321',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: null,
						rating: 'general',
						postUrl: DATELESS_POST
					}
				]
			})
		);
		await tileLookup(page).nth(1).click();
		await expect(page.locator('.tile-nsfw-row .rating-tag')).toHaveText(
			'Rated General on FurAffinity'
		);

		await page.locator('input[name="parentPick"]').nth(1).check();

		// The URL is the new parent's, and the date it had no replacement for is
		// gone rather than left pointing at the first tile's post.
		await expect(sourceInput(page)).toHaveValue(DATELESS_POST);
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);

		// The panel says which field went, and never says it was left alone.
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL from the FurAffinity post and cleared the commissioned date the last lookup filled, because that post has no date.'
		);
		await expect(panel(page)).not.toContainText('left the commissioned date as it was');
		// Drawn as a report of what just happened, like the standalone cleared
		// sentence, rather than in the muted colour the advice lines use.
		await expect(
			panel(page).locator('p.lookup-status').filter({ hasText: 'cleared the commissioned date' })
		).toHaveClass(/lookup-emptied/);
		// And the announcer does not say it a second time. The panel's own status
		// region carries that sentence, and the announcement it used to make said
		// only half of what happened — the clearing, never the refill.
		await expect(page.locator(LIVE_REGION)).not.toContainText(
			"Sona cleared the commissioned date the last lookup filled."
		);
	});

	// A parent with no lookup of its own used to draw no sentence at all: the
	// panel under it is idle, and the two fields went blank with nothing on
	// screen saying why (4.1.3). The idle arm draws it now, inside the panel's
	// own status region, so one node both shows the sentence and speaks it.
	test('a parent move onto a tile with no lookup says what it emptied', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await page.locator('input[name="parentPick"]').nth(1).check();

		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expectMovedEmptiedSentence(page);
		// And nothing says it a second time: the page's own live region is the
		// other place this sentence could come from.
		await expect(page.locator(LIVE_REGION)).not.toContainText('the last lookup filled');
	});

	// And starting that tile's own lookup must not say it again. The searching
	// arm renders the same sentence off the same record, and the panel's status
	// region is atomic, so the move would be told a second time — beside the
	// announcement still standing in the live region (4.1.3).
	test('a lookup started on that tile does not repeat what the move emptied', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expectMovedEmptiedSentence(page);

		// The second tile is the parent now and has never been looked up. Held
		// open, so the searching arm is what is on screen.
		const release = await deferredLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();
		await expect(panel(page)).toContainText('Looking up');
		await expect(panel(page)).not.toContainText('the last lookup filled');
		// And nothing was queued into the page's live region behind it either, so
		// the move was never told twice.
		await expect(page.locator(LIVE_REGION)).not.toContainText('the last lookup filled');

		release();

		// The result then fills both fields and the panel says so, the way it does
		// after any other lookup.
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL and commissioned date from the FurAffinity post.'
		);
	});

	// No parent move involved: a plain second lookup on a settled tile. The
	// no-match before it emptied the two fields and the panel said so, and that
	// record has to go at the start of the next search — it describes a lookup
	// that is over, and this one has changed nothing yet. Left standing, the
	// searching arm re-renders the same sentence into the panel's atomic status
	// region and the clearing is spoken a second time (4.1.3).
	test('a repeat lookup does not re-speak what the last result cleared', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// A no-match next, which fills neither field and so empties both.
		await stubLookup(page, { enabled: true, matches: [] });
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one.'
		);
		const spoken = (await page.locator(LIVE_REGION).textContent()) ?? '';

		// Held open, so the searching arm is what is on screen. The tile is
		// settled rather than idle, which is the case the first gate let through.
		const release = await deferredLookup(page, matchedBody());
		await pill(page).click();
		await expect(panel(page)).toContainText('Looking up');
		await expect(panel(page)).not.toContainText('the last lookup filled');
		// And nothing was queued into the live region behind it either.
		await expect(page.locator(LIVE_REGION)).toHaveText(spoken);

		release();

		// The result then refills both fields and the panel reports that, with no
		// clearing left over from the no-match.
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL and commissioned date from the FurAffinity post.'
		);
		await expect(panel(page)).not.toContainText('the last lookup filled');
	});

	// A move onto a tile that is still SEARCHING is NOT that case: the searching
	// arm renders the same sentence, and its region is atomic, so the panel
	// re-speaks whole when the sentence appears in it. The move stays quiet there
	// — an announcement alongside it would be the second telling.
	test('a move onto a searching tile says it once, in the panel and not the live region', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile's own post, on another date, held open across the move.
		const SECOND_POST_URL = 'https://www.furaffinity.net/view/54321/';
		const release = await deferredLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '54321',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: '2026-04-05T10:00:00Z',
						rating: 'general',
						postUrl: SECOND_POST_URL
					}
				]
			})
		);
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		const spoken =
			"Sona cleared the source post URL and commissioned date the last lookup filled.";
		// It is on screen while the search is still out. The searching arm rendered
		// nothing about the fields until the result landed, so a sighted operator
		// watched both go blank with only the progress line to read. The sentence
		// is the reasonless one, word for word: the status line's version blames a
		// lookup that has not answered yet.
		await expect(panel(page)).toContainText('Looking up');
		await expect(panel(page)).toContainText(spoken);
		await expect(panel(page)).not.toContainText('because this lookup filled neither one');
		// And the announcer stays out of it, still holding what the upload left
		// there. The panel's status region is atomic, so rendering that sentence
		// re-speaks the panel whole; a say() alongside would be the same move
		// told twice.
		await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');

		release();

		// The result fills both fields back, and its own sentence is the panel's
		// to say — the announcer never had a line here to be repeated.
		await expect(sourceInput(page)).toHaveValue(SECOND_POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-04-05');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL and commissioned date from the FurAffinity post.'
		);
		await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');
	});

	// The move empties the fields while that tile's own lookup is still out, and
	// the result that lands afterwards calls applyShared again knowing nothing
	// about the move. It used to overwrite the record with one saying nothing was
	// emptied, so the failure showed no cleared sentence over two blank fields.
	test('a move onto a searching tile keeps the cleared sentence when its lookup fails', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		const release = await deferredLookup(
			page,
			{ enabled: true, error: 'rate_limited', forwarded: true },
			429
		);
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		const spoken =
			"Sona cleared the source post URL and commissioned date the last lookup filled.";
		// The searching arm carries it, and the announcer stays quiet beside it,
		// still holding what the upload left there.
		await expect(panel(page)).toContainText(spoken);
		await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');

		release();

		await expect(panel(page)).toContainText('Lookup paused');
		// The failure fills nothing, so what the move emptied is still the whole
		// story about the two fields — and the panel is where it is read now.
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one. You can fill them in before you save.'
		);
		// Said once, by the panel. The announcer never had a line here to repeat.
		await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');
	});

	// The move's record is held until that tile's own result lands, and the
	// operator is free to type into a field it emptied while the search is still
	// out. Unanswered, the flag had the panel report a URL Sona cleared while the
	// operator's own typing sat in the input — and the sentence for a cleared
	// field is chosen before the one that says a field was held, so the typing
	// never got a word in. The record keeps the raw fact that the move emptied
	// the field; their typing is carried alongside it and applied where the
	// sentence speaks about the screen (SONA-220).
	test('a URL typed while the search is out is not reported as cleared', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile's result, held open across the move AND the typing.
		const release = await deferredLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');

		// Typed by hand into the field the move emptied. This URL is the
		// operator's, and no lookup tagged it.
		const TYPED_URL = 'https://www.furaffinity.net/view/999999/';
		await sourceInput(page).fill(TYPED_URL);

		release();

		// The result has a date to fill and nowhere to put its URL, so the typed
		// one stays. The sentence claims the date and says nothing about the URL:
		// the panel speaks for the move as well as the result, and the move blanked
		// that field, so "left the source post URL as it was" would be a false
		// report of a field the operator watched empty (SONA-220).
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(sourceInput(page)).toHaveValue(TYPED_URL);
		await expect(panel(page)).toContainText(
			'Sona filled the commissioned date from the FurAffinity post. You can change it before you save.'
		);
		await expect(panel(page)).not.toContainText('cleared the source post URL');
		await expect(panel(page)).not.toContainText('left the source post URL as it was');
	});

	// The mirror, on the other field.
	test('a date typed while the search is out is not reported as cleared', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		const release = await deferredLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(dateInput(page)).toHaveValue('');

		await dateInput(page).fill('2026-05-06');

		release();

		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		await expect(panel(page)).toContainText(
			'Sona filled the source post URL from the FurAffinity post. You can change it before you save.'
		);
		await expect(panel(page)).not.toContainText('cleared the commissioned date');
		await expect(panel(page)).not.toContainText('left the commissioned date as it was');
	});

	// Cancelling that search means its result is never coming, so the record the
	// move left with it goes too. Held on, the NEXT lookup on the same tile
	// consumed it and reported two fields as just emptied that had been blank
	// since the move.
	test('a cancelled search drops the record the parent move left with it', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		const release = await deferredLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');

		await panel(page).getByRole('button', { name: 'Cancel lookup' }).click();
		release();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'false');

		// A second search on that tile, with nothing to show for it. Both fields
		// have been empty since the move, so this result emptied neither.
		await stubLookup(page, { enabled: true, matches: [] });
		await tileLookup(page).nth(1).click();
		await expect(panel(page)).toContainText('Nothing matched on FurAffinity');
		await expect(panel(page)).not.toContainText('the last lookup filled');
	});

	// The same record, carried through a group-mode round trip instead of a
	// cancel. Dropped only where the parent branch consumes it, the record
	// survived: the flip into the existing-piece mode made the landing result a
	// variant's, the flip back bailed because that tile has no results to
	// re-derive from, and the NEXT lookup on it — parent again — consumed a
	// record several steps old and re-reported a clearing the operator had
	// already been told about (SONA-220).
	test('a group-mode round trip drops the record the parent move left', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile's search is still out when the parent moves onto it, so
		// the move's record is held for the result on its way.
		const release = await deferredLookup(page, { enabled: true, matches: [] });
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		const move =
			"Sona cleared the source post URL and commissioned date the last lookup filled.";
		await expect(panel(page)).toContainText(move);
		await expect(page.locator(LIVE_REGION)).toHaveText('Upload finished.');

		// Into the existing-piece mode while that search is out: no tile is the
		// parent there, so the result lands as a variant tile's.
		await expect(async () => {
			await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		}).toPass({ timeout: 10_000 });
		await expect(page.getByRole('combobox', { name: 'Variant of' })).toBeVisible();
		release();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'false');

		// Back to the new-set mode. The tile's lookup is a no-match, so the
		// re-derivation bails and nothing else looks at the record either.
		await expect(async () => {
			await page.getByRole('radio', { name: 'New piece' }).check();
		}).toPass({ timeout: 10_000 });
		// What the panel says now is true: the move emptied both fields and that
		// no-match put nothing back.
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one.'
		);

		// A second search on that tile, with nothing to show for it either. Both
		// fields have been empty since the move, so THIS result emptied neither
		// and the panel has no clearing left to report.
		const releaseAgain = await deferredLookup(page, { enabled: true, matches: [] });
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');
		releaseAgain();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'false');
		await expect(panel(page)).toContainText('Nothing matched on FurAffinity');
		await expect(panel(page)).not.toContainText('the last lookup filled');
		// And the move's line was not said a second time: it belongs to the panel
		// on this path, and the announcer never carried it.
		await expect(page.locator(LIVE_REGION)).not.toContainText('lookup filled');
	});

	// A move onto a tile whose lookup FAILED empties the fields too: the failure
	// has nothing to put back. That arm carries no status line of its own, so the
	// two fields went blank with the panel talking only about the failure.
	test('a parent move onto a failed tile says what it emptied, above the advice', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await stubLookup(page, { enabled: true, error: 'rate_limited', forwarded: true }, 429);
		await tileLookup(page).nth(1).click();
		await expect(page.locator('.tile-lookup-failed')).toHaveText('Lookup paused');

		await page.locator('input[name="parentPick"]').nth(1).check();

		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		const emptied =
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one. You can fill them in before you save.';
		await expect(panel(page)).toContainText(emptied);
		// Above the "try again in a minute" advice: what happened to the form is
		// read before what to do about the failure.
		const lines = await panel(page).locator('p.lookup-status').allInnerTexts();
		expect(lines.indexOf(emptied)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(emptied)).toBeLessThan(
			lines.findIndex((l) => l.includes('Try again in a minute'))
		);
		// The panel reports it, so the announcer does not repeat it.
		await expect(page.locator(LIVE_REGION)).not.toContainText(
			"Sona cleared the source post URL and commissioned date the last lookup filled."
		);
	});

	// The tile is about 170px wide and the pill's text grows with the number of
	// sites. The consolidated rule's break-word does not shrink an item's
	// min-content width, so a four-site rating pushed the tile — and the document
	// — wider than a phone's viewport (SONA-220).
	test('a four-site rating wraps inside the tile rather than widening the page', async ({
		page
	}) => {
		const sites = ['FurAffinity', 'Weasyl', 'e621', 'Twitter'];
		await stubLookup(
			page,
			matchedBody({
				matches: sites.map((site, i) => ({
					site,
					siteId: `9000${i}`,
					handles: ['kuttoya'],
					distance: 0,
					band: 'exact',
					postedAt: '2026-03-04T10:00:00Z',
					rating: 'adult',
					postUrl: `https://example.invalid/${i}`
				}))
			})
		);
		await twoDoneTiles(page);
		await page.setViewportSize({ width: 390, height: 900 });

		// The variant tile, which is where the tile pill renders.
		await tileLookup(page).nth(1).click();
		const tag = page.locator('.tile-nsfw-row .rating-tag');
		await expect(tag).toHaveText('Rated Adult on FurAffinity, Weasyl, e621, Twitter');
		await expect(tag).toHaveCSS('overflow-wrap', 'anywhere');

		// Inside its own tile, to the pixel.
		const tile = await page.locator('.tile').nth(1).boundingBox();
		const box = await tag.boundingBox();
		if (!tile || !box) throw new Error('the tile or its pill has no box');
		expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width + 1);
		// And the page still does not scroll sideways.
		const overflow = await page.evaluate(() => {
			const el = document.scrollingElement;
			return el ? el.scrollWidth - el.clientWidth : 0;
		});
		expect(overflow).toBeLessThanOrEqual(0);
	});

	// The role used to be snapshotted when the request fired, so a lookup started
	// on the parent and then demoted mid-flight still wrote its post URL and date
	// into the shared fields — under a panel already pointing at the tile the
	// operator had just made the parent, and into a save that would credit that
	// tile with this one's post.
	test('a late result from a demoted tile leaves the shared fields alone', async ({ page }) => {
		await twoDoneTiles(page);
		const release = await deferredLookup(page, matchedBody());

		await tileLookup(page).nth(0).click();
		await expect(tileLookup(page).nth(0)).toHaveAttribute('aria-busy', 'true');

		// The parent moves while the first tile's request is still out.
		await page.locator('input[name="parentPick"]').nth(1).check();
		release();
		await expect(tileLookup(page).nth(0)).toHaveAttribute('aria-busy', 'false');

		// A demoted tile's outcome renders as plain text outside any live region,
		// so this is the only thing that tells a screen-reader operator the lookup
		// they started finished. The whole region is that one message, naming the
		// file it is about: applying it to the shared fields as well would have
		// said the same result twice, under two different names.
		await expect(page.locator(LIVE_REGION)).toHaveText(
			'front.png: kuttoya on FurAffinity, Exact match.'
		);

		// The result landed on the tile that asked for it, as a variant's does.
		await expect(page.locator('.tile-nsfw-row .rating-tag')).toHaveText(
			'Rated General on FurAffinity'
		);
		// And nowhere near the shared fields, which now describe the second tile.
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#shared-rating-tag')).toHaveCount(0);
		await expect(panel(page)).not.toContainText('kuttoya');
	});

	// The other half of the same rule. A result that lands while the group is
	// "a variant of an existing piece" has no shared fields to fill, so coming
	// back to a new set used to show a results panel over empty fields.
	test('returning to a new set re-derives the shared fields from the parent', async ({ page }) => {
		await oneDoneTile(page);
		const release = await deferredLookup(page, matchedBody());

		await pill(page).click();
		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		release();
		// The pill is gone with the group mode; the tile's own button reports the
		// request finishing.
		await expect(tileLookup(page).first()).toHaveAttribute('aria-busy', 'false');
		await expect(sourceInput(page)).toHaveValue('');

		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
		// The panel and its status region are mounted by this same swap, so a
		// region inserted together with its first content is commonly missed: two
		// fields the operator may save were refilled with nothing said.
		await expect(page.locator(LIVE_REGION)).toContainText(
			"Sona filled the shared fields from the parent image's result."
		);

		// And the artist the panel applied is still applied: the reset behind the
		// re-derivation used to relabel the button over a select that still held
		// that artist.
		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();
		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
	});

	// The round trip can refill one field and leave the other blank, and the two
	// halves used to be announced separately: the clearing went out first and the
	// refill overwrote it in the same tick, so the region held "filled the source
	// post URL" and the operator never heard that the date had gone (4.1.3). One
	// sentence now, the panel's own, naming both halves.
	test('returning to a new set names the refill and the clearing in one line', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The same tile, looked up again while no tile is the parent — so the
		// result lands on the tile and not on the shared fields, which keep what
		// the first lookup filled. Its post carries no date.
		const DATELESS_POST = 'https://www.furaffinity.net/view/54321/';
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '54321',
						handles: ['kuttoya'],
						distance: 0,
						band: 'exact',
						postedAt: null,
						rating: 'general',
						postUrl: DATELESS_POST
					}
				]
			})
		);
		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await tileLookup(page).nth(0).click();
		await expect(tileLookup(page).nth(0)).toHaveAttribute('aria-busy', 'false');
		await expect(sourceInput(page)).toHaveValue(POST_URL);

		await page.getByRole('radio', { name: 'New piece' }).check();

		// The re-derivation empties both and puts only the URL back.
		await expect(sourceInput(page)).toHaveValue(DATELESS_POST);
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		// One line, naming both: the field that was filled and the field that was
		// emptied. The panel says the same thing, but its region is mounted by this
		// same mode swap and a region inserted with its first content is missed.
		await expect(page.locator(LIVE_REGION)).toHaveText(
			'Sona filled the source post URL from the FurAffinity post and cleared the commissioned date the last lookup filled, because that post has no date. You can change the URL before you save.'
		);
	});

	// The mixed line is the panel's own sentence, and it used to be picked by
	// hand: a second result that is a DATED clash refills the date and empties the
	// URL, and the hand-picked branch said the result had no link to put there
	// while the panel said the post already belonged to another piece (SONA-220).
	test('returning to a new set names a dated clash the same way the panel does', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// Out of new-piece mode, so this second result lands on the tile rather
		// than on the shared fields. It claims the same post for another piece.
		await stubLookup(page, clashBody(9001, 'Clash Piece'));
		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await tileLookup(page).nth(0).click();
		await expect(tileLookup(page).nth(0)).toHaveAttribute('aria-busy', 'false');

		await page.getByRole('radio', { name: 'New piece' }).check();

		// The clash fills the date and has no URL to offer, so the one the first
		// lookup filled is gone from the form.
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		const sentence =
			'Sona filled the commissioned date from the FurAffinity post and cleared the source post URL the last lookup filled, because the post Sona just found is already the source of Clash Piece. You can change the date before you save.';
		// One sentence, in both places: the panel renders it and the region says
		// it, off the same mapping.
		await expect(panel(page)).toContainText(sentence);
		await expect(page.locator(LIVE_REGION)).toHaveText(sentence);
		// Neither of them calls a field Sona just blanked "left empty", and
		// neither blames a match with no link when Sona found one and declined it.
		await expect(panel(page)).not.toContainText('left the source post URL empty');
		await expect(page.locator(LIVE_REGION)).not.toContainText('no link to put there');
		// The date it filled is not the subject: the field that went blank is, so
		// the line is drawn as a report rather than as advice.
		await expect(
			panel(page)
				.locator('p.lookup-status')
				.filter({ hasText: 'cleared the source post URL the last lookup filled' })
		).toHaveClass(/lookup-emptied/);
	});

	// The refill is announced because it happened. applyShared never overwrites a
	// field the operator typed over, so the same round trip run over two typed
	// fields writes nothing — and used to say Sona had filled them anyway.
	test('returning to a new set says nothing when it refills nothing', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);

		// Typed over, so the tags go and the values are the operator's.
		await sourceInput(page).fill('https://www.furaffinity.net/view/999999/');
		await dateInput(page).fill('2026-05-06');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);

		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');

		// What the operator typed is still there, untagged, and nothing claimed a
		// refill that did not happen.
		await expect(sourceInput(page)).toHaveValue('https://www.furaffinity.net/view/999999/');
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator(LIVE_REGION)).not.toContainText('Sona filled the shared fields');
	});

	// One field typed over, one still the lookup's. The round trip rewrites only
	// the one it cleared, and the plural sentence claimed the operator's own URL
	// had been replaced too.
	test('returning to a new set names the one field it refilled', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// Only the URL is typed over, so only its tag goes.
		await sourceInput(page).fill('https://www.furaffinity.net/view/999999/');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toBeVisible();

		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');

		await expect(sourceInput(page)).toHaveValue('https://www.furaffinity.net/view/999999/');
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator(LIVE_REGION)).toContainText(
			"Sona filled the commissioned date from the parent image's result."
		);
		await expect(page.locator(LIVE_REGION)).not.toContainText('the shared fields');
	});

	// The mirror image, so each of the two singular sentences is pinned to the
	// field it is about rather than to whichever branch ran first.
	test('returning to a new set names the source URL when that is all it refilled', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await pill(page).click();
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await dateInput(page).fill('2026-05-06');
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#source-lookup-tag')).toBeVisible();

		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');

		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-05-06');
		await expect(page.locator(LIVE_REGION)).toContainText(
			"Sona filled the source post URL from the parent image's result."
		);
		await expect(page.locator(LIVE_REGION)).not.toContainText('the shared fields');
	});

	// The same rule from the other end: fields the operator filled BEFORE the
	// lookup are never overwritten either, so the round trip writes nothing.
	test('returning to a new set says nothing over fields filled before the lookup', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);

		await sourceInput(page).fill('https://www.furaffinity.net/view/888888/');
		await dateInput(page).fill('2026-01-02');
		await pill(page).click();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(sourceInput(page)).toHaveValue('https://www.furaffinity.net/view/888888/');

		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');

		await expect(sourceInput(page)).toHaveValue('https://www.furaffinity.net/view/888888/');
		await expect(dateInput(page)).toHaveValue('2026-01-02');
		await expect(page.locator(LIVE_REGION)).not.toContainText('Sona filled the shared fields');
	});

	// And the case where the result itself fills nothing: every match sits in the
	// possible band, so pickPrefillMatch returns null over two empty fields.
	test('returning to a new set says nothing when the result is too weak to fill', async ({
		page
	}) => {
		await stubLookup(
			page,
			matchedBody({
				matches: [
					{
						site: 'FurAffinity',
						siteId: '12345',
						handles: ['kuttoya'],
						distance: 6,
						band: 'possible',
						postedAt: '2026-03-04T10:00:00Z',
						rating: 'general',
						postUrl: POST_URL
					}
				]
			})
		);
		await oneDoneTile(page);

		await pill(page).click();
		await expect(panel(page)).toContainText('kuttoya');
		await expect(sourceInput(page)).toHaveValue('');

		await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		await page.getByRole('radio', { name: 'New piece' }).check();
		await expect(panel(page)).toContainText('kuttoya');

		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator(LIVE_REGION)).not.toContainText('Sona filled the shared fields');
	});

	// Closing the panel puts the tile's lookup back to idle and leaves the fields
	// it filled on screen. The round trip re-derived unconditionally: it cleared
	// both tagged fields, then applied an idle lookup that filled nothing.
	test('a group-mode round trip keeps fields a closed lookup filled', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toBeHidden();

		// Each toggle re-renders the block the radios live in, so a radio can
		// detach between the locator and the click. Retry the check itself, and
		// wait for the mode's own content before asking for the other radio:
		// existing mode brings the parent select with it.
		await expect(async () => {
			await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		}).toPass({ timeout: 10_000 });
		await expect(page.getByRole('combobox', { name: 'Variant of' })).toBeVisible();
		await expect(async () => {
			await page.getByRole('radio', { name: 'New piece' }).check();
		}).toPass({ timeout: 10_000 });
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
	});

	// Close puts the lookup back to idle, and the idle arm draws whatever that
	// lookup emptied. The record left standing, Close left the panel on screen as
	// a bordered card holding that sentence, with no way to dismiss it (SONA-220).
	test('closing a lookup that emptied the fields collapses the panel', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await oneDoneTile(page);
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// A no-match is a result with nothing to prefill, so it empties both fields
		// and the panel says so.
		await stubLookup(page, { enabled: true, matches: [] });
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText(
			'Sona cleared the source post URL and commissioned date the last lookup filled, because this lookup filled neither one.'
		);

		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toBeHidden();
	});

	// Cancel does NOT end that way. The searching arm it ends is the one arm that
	// draws a parent move's record, and the two fields the move emptied are still
	// blank after the cancel: dropping the record collapsed the panel and took
	// the only reason for those blank fields with it (4.1.3). The panel falls to
	// its idle arm holding the sentence, and Close is the way out of it
	// (SONA-220).
	test('cancelling a lookup that emptied the fields keeps the sentence until Close', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The parent moves onto the second tile while its search is still out, so
		// the move empties both fields and the searching arm says so.
		const release = await deferredLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-busy', 'true');

		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		const moved = 'Sona cleared the source post URL and commissioned date the last lookup filled.';
		await expect(panel(page)).toContainText(moved);

		await panel(page).getByRole('button', { name: 'Cancel lookup' }).click();
		release();

		// The idle arm: the sentence still on screen over the two fields it
		// describes, with Close as its one action and nothing left to cancel.
		await expectMovedEmptiedSentence(page);
		await expect(panel(page).getByRole('button', { name: 'Cancel lookup' })).toHaveCount(0);
		const close = panel(page).getByRole('button', { name: 'Close' });
		await expect(close).toBeVisible();
		// And the page's own live region does not say it a second time: the panel's
		// status region is where this sentence lives.
		await expect(page.locator(LIVE_REGION)).not.toContainText('the last lookup filled');

		await close.click();
		await expect(panel(page)).toBeHidden();
		await expect(page.locator('body')).not.toContainText(moved);
	});

	// The other way into that idle card, and the one with no test on it: a parent
	// move onto a tile that was never looked up. No lookup runs, no result lands,
	// so the card the sentence sits in has only its own Close to go by — without
	// one the operator's ways out were typing into a field or starting another
	// lookup (SONA-220).
	test('the idle card a parent move leaves closes on its own Close', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		// The second tile has never been looked up, so the move empties both fields
		// with no result on its way and the idle arm is what says so.
		await page.locator('input[name="parentPick"]').nth(1).check();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expectMovedEmptiedSentence(page);

		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toBeHidden();
		await expect(page.locator('body')).not.toContainText('the last lookup filled');
	});

	// The edit page's two drops, which only source assertions covered: Close and
	// "Add as a variant" both go idle with a record standing, and the idle arm
	// draws it there too (SONA-220).
	test('the edit page collapses the panel on Close too', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);
		await aNoMatchEmptiesWhatTheLastLookupFilled(page);

		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toBeHidden();
	});

	test('the edit page collapses the panel when the clash becomes the parent', async ({ page }) => {
		await stubLookup(page, xMatchBody());
		await gotoEditHydrated(page);

		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(X_POST);

		// The same post, now claimed by another piece: the prefill puts no URL
		// back, so the field the first lookup filled empties and the panel says so.
		await stubLookup(page, { ...xMatchBody(), sourceClash: sourceClash(9001, 'Clash Piece') });
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue('');
		await expect(panel(page)).toContainText('cleared the source post URL the last lookup filled');

		await panel(page).getByRole('button', { name: 'Add as a variant' }).click();
		await expect(page.locator('select[name="parentImageId"]')).toHaveValue('9001');
		await expect(panel(page)).toBeHidden();
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

		await page.getByRole('button', { name: 'Remove first.png' }).click();
		// The button removed itself with its tile, so focus lands on the Remove
		// button of the tile that slid into its place rather than on <body>.
		await expect(page.getByRole('button', { name: 'Remove middle.png' })).toBeFocused();

		await expect(page.getByRole('radio', { name: 'Parent: middle.png' })).toBeChecked();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();
	});

	// Removing the parent tile itself routes through the same pickParent the
	// radio does, so the fields re-derive from the tile the parent pick lands on.
	// The tile that lands there has no lookup of its own, and the panel's idle arm
	// is what says why the two fields just went blank (4.1.3).
	test('removing the parent tile re-derives the fields and says what it emptied', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await page.route('**/api/upload', (route) =>
			route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
		);
		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [
			{ name: 'first.png', type: 'image/png' },
			{ name: 'second.png', type: 'image/png' }
		]);
		await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});

		// The first tile is the parent, and its result fills the shared fields.
		await tileLookup(page).first().click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toBeVisible();

		await page.getByRole('button', { name: 'Remove first.png' }).click();
		await expect(page.getByRole('button', { name: 'Remove first.png' })).toHaveCount(0);

		// The surviving tile is the parent now, and it has no result: the fields
		// describe whatever the parent is, so they empty rather than keep the
		// removed tile's post.
		await expect(sourceInput(page)).toHaveValue('');
		await expect(dateInput(page)).toHaveValue('');
		await expect(page.locator('#source-lookup-tag')).toHaveCount(0);
		await expect(page.locator('#commissioned-lookup-tag')).toHaveCount(0);
		// Said once, and by the panel: its idle arm draws the sentence and its
		// status region speaks it.
		await expectMovedEmptiedSentence(page);
		await expect(page.locator(LIVE_REGION)).not.toContainText('the last lookup filled');
	});

	// In the existing-piece mode no tile is the parent: the panel is not rendered
	// and nothing owns the shared fields, so removing the tile that parentIndex
	// still points at used to re-derive from a tile whose lookup is idle. That
	// cleared the lookup-filled source URL and date that had survived the flip
	// out of the new-set mode and wrote nothing back, erasing them silently.
	test('removing the old parent in existing mode keeps the shared fields', async ({ page }) => {
		await stubLookup(page, matchedBody());
		await page.route('**/api/upload', (route) =>
			route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
		);
		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [
			{ name: 'first.png', type: 'image/png' },
			{ name: 'second.png', type: 'image/png' }
		]);
		await expect(page.locator('input[name="imageUrl_1"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});

		// The first tile is the parent, and its result fills the shared fields.
		await tileLookup(page).first().click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');

		await expect(async () => {
			await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		}).toPass({ timeout: 10_000 });
		await expect(page.getByRole('combobox', { name: 'Variant of' })).toBeVisible();

		await page.getByRole('button', { name: 'Remove first.png' }).click();
		await expect(page.getByRole('button', { name: 'Remove first.png' })).toBeHidden();

		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');

		// And the flip back is unchanged: the surviving tile's lookup is idle, so
		// returnToNewSet leaves the fields alone rather than clearing them.
		await expect(async () => {
			await page.getByRole('radio', { name: 'New piece' }).check();
		}).toPass({ timeout: 10_000 });
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
		await expect(page.locator('#source-lookup-tag')).toHaveText('From lookup');
	});

	// The declined-duplicate path used to drop the tile with a bare array filter,
	// skipping the parent bookkeeping every other removal goes through. With the
	// second tile picked as parent and the first declined, parentIndex stayed at
	// 1 with one tile left: the shared panel went quiet and the save action
	// dereferenced a tile that was no longer there.
	test('a declined duplicate leaves the parent pick pointing at a real tile', async ({ page }) => {
		let releaseFirst = () => {};
		const firstChecked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		// Held until the operator has picked the second tile as the parent, so the
		// decline lands while the group is already two tiles wide.
		await page.route('**/api/check-duplicate', async (route) => {
			const body = route.request().postDataJSON() as { fileName?: string };
			if (body?.fileName !== 'first.png') {
				return route.fulfill({
					contentType: 'application/json',
					body: JSON.stringify({ exists: false })
				});
			}
			await firstChecked;
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({ exists: true })
			});
		});
		await stubLookup(page, matchedBody());
		await page.route('**/api/upload', (route) =>
			route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x1.png' }) })
		);
		// Dismissing the confirm is declining the duplicate.
		page.on('dialog', (dialog) => void dialog.dismiss());

		await page.goto('/admin/upload');
		await waitForDropAttachment(page, '.dropzone');
		await dropOn(page, '.dropzone', [
			{ name: 'first.png', type: 'image/png' },
			{ name: 'second.png', type: 'image/png' }
		]);
		// Both tiles exist from the first render, so the parent can be picked while
		// the first file is still held on its duplicate check. Uploads run one at a
		// time within a batch, so nothing has finished yet.
		const secondRadio = page.getByRole('radio', { name: 'Parent: second.png' });
		await expect(secondRadio).toBeVisible({ timeout: 15_000 });
		await secondRadio.check();

		releaseFirst();

		// One tile left, and it is the one the parent field names. Stale, the index
		// still reads 1 and points past the end of a one-tile group.
		await expect(page.locator('input[name="imageUrl_1"]')).toHaveCount(0);
		await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/x1.png', {
			timeout: 15_000
		});
		await expect(page.locator('input[name="parentIndex"]')).toHaveValue('0');
		// The shared panel still works, which it cannot when parentIndex points
		// past the end: the lookup fills the shared fields from the tile that is
		// actually there. One tile left, so it is the shared pill, not a per-tile
		// button.
		await pill(page).click();
		await expect(sourceInput(page)).toHaveValue(POST_URL);
		await expect(dateInput(page)).toHaveValue('2026-03-04');
	});

	// Same as the edit page's: the option list is a page-load snapshot, and the
	// clash the panel is offering can postdate it.
	test('adds a clash the upload page never loaded as a variant parent anyway', async ({
		page
	}) => {
		await stubLookup(
			page,
			matchedBody({
				sourceClash: {
					imageId: 999,
					title: 'Uploaded In Another Tab',
					isVariant: false,
					parentImageId: null,
					variantCount: 0,
					thumbnailUrl: null,
					artistName: 'Test Artist',
					uploadedAt: '2026-07-09T00:00:00.000Z',
					width: 1200,
					height: 900
				}
			})
		);
		await oneDoneTile(page);

		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await panel(page).getByRole('button', { name: 'Add as a variant' }).click();

		// The panel closed and the group switched to "a variant of an existing
		// piece", so this select is what the save reads the parent from. Found by
		// its accessible name: focus lands here with an option this page never
		// loaded, and a screen reader has to be able to say what field holds it.
		const parent = page.getByRole('combobox', { name: 'Variant of' });
		await expect(parent).toHaveValue('999');
		await expect(parent.locator('option[value="999"]')).toHaveText('Uploaded In Another Tab');
		await expect(page.locator('input[name="existingParentId"]')).toHaveValue('999');
	});

	// The same rule as the edit page's: a second lookup drops a carried option
	// the operator did not choose, and keeps the one they did — dropping that
	// would blank the select and save no parent at all.
	test('a second upload lookup keeps a chosen clash parent and drops an unchosen one', async ({
		page
	}) => {
		await stubLookup(page, clashBody(999, 'Uploaded In Another Tab'));
		await oneDoneTile(page);

		await pill(page).click();
		await panel(page).getByRole('button', { name: 'Add as a variant' }).click();
		const parent = page.getByRole('combobox', { name: 'Variant of' });
		await expect(parent).toHaveValue('999');

		// "Add as a variant" switched the group to an existing piece, which takes
		// the fieldset pill away. Back to a new piece to run the second lookup.
		const backToNew = async () => {
			await page.getByRole('radio', { name: 'New piece' }).check();
			await expect(pill(page)).toBeVisible();
		};
		const backToExisting = async () => {
			await page.getByRole('radio', { name: 'Add as variants of an existing piece' }).check();
		};

		await backToNew();
		await stubLookup(page, clashBody(998, 'Also In Another Tab'));
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await backToExisting();
		await expect(parent).toHaveValue('999');
		await expect(parent.locator('option[value="999"]')).toHaveCount(1);

		// Off the carried option, and the next lookup has no reason to keep it.
		await parent.selectOption('');
		await backToNew();
		await stubLookup(page, matchedBody());
		await pill(page).click();
		await expect(panel(page)).toBeVisible();
		await backToExisting();
		await expect(parent.locator('option[value="999"]')).toHaveCount(0);
		await expect(parent).toHaveValue('');
	});

	// "Using {name}" is about the result on screen. Sparing it in the prefill
	// reset — which every lookup runs — carried it onto the NEXT result, so a
	// second lookup opened already claiming an artist had been applied to it.
	// Only the group-mode round trip, which re-shows the same result, holds it.
	test('a second lookup opens unapplied even when the select still holds that artist', async ({
		page
	}) => {
		await stubLookup(page, matchedBody());
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).click();
		await panel(page).getByRole('button', { name: 'Use Test Artist' }).click();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');

		// Same artist, new result: the select keeps him, the panel does not claim
		// he has been applied to this one.
		await tileLookup(page).nth(0).click();
		await expect(panel(page).getByRole('button', { name: 'Use Test Artist' })).toBeVisible();
		await expect(panel(page).getByRole('button', { name: 'Using Test Artist' })).toHaveCount(0);
		await expect(page.locator('select[name="artistId"]')).toHaveValue('1');

		// And a result naming somebody else offers them unapplied, with no stale
		// "Using" left anywhere in the panel.
		await stubLookup(page, otherArtistBody());
		await tileLookup(page).nth(0).click();
		await expect(panel(page).getByRole('button', { name: 'Use Avatar Artist' })).toBeVisible();
		await expect(panel(page).getByRole('button', { name: /^Using / })).toHaveCount(0);
		// The "Sets the artist to {name}." hint is the edit page's: the upload
		// page never passes editMode, so it renders nowhere here.
		await expect(panel(page)).not.toContainText('Sets the artist to');
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

	// A key removed in another tab comes back as enabled:false on the next
	// lookup. The tile used to call that "Lookup failed · Try again", and the
	// retry met the same missing key every time; then the remedy replaced the
	// button, and because it opens in a new tab the operator who saved a key and
	// came back had nothing left to click. Both controls, now.
	test('a variant tile whose key went away offers Settings beside its retry', async ({ page }) => {
		await stubLookup(page, { enabled: false });
		await twoDoneTiles(page);

		await tileLookup(page).nth(1).focus();
		await tileLookup(page).nth(1).click();

		await expect(page.locator('.tile-lookup-failed')).toHaveText('No key');
		await expect(page.locator('.tile-lookup-reason')).toHaveText(
			'This site no longer has a FuzzySearch key. Add one in Settings, or add the artist by hand.'
		);
		const settings = page.locator('a.tile-settings-link');
		await expect(settings).toHaveAttribute('href', '/admin/settings?tab=connections');
		// A new tab, or following the remedy would throw the batch away — and the
		// name says so out loud, the way every other new-tab link on the admin does.
		await expect(settings).toHaveAttribute('target', '_blank');
		await expect(settings).toHaveAttribute('rel', 'noopener noreferrer');
		await expect(settings).toHaveAccessibleName('Open Settings (opens in a new tab)');
		// The key is read per request, so the tile keeps the retry that picks the
		// lookup back up, and focus stays on the button the operator clicked.
		await expect(tileLookup(page)).toHaveCount(2);
		await expect(tileLookup(page).nth(1)).toContainText('Try again');
		await expect(tileLookup(page).nth(1)).toBeFocused();
		// The reason rides in the button's description, or a screen-reader
		// operator coming back to the tile hears only "Try again for back.png" —
		// and it joins the lookup hint rather than replacing it, so the retry still
		// says out loud that it sends the file to an outside service.
		await expect(tileLookup(page).nth(1)).toHaveAccessibleDescription(
			'No key This site no longer has a FuzzySearch key. Add one in Settings, or add the artist by hand.' +
				" Sona sends each image to FuzzySearch to find who posted it. The parent's result fills the shared fields below; a variant's result only rates that variant."
		);
		// The link beside it repeats none of that: the reason is the line right
		// above it and its own name says where it goes.
		await expect(settings).toHaveAccessibleDescription('');

		// The operator saves a key in that other tab and comes back: the click
		// that was still there runs a lookup that works.
		await stubLookup(page, matchedBody());
		await tileLookup(page).nth(1).click();

		await expect(page.locator('.tile-result')).toHaveCount(1);
		await expect(page.locator('.tile-lookup-failed')).toHaveCount(0);
		await expect(settings).toHaveCount(0);
		await expect(tileLookup(page).nth(1)).toContainText('Looked up');
		await expect(tileLookup(page).nth(1)).toHaveAttribute('aria-describedby', 'lookup-hint');
	});

	// An expired session states itself above the tile's button and keeps it.
	// Settings is not the remedy, and the sign-in happens in another tab — so the
	// tile has to still offer the click that picks the lookup back up. Taking the
	// button away left that tile with no control at all.
	test('a variant tile whose session expired says to sign in again', async ({ page }) => {
		await stubLookup(page, {}, 401);
		await twoDoneTiles(page);

		await tileLookup(page).nth(1).click();

		await expect(page.locator('.tile-lookup-failed')).toHaveText('Signed out');
		await expect(page.locator('.tile-lookup-reason')).toHaveText(
			'Your admin session expired. Sign in again, then look up the artist.'
		);
		// The reason is on those lines, so the button under them is a plain retry.
		await expect(tileLookup(page).nth(1)).toContainText('Try again');
		await expect(tileLookup(page).nth(1)).not.toContainText('Signed out');
		await expect(page.getByRole('link', { name: 'Open Settings' })).toHaveCount(0);
		await expect(tileLookup(page)).toHaveCount(2);
	});

	// The other retryable reason, and the one the label used to wrap on: a paused
	// lookup names itself on the tile's own lines too, so the tile says what the
	// announcement says rather than reading as a dead lookup.
	test('a paused variant tile names the pause and keeps a plain retry', async ({ page }) => {
		await stubLookup(page, { enabled: true, error: 'rate_limited', forwarded: true }, 429);
		await twoDoneTiles(page);

		await tileLookup(page).nth(1).click();

		await expect(page.locator('.tile-lookup-failed')).toHaveText('Lookup paused');
		await expect(page.locator('.tile-lookup-reason')).toHaveText(
			'FuzzySearch is limiting how often your site can search right now.'
		);
		await expect(tileLookup(page).nth(1)).toContainText('Try again');
		await expect(tileLookup(page).nth(1)).not.toContainText('Lookup paused');
		await expect(tileLookup(page)).toHaveCount(2);
	});

	// The parent tile keeps its button whatever the reason: its failure is the
	// shared panel's to report, and that button is where the panel's Close sends
	// focus back to. Swapping it for the tile's own reason line left the close
	// with nothing to focus and dropped focus to the body (2.4.3).
	test('a parent tile whose key went away keeps the button Close returns to', async ({ page }) => {
		await stubLookup(page, { enabled: false });
		await twoDoneTiles(page);

		await tileLookup(page).nth(0).focus();
		await tileLookup(page).nth(0).click();

		// Both tiles still offer a button, and the parent's is untouched by the
		// failure: the panel reports it, so the label neither names the reason nor
		// invites a retry.
		await expect(tileLookup(page)).toHaveCount(2);
		await expect(tileLookup(page).nth(0)).toContainText('Look up artist');
		await expect(tileLookup(page).nth(0)).not.toContainText('No key');
		await expect(tileLookup(page).nth(0)).not.toContainText('Try again');
		// The tile itself says nothing: the panel carries the reason and remedy.
		await expect(page.locator('.tile-lookup-failed')).toHaveCount(0);
		await expect(page.locator('a.tile-settings-link')).toHaveCount(0);
		await expect(panel(page)).toContainText(
			'This site no longer has a FuzzySearch key. Add one in Settings, or add the artist by hand.'
		);
		await expect(panel(page).getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
			'target',
			'_blank'
		);
		await expect(panel(page).getByRole('link', { name: 'Open Settings' })).toHaveAccessibleName(
			'Open Settings (opens in a new tab)'
		);

		await panel(page).getByRole('button', { name: 'Close' }).click();
		await expect(tileLookup(page).nth(0)).toBeFocused();
	});

	// Last: leaves the DB as the seed built it, for whatever runs next on this
	// server. It stays a test rather than becoming a hook, because it also
	// asserts what removal does to the upload page, and a hook failure is silent
	// about which state it left behind. The hook below covers the runs where
	// this test never gets to happen.
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

	// This describe is serial, so one flaky login skips every test after it —
	// including the removal above. The key then survives the run and the next
	// spec on this server sees a connected site: fuzzysearch-key.spec.ts opens
	// with the unconnected state and would fail for a reason that has nothing to
	// do with it. The hook runs whether or not the chain finished, and it says
	// what it did rather than removing the key silently.
	test.afterAll(async ({ browser }) => {
		const page = await browser.newPage();
		try {
			await adminLogin(page, PASSWORD);
			await page.goto('/admin/settings');
			await openConnectionsTab(page);
			// The test above already removed it on a run that got that far.
			if ((await section(page).locator('button.btn-remove').count()) === 0) return;
			console.warn('artist-lookup: the serial chain left the key behind; removing it here');
			await section(page).locator('button.btn-remove').click();
			await page.waitForTimeout(550);
			await section(page)
				.locator('.remove-confirm')
				.getByRole('button', { name: 'Remove', exact: true })
				.click();
			await expect(section(page).locator('input[name="fuzzysearchApiKey"]')).toBeVisible({
				timeout: 15_000
			});
		} finally {
			await page.close();
		}
	});
});
