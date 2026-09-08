import { test, expect, type Page, type Route } from '@playwright/test';
import { adminLogin } from './admin-login';

// The tag backfill list at /admin/images/suggest-tags, end to end (SONA-220).
//
// The endpoint is intercepted, as in tag-suggestions.spec.ts: what is under
// test is the page — that a row's Suggest renders chips, that leaving one out
// changes the Save count, that Save writes the tags and the row says what
// landed, that a row tagged elsewhere refuses to overwrite, and that Load more
// grows the list.
//
// Runs on the upload project's own seeded server (playwright.config.ts): Save
// writes tag rows, and the shared server's DB is read-only by convention. The
// tests run serially and each saves on its own row, because a saved row drops
// off the list on the next load and the Load more test counts the list.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-uploadthing.toml.
const PASSWORD = 'e2e-admin-password';
const ENDPOINT = '**/api/admin/tag-suggestions';

// The seed (tests/e2e/fixtures/seed.sql) lists 23 untagged images with a post
// URL, ids 101–123, newest first. One page is 20 rows. The total is READ from
// the page rather than pinned at 23: the save tests below take their rows off
// the list, so a retry of this file starts from a shorter one.
const PAGE = 20;
const BSKY_POST = 'https://bsky.app/profile/kirin.example/post/3kq7x2abc';

test.describe.configure({ mode: 'serial' });

async function stubSuggestions(page: Page, status: number, body: unknown) {
	await page.route(ENDPOINT, (route: Route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
	);
}

const row = (page: Page, title: string) =>
	page.locator('li.rowcard').filter({ has: page.getByRole('heading', { name: title }) });

// The pill's handler is a client handler: a click that lands before hydration
// is a no-op. Like palette-settings.spec.ts, retry the click until the tray
// answers; once it does the page stays hydrated.
async function clickSuggest(page: Page, title: string) {
	const target = row(page, title);
	await expect(async () => {
		await target.getByRole('button', { name: `Suggest tags for ${title}` }).click();
		await expect(target.locator('.tag-eyebrow')).toBeVisible({ timeout: 1500 });
	}).toPass();
	return target;
}

async function openList(page: Page, search = '') {
	await adminLogin(page, PASSWORD);
	await page.goto(`/admin/images/suggest-tags${search}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Suggest tags' })).toBeVisible();
}

test('Load more grows the list rather than paging away from it', async ({ page }) => {
	await openList(page);
	await expect(page.locator('li.rowcard')).toHaveCount(PAGE);
	const showing = page.getByText(/^Showing \d+ of \d+$/);
	await expect(showing).toContainText(`Showing ${PAGE} of `);
	const total = Number(/of (\d+)$/.exec((await showing.textContent()) ?? '')?.[1]);
	expect(total).toBeGreaterThan(PAGE);

	await page.getByRole('link', { name: 'Load more' }).click();
	await expect(page.locator('li.rowcard')).toHaveCount(total);
	// Every row of the first page is still there, in the same place.
	await expect(page.locator('li.rowcard').first()).toContainText('Backfill 123');
	await expect(page.locator('li.rowcard').last()).toContainText('Backfill 101');
	await expect(page.getByRole('link', { name: 'Load more' })).toHaveCount(0);
});

test('a row meta line names the source without an orphaned separator', async ({ page }) => {
	await openList(page);
	// Every seeded row credits Test Artist, so the separator is earned here; an
	// X row says so.
	await expect(row(page, 'Backfill 123').locator('.rowmeta')).toHaveText('Test Artist · X post');
	await expect(row(page, 'Backfill 121').locator('.rowmeta')).toHaveText('Test Artist · Bluesky post');
	// The seeded thumbnails 404 by design, so the row degrades to its placeholder
	// rather than the browser's broken-image glyph.
	await expect(row(page, 'Backfill 123').locator('.thumb-fallback')).toBeVisible();
});

test("a row's Suggest renders chips, and leaving one out changes the Save count", async ({ page }) => {
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['mammal', 'canine', 'fox', 'beach'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 120');

	await expect(target.getByText('4 suggested tags from entail.dev')).toBeVisible();
	const chips = target.locator('.tag-chip');
	await expect(chips).toHaveCount(4);
	await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
	await expect(target.getByText('Rated safe by entail.dev.')).toBeVisible();
	// The expanded row lines up with the title, not with the card padding.
	await expect(target.locator('.tag-eyebrow')).toHaveCSS('margin-left', '68px');
	await expect(target.getByText("Sona doesn't change the NSFW setting here.")).toBeVisible();

	const save = target.getByRole('button', { name: /^Save \d+ tags? to Backfill 120$/ });
	await expect(save).toHaveText('Save 4 tags');
	await target.getByRole('button', { name: 'beach' }).click();
	await expect(save).toHaveText('Save 3 tags');
	await expect(chips).toHaveCount(4);

	// Dismiss closes the tray and hands focus back to the row's pill.
	await target.getByRole('button', { name: 'Dismiss suggestions for Backfill 120' }).click();
	await expect(chips).toHaveCount(0);
	await expect(target.getByRole('button', { name: 'Suggest tags for Backfill 120' })).toBeFocused();
});

test('Save writes the tags and the row shows the saved line and static chips', async ({ page }) => {
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['rain drops', 'window', 'cozy'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 119');
	await target.getByRole('button', { name: 'window' }).click();
	await target.getByRole('button', { name: 'Save 2 tags to Backfill 119' }).click();

	const savedLine = target.locator('.tag-status-line');
	await expect(savedLine).toHaveText('Saved 2 tags.');
	await expect(savedLine).toBeFocused();
	await expect(target.getByText('Saved', { exact: true })).toBeVisible();
	const statics = target.locator('.tag-chip-static');
	await expect(statics).toHaveCount(2);
	// The labels the chips showed, not the sanitized names the row stored.
	await expect(statics.nth(0)).toHaveText('rain drops');
	await expect(statics.nth(1)).toHaveText('cozy');
	await expect(target.getByRole('link', { name: 'Edit image Backfill 119' })).toHaveAttribute(
		'href',
		'/admin/images/119/edit'
	);

	// The tags are real: the edit form loads them, and the row is off the list.
	await page.goto('/admin/images/119/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('rain-drops, cozy');
	await page.goto('/admin/images/suggest-tags');
	await expect(row(page, 'Backfill 119')).toHaveCount(0);
});

test('a row tagged elsewhere since the list loaded refuses to overwrite', async ({ page, baseURL }) => {
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 118');
	await expect(target.getByRole('button', { name: 'Save 1 tag to Backfill 118' })).toBeVisible();

	// Meanwhile another tab tags the same image — through the same action, with
	// the page's session. SvelteKit checks Origin on form posts.
	const elsewhere = await page.request.post('/admin/images/suggest-tags?/save', {
		form: { id: '118', tags: 'elsewhere' },
		headers: { origin: baseURL! }
	});
	expect(elsewhere.ok()).toBe(true);

	await target.getByRole('button', { name: 'Save 1 tag to Backfill 118' }).click();

	// A label in the eyebrow, the sentence as body text: a full sentence in the
	// eyebrow renders 11px uppercase.
	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	const conflict = target.locator('.tag-panel-body');
	await expect(conflict).toHaveText(
		'This image was tagged elsewhere since the list loaded. Open it to edit its tags.'
	);
	await expect(conflict).toBeFocused();
	await expect(target.locator('.tag-chip')).toHaveCount(0);
	const edit = target.getByRole('link', { name: 'Edit image Backfill 118' });
	await expect(edit).toHaveAttribute('href', '/admin/images/118/edit');
	// An anchor wearing the text-button class reads as one, underline and all.
	await expect(edit).toHaveCSS('text-decoration-line', 'none');
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		'This image was tagged elsewhere since the list loaded. Open it to edit its tags.'
	);

	// The tag written elsewhere survived.
	await page.goto('/admin/images/118/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('elsewhere');
});

test('a save that fails for any other reason says so in the live region', async ({ page }) => {
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 116');

	// The action's failures other than the conflict — a 404 for an image that has
	// gone, a 400 for an id that is not one — all land on the generic sentence.
	// Answering the save with one keeps the assertion on the page rather than on
	// how the action can be provoked, and writes nothing to the row.
	await page.route(
		(url) => url.pathname === '/admin/images/suggest-tags' && url.search.includes('/save'),
		(route) =>
			route.fulfill({
				status: 404,
				contentType: 'application/json',
				body: JSON.stringify({ type: 'failure', status: 404, data: '[{"error":1},"not_found"]' })
			})
	);

	await target.getByRole('button', { name: 'Save 1 tag to Backfill 116' }).click();

	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		"Sona couldn't save those tags. Try again."
	);
	// The chips stay, so the operator can try the same save again.
	await expect(target.locator('.tag-chip')).toHaveCount(1);
	await expect(target.locator('.tag-status-line')).toHaveCount(0);
});

test('the edit page keeps what the operator typed when the sidebar form submits', async ({ page }) => {
	// The reference form calls update(), which invalidates every load. The Tags
	// field, the source URL and the NSFW box are the operator's, not the row's:
	// if they follow `data`, that invalidation reverts them and the next Save
	// writes the reverted values.
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/images/101/edit');

	const tags = page.locator('input[name="tags"]');
	const url = page.locator('input[name="sourcePostUrl"]');
	const nsfw = page.locator('input[name="nsfw"]');
	const pill = page.getByRole('button', { name: 'Suggest tags', exact: true });
	await expect(tags).toBeVisible();

	// The pill's enabled state is computed in the browser from the field, so it
	// flipping is proof the page has hydrated — anything typed before that could
	// still be overwritten by hydration.
	await url.fill('https://www.furaffinity.net/view/12345/');
	await expect(pill).toHaveAttribute('aria-disabled', 'true');

	await url.fill(BSKY_POST);
	await tags.fill('fox, beach');
	await nsfw.check();

	await page.getByRole('button', { name: /reference sheet$/ }).click();
	// The sidebar has answered and re-rendered from fresh load data.
	await expect(page.getByRole('button', { name: 'Clear reference sheet' })).toBeVisible();

	await expect(url).toHaveValue(BSKY_POST);
	await expect(tags).toHaveValue('fox, beach');
	await expect(nsfw).toBeChecked();
});

test('a failed lookup offers Try again, which keeps focus on the row pill', async ({ page }) => {
	await openList(page);
	await stubSuggestions(page, 502, { error: 'unavailable' });

	const target = await clickSuggest(page, 'Backfill 117');
	await expect(target.getByText('Suggestions unavailable')).toBeVisible();
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"entail.dev didn't answer. Your tags are unchanged."
	);

	// Try again is its own action, named as such; the row pill is what keeps
	// focus while the second lookup runs.
	await stubSuggestions(page, 202, { error: 'not_ready' });
	await target.getByRole('button', { name: 'Try again for Backfill 117' }).click();
	await expect(target.getByRole('button', { name: 'Suggest tags for Backfill 117' })).toBeFocused();
	await expect(target.getByText('No tags yet')).toBeVisible();
});

// Last on purpose: it tags every row that is left, so the list the tests above
// count and save into is empty afterwards. Idempotent, so a retry still passes.
test('with nothing left to suggest, the page shows its empty state', async ({ page, baseURL }) => {
	await openList(page, '?pages=99');

	// Tag whatever is still listed, through the page's own action. The seeded
	// titles carry the image id, which is the only place the row exposes it.
	for (const title of await page.locator('li.rowcard .rowtitle').allTextContents()) {
		const id = /Backfill (\d+)/.exec(title)?.[1];
		expect(id, `a row title without an id: ${title}`).toBeTruthy();
		const saved = await page.request.post('/admin/images/suggest-tags?/save', {
			form: { id: id!, tags: 'backfilled' },
			headers: { origin: baseURL! }
		});
		expect(saved.ok()).toBe(true);
	}

	await page.goto('/admin/images/suggest-tags');
	await expect(page.locator('li.rowcard')).toHaveCount(0);

	// The framed empty card, not a bare line: a heading above a row title's size,
	// a muted icon beside it, and the way back.
	const card = page.locator('.rowcard.empty');
	await expect(card.getByRole('heading', { name: 'Nothing to suggest right now' })).toBeVisible();
	await expect(card.locator('.emptytitle')).toHaveCSS('font-size', '18px');
	await expect(card).toContainText('Every image with a Bluesky or X source post already has tags.');
	await expect(card.getByRole('link', { name: 'Back to All Images' })).toBeVisible();

	// The icon carries the same muted ink as the body it sits above, at 20px.
	const icon = card.locator('.empty-icon');
	await expect(icon).toHaveAttribute('width', '20');
	const muted = await card.locator('.empty-body').evaluate((el) => getComputedStyle(el).color);
	await expect(icon).toHaveCSS('color', muted);
});
