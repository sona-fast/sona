import { test, expect, type Page, type Route } from '@playwright/test';
import { adminLogin } from './admin-login';

// The "Suggest tags" control on /admin/upload, end to end (SONA-220).
//
// The endpoint is intercepted rather than exercised: POST /api/admin/tag-suggestions
// calls entail.dev and X, and a spec that reached either would be measuring
// somebody else's uptime. What is under test here is what the operator sees —
// which state each status code produces, that chips write into the Tags input,
// what the live region says, and where focus lands afterwards.
//
// Runs on the SHARED read-only DB/server: nothing here submits the form, so no
// row is ever written.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';
const BSKY_POST = 'https://bsky.app/profile/kirin.example/post/3kq7x2abc';

const ENDPOINT = '**/api/admin/tag-suggestions';

/** Answer the lookup with one canned response. */
async function stubSuggestions(page: Page, status: number, body: unknown) {
	await page.route(ENDPOINT, (route: Route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
	);
}

const tagsInput = (page: Page) => page.locator('input[name="tags"]');
const pill = (page: Page) => page.getByRole('button', { name: 'Suggest tags', exact: true });
// The one live region on the field: role=status, visually hidden, written into.
const liveRegion = (page: Page) => page.locator('.field > p.sr-only[role="status"]');

async function openUploadForm(page: Page) {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/upload');
	await expect(tagsInput(page)).toBeVisible();
	// The pill only runs once the source field holds a post URL it recognises.
	await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
}

test('the pill refuses to run until the source URL is a post it recognises', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/upload');

	// aria-disabled rather than disabled: the pill stays reachable by keyboard so
	// the hint explaining what to add is announced with it.
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'true');
	await expect(
		page.getByText('Add a Bluesky or X post as the source URL to get tag suggestions.')
	).toBeVisible();

	await page.fill('input[name="sourcePostUrl"]', 'https://www.furaffinity.net/view/12345/');
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'true');

	await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
	await expect(
		page.getByText('Suggestions come from entail.dev, which reads the source post.')
	).toBeVisible();
});

test('suggested tags render as chips and land in the Tags field when accepted', async ({ page }) => {
	await openUploadForm(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['mammal', 'canine', 'fox', 'beach'],
		rating: 'safe',
		imageCount: 1
	});

	await pill(page).click();

	// Every chip starts kept; the eyebrow counts what came back.
	await expect(page.getByText('4 suggested tags from entail.dev').first()).toBeVisible();
	const chips = page.locator('.tag-chip');
	await expect(chips).toHaveCount(4);
	await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

	// The live region carries the same sentence, so it is announced rather than
	// only drawn.
	await expect(liveRegion(page)).toHaveText('4 suggested tags from entail.dev');

	// Leaving one out drops it from the count on the button but not from the row.
	await page.getByRole('button', { name: 'beach' }).click();
	await expect(page.getByRole('button', { name: 'beach' })).toHaveAttribute('aria-pressed', 'false');
	await expect(chips).toHaveCount(4);

	const add = page.getByRole('button', { name: 'Add 3 tags' });
	await add.click();

	// The accepted tags are in the field, in the classifier's order, and the one
	// left out is not.
	await expect(tagsInput(page)).toHaveValue('mammal, canine, fox');
	await expect(liveRegion(page)).toHaveText(
		'Sona added 3 tags. Change them in the Tags field before you save.'
	);
	// The tray is gone, so focus lands on the line that says what happened rather
	// than dropping to the body.
	const applied = page.locator('.tag-status-line');
	await expect(applied).toBeFocused();
	await expect(page.locator('.tag-chip')).toHaveCount(0);

	// The rating shows beside the checkbox and never moves it.
	await expect(page.getByText('Rated safe by entail.dev')).toBeVisible();
	await expect(page.locator('input[name="nsfw"]')).not.toBeChecked();
});

test('a tag already in the field is not offered again', async ({ page }) => {
	await openUploadForm(page);
	await tagsInput(page).fill('Beach');
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['beach', 'fox'],
		rating: 'safe',
		imageCount: 1
	});

	await pill(page).click();

	// "Beach" and "beach" are the same tag once saved, so only fox is left.
	await expect(page.locator('.tag-chip')).toHaveCount(1);
	await expect(page.getByText('Sona skips tags this image already has.')).toBeVisible();

	await page.getByRole('button', { name: 'Add 1 tag' }).click();
	await expect(tagsInput(page)).toHaveValue('Beach, fox');
});

test('a 202 says the post is not classified yet and offers another try', async ({ page }) => {
	await openUploadForm(page);
	// 202 is inside res.ok. Reading it as a payload would show an empty tray as
	// if entail.dev had answered with nothing.
	await stubSuggestions(page, 202, { error: 'not_ready' });

	await pill(page).click();

	await expect(page.getByText('No tags yet').first()).toBeVisible();
	// Scoped to the tray body: the live region carries the same sentence.
	await expect(page.locator('.tag-panel-body')).toHaveText(
		"entail.dev hasn't read this post yet. Try again in a minute."
	);
	await expect(liveRegion(page)).toContainText("entail.dev hasn't read this post yet");
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	// The field is untouched: a lookup that answered nothing changes nothing.
	await expect(tagsInput(page)).toHaveValue('');

	// Dismiss puts focus back on the pill that opened the tray.
	await page.getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.locator('.tag-tray')).toHaveCount(0);
	await expect(pill(page)).toBeFocused();
});

test('a post with nothing to suggest says so and offers only Dismiss', async ({ page }) => {
	await openUploadForm(page);
	await stubSuggestions(page, 200, { source: 'bluesky', tags: [], rating: null, imageCount: 0 });

	await pill(page).click();

	await expect(page.getByText('No tags to suggest').first()).toBeVisible();
	await expect(page.locator('.tag-panel-body')).toHaveText(
		"entail.dev read the post but found nothing it's confident about."
	);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
	await expect(tagsInput(page)).toHaveValue('');
});
