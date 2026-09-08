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
// URL, ids 101–123, newest first. One page is 20 rows.
const TOTAL = 23;
const PAGE = 20;

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
	await expect(page.getByText(`Showing ${PAGE} of ${TOTAL}`)).toBeVisible();

	await page.getByRole('link', { name: 'Load more' }).click();
	await expect(page.locator('li.rowcard')).toHaveCount(TOTAL);
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
	await expect(target.getByText('Rated safe by entail.dev')).toBeVisible();
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
		tags: ['rain', 'window', 'cozy'],
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
	await expect(statics.nth(0)).toHaveText('rain');
	await expect(statics.nth(1)).toHaveText('cozy');
	await expect(target.getByRole('link', { name: 'Edit image Backfill 119' })).toHaveAttribute(
		'href',
		'/admin/images/119/edit'
	);

	// The tags are real: the edit form loads them, and the row is off the list.
	await page.goto('/admin/images/119/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('rain, cozy');
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

	const conflict = target.getByText(
		'This image was tagged elsewhere since the list loaded. Open it to edit its tags.'
	);
	await expect(conflict).toBeVisible();
	await expect(conflict).toBeFocused();
	await expect(target.locator('.tag-chip')).toHaveCount(0);
	await expect(target.getByRole('link', { name: 'Edit image Backfill 118' })).toHaveAttribute(
		'href',
		'/admin/images/118/edit'
	);
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		'This image was tagged elsewhere since the list loaded. Open it to edit its tags.'
	);

	// The tag written elsewhere survived.
	await page.goto('/admin/images/118/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('elsewhere');
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
