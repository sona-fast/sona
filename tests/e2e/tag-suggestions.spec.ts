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
// row is ever written. The edit-page test only reads the form and intercepts
// the lookup.

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
const nsfwBox = (page: Page) => page.locator('input[name="nsfw"]');
const markNsfw = (page: Page) => page.getByRole('button', { name: 'Mark it NSFW' });
// The rating note's own live region, beside the checkbox.
const ratingRegion = (page: Page) => page.locator('.tag-check-row p.sr-only[role="status"]');
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

	// The tag names already on the site are a hint line under the field, as they
	// were before this field became a component. A title tooltip would be there
	// for a mouse and nowhere else.
	await expect(page.getByText(/^Existing: /)).toBeVisible();
	await expect(tagsInput(page)).not.toHaveAttribute('title');
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
		'Sona added 3 tags. You can change them in the Tags field.'
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

for (const rating of ['explicit', 'questionable'] as const) {
	test(`a ${rating} rating warns and offers Mark it NSFW, which checks the box and hands it focus`, async ({
		page
	}) => {
		await openUploadForm(page);
		await stubSuggestions(page, 200, { source: 'bluesky', tags: ['fox'], rating, imageCount: 1 });

		await pill(page).click();
		await expect(page.locator('.tag-chip')).toHaveCount(1);

		// The note is warning-coloured and the box is NOT checked: the classifier
		// is a hint, the operator's click is the decision.
		const note = page.locator('.tag-rating-note.warn');
		await expect(note).toHaveText(`Rated ${rating} by entail.dev.`);
		await expect(nsfwBox(page)).not.toBeChecked();
		await expect(markNsfw(page)).toBeVisible();

		await markNsfw(page).click();
		await expect(nsfwBox(page)).toBeChecked();
		// Said as a staged change, not a persisted one: nothing is saved yet.
		await expect(ratingRegion(page)).toHaveText(
			'The NSFW box is now checked. It takes effect when you submit the form.'
		);
		// The button removed itself, so focus lands on the box it checked.
		await expect(markNsfw(page)).toHaveCount(0);
		await expect(nsfwBox(page)).toBeFocused();
		// The note stays, so the operator can still see why.
		await expect(note).toBeVisible();
	});
}

test('a safe rating never offers Mark it NSFW', async ({ page }) => {
	await openUploadForm(page);
	await stubSuggestions(page, 200, { source: 'bluesky', tags: ['fox'], rating: 'safe', imageCount: 1 });

	await pill(page).click();
	await expect(page.getByText('Rated safe by entail.dev')).toBeVisible();
	await expect(page.locator('.tag-rating-note.warn')).toHaveCount(0);
	await expect(markNsfw(page)).toHaveCount(0);
	await expect(nsfwBox(page)).not.toBeChecked();
});

test('the 429, 404 and 502 answers each show their own sentence', async ({ page }) => {
	await openUploadForm(page);

	const cases = [
		{
			status: 429,
			body: 'entail.dev is busy. Wait a minute and try again.',
			retry: true
		},
		{ status: 404, body: "entail.dev couldn't read this post.", retry: false },
		{ status: 502, body: "entail.dev didn't answer. Your tags are unchanged.", retry: true }
	];
	for (const { status, body, retry } of cases) {
		await stubSuggestions(page, status, { error: 'x' });
		await pill(page).click();

		await expect(page.locator('.tag-eyebrow.warn')).toHaveText('Suggestions unavailable');
		await expect(page.locator('.tag-panel-body')).toHaveText(body);
		// Title and body reach the live region as two sentences, not run together.
		await expect(liveRegion(page)).toHaveText(`Suggestions unavailable. ${body}`);
		// 404 is final; the other two are worth another click.
		await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(retry ? 1 : 0);
		await expect(tagsInput(page)).toHaveValue('');

		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect(page.locator('.tag-tray')).toHaveCount(0);
	}
});

test('Try again keeps focus on the pill while the second lookup runs', async ({ page }) => {
	await openUploadForm(page);
	await stubSuggestions(page, 502, { error: 'unavailable' });
	await pill(page).click();
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

	// The second answer never arrives while we look: the tray is the skeleton,
	// the Try again button is gone, and focus is on the pill rather than <body>.
	await page.route(ENDPOINT, () => new Promise<void>(() => {}));
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('button', { name: 'Suggesting tags…' })).toBeFocused();
	await expect(page.locator('.tag-skel-chip')).toHaveCount(5);
});

test('a lookup in flight cannot be dismissed, so no answer can land on a closed tray', async ({
	page
}) => {
	// The component drops an answer that arrives after Dismiss (its request
	// sequence guard), but the UI never gets there: while a lookup runs the tray
	// is the skeleton with no Dismiss, and the pill refuses a second click. This
	// pins that shape, since it is what makes the late-answer case unreachable.
	await openUploadForm(page);
	await page.route(ENDPOINT, () => new Promise<void>(() => {}));

	await pill(page).click();
	await expect(page.locator('.tag-skel-chip')).toHaveCount(5);
	await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Suggesting tags…' })).toHaveAttribute(
		'aria-disabled',
		'true'
	);
	await expect(liveRegion(page)).toHaveText('Reading the Bluesky post');
	await expect(tagsInput(page)).toHaveValue('');
	await expect(markNsfw(page)).toHaveCount(0);
});

test('an image stored as NSFW opens its edit page with the box already checked', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	// Image 4 is seeded nsfw=1. The box reads the stored row, so a classifier
	// rating is the only thing that could ever move it — and it never does.
	await page.goto('/admin/images/4/edit');
	await expect(tagsInput(page)).toBeVisible();
	await expect(nsfwBox(page)).toBeChecked();
	await expect(markNsfw(page)).toHaveCount(0);
});

test('the pill takes the app focus ring and spins while a lookup runs', async ({ page }) => {
	await openUploadForm(page);
	// Tab from the Tags input, so the ring is a keyboard focus, not a click.
	await tagsInput(page).focus();
	await page.keyboard.press('Tab');
	await expect(pill(page)).toBeFocused();
	await expect(pill(page)).toHaveCSS('outline-style', 'solid');
	await expect(pill(page)).toHaveCSS('outline-width', '2px');

	// The config asks every test for reduced motion; this one measures the
	// animation itself, so it opts its own page out.
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	// The answer never arrives, so the spinner stays on screen to be measured.
	await page.route(ENDPOINT, () => new Promise<void>(() => {}));
	await pill(page).click();
	await expect(page.locator('.tag-spin')).toHaveCSS('animation-name', 'tag-spin');
});

test('a reduced-motion preference stops the spinner', async ({ page }) => {
	// Asked for on the page rather than taken from the config: `use.reducedMotion`
	// is not an option this Playwright version applies (its own types do not
	// declare it), so the config's setting reaches no browser.
	await openUploadForm(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.route(ENDPOINT, () => new Promise<void>(() => {}));
	await pill(page).click();
	await expect(page.locator('.tag-spin')).toHaveCSS('animation-name', 'none');
});

test('the edit page looks up the URL in the field, not the stored one', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	// Image 1 is seeded with no source post; the field is what the operator
	// types, and the lookup has to follow it.
	await page.goto('/admin/images/1/edit');
	await expect(tagsInput(page)).toBeVisible();
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'true');

	const bodies: unknown[] = [];
	await page.route(ENDPOINT, (route: Route) => {
		bodies.push(route.request().postDataJSON());
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ source: 'bluesky', tags: ['fox'], rating: 'safe', imageCount: 1 })
		});
	});

	await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
	await pill(page).click();
	await expect(page.locator('.tag-chip')).toHaveCount(1);

	expect(bodies).toEqual([{ sourcePostUrl: BSKY_POST }]);
});
