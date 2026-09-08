import { test, expect, type Page, type Route } from '@playwright/test';
import { adminLogin, gotoAfterLogin } from './admin-login';

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

/** A cold run occasionally bounces back to /admin/login inside adminLogin's
 * own waitForURL, and the test then fails before it has done anything. The
 * login step navigates to the form itself and is idempotent, so it is retried
 * here rather than in the shared helper every other spec depends on. */
async function loginRetrying(page: Page) {
	await expect(async () => {
		await adminLogin(page, PASSWORD);
	}).toPass({ timeout: 60_000 });
}

async function openUploadForm(page: Page) {
	await loginRetrying(page);
	await gotoAfterLogin(page, '/admin/upload');
	await expect(tagsInput(page)).toBeVisible();
	// The pill only runs once the source field holds a post URL it recognises.
	// Retried as a pair: a SvelteKit client navigation landing after the fill
	// swaps the document, which drops the value and leaves the pill refusing —
	// with the fill itself sometimes failing as a detached element first.
	await expect(async () => {
		await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
		await expect(pill(page)).toHaveAttribute('aria-disabled', 'false', { timeout: 2000 });
	}).toPass({ timeout: 15_000 });
}

test('the pill refuses to run until the source URL is a post it recognises', async ({ page }) => {
	await loginRetrying(page);
	await gotoAfterLogin(page, '/admin/upload');

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
	// One image, no tag above the floor: entail.dev did look, so the sentence
	// credits it with the verdict. imageCount 0 is a different sentence below.
	await stubSuggestions(page, 200, { source: 'bluesky', tags: [], rating: null, imageCount: 1 });

	await pill(page).click();

	await expect(page.getByText('No tags to suggest').first()).toBeVisible();
	await expect(page.locator('.tag-panel-body')).toHaveText(
		"entail.dev read the post but found nothing it's confident about."
	);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
	await expect(tagsInput(page)).toHaveValue('');
});

test('a post whose only tag is already typed says the tag was skipped, not that there was none', async ({
	page
}) => {
	await openUploadForm(page);
	await tagsInput(page).fill('fox');
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	await pill(page).click();

	// There is nothing left to offer, but entail.dev did read the post and did
	// come back with a tag, so the tray says what actually happened.
	await expect(page.getByText('No tags to suggest').first()).toBeVisible();
	await expect(page.locator('.tag-panel-body')).toHaveText(
		'entail.dev only returned tags that are already in the Tags field.'
	);
	await expect(liveRegion(page)).toContainText(
		'entail.dev only returned tags that are already in the Tags field.'
	);
	await expect(tagsInput(page)).toHaveValue('fox');
});

test('a tray with no Try again keeps its own sentence when the source URL stops being a post', async ({
	page
}) => {
	// The body only swaps to the no-source sentence where another click could
	// answer differently. Nothing about this tray changes if the URL does: there
	// was nothing left to offer, and no button the missing URL could refuse.
	await openUploadForm(page);
	await tagsInput(page).fill('fox');
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	await pill(page).click();
	await expect(page.locator('.tag-panel-body')).toHaveText(
		'entail.dev only returned tags that are already in the Tags field.'
	);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

	await page.fill('input[name="sourcePostUrl"]', 'not a post at all');
	await expect(page.locator('.tag-panel-body')).toHaveText(
		'entail.dev only returned tags that are already in the Tags field.'
	);
	await expect(page.locator('.tag-eyebrow')).toHaveText('No tags to suggest');
	// And nothing is announced over it either: the sentence the tray drew when
	// the lookup answered is still the one the live region holds.
	await expect(liveRegion(page)).toContainText(
		'entail.dev only returned tags that are already in the Tags field.'
	);
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
			'The NSFW box is now checked. Sona saves the change when you submit the form.'
		);
		// The button removed itself, so focus lands on the box it checked.
		await expect(markNsfw(page)).toHaveCount(0);
		await expect(nsfwBox(page)).toBeFocused();
		// The note stays, so the operator can still see why.
		await expect(note).toBeVisible();
	});
}

test('marking NSFW a second time is announced again, and a fresh lookup clears the region', async ({
	page
}) => {
	// A live region announces a change, so writing the sentence it already holds
	// announces nothing. The operator can untick the box by hand and mark it
	// again, which is the second use the region has to survive.
	await openUploadForm(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'explicit',
		imageCount: 1
	});

	await pill(page).click();
	await markNsfw(page).click();
	await expect(ratingRegion(page)).toHaveText(
		'The NSFW box is now checked. Sona saves the change when you submit the form.'
	);

	// Unticked by hand: the button comes back, and the region still holds the
	// sentence from the first click.
	await nsfwBox(page).uncheck();
	await expect(markNsfw(page)).toBeVisible();

	// Every value the region takes from here on, in order: a text node that never
	// changes is a mutation Playwright cannot poll for after the fact.
	await page.evaluate(() => {
		const region = document.querySelector('.tag-check-row p.sr-only[role="status"]');
		const seen: string[] = [];
		(window as unknown as { __ratingLog: string[] }).__ratingLog = seen;
		new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(region!, {
			childList: true,
			characterData: true,
			subtree: true
		});
	});

	await markNsfw(page).click();
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { __ratingLog: string[] }).__ratingLog))
		.toEqual([
			'',
			'The NSFW box is now checked. Sona saves the change when you submit the form.'
		]);
	await expect(nsfwBox(page)).toBeChecked();

	// A second lookup replaces what the note is about, so the region stops saying
	// the box was checked for the answer before it.
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['kirin'],
		rating: 'safe',
		imageCount: 1
	});
	await pill(page).click();
	await expect(page.getByText('Rated safe by entail.dev')).toBeVisible();
	await expect(ratingRegion(page)).toHaveText('');

	// And when the next lookup returns the rating the last one did. The note
	// clears on the lookup, not on the rating changing value, so two questionable
	// images in a row do not leave the second one holding the first one's
	// sentence.
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['kirin'],
		rating: 'questionable',
		imageCount: 1
	});
	await pill(page).click();
	await nsfwBox(page).uncheck();
	await markNsfw(page).click();
	await expect(ratingRegion(page)).toHaveText(
		'The NSFW box is now checked. Sona saves the change when you submit the form.'
	);
	await pill(page).click();
	await expect(ratingRegion(page)).toHaveText('');
});

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

		// Scoped to the tray, and waited for by its sentence: the previous case's
		// tray is still on the page for the moment it takes this one to render, and
		// a Dismiss clicked on the way out is detached before the click lands.
		const tray = page.locator('.tag-tray');
		await expect(tray.locator('.tag-eyebrow.warn')).toHaveText('Suggestions unavailable');
		await expect(tray.locator('.tag-panel-body')).toHaveText(body);
		// Title and body reach the live region as two sentences, not run together.
		await expect(liveRegion(page)).toHaveText(`Suggestions unavailable. ${body}`);
		// 404 is final; the other two are worth another click.
		await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(retry ? 1 : 0);
		await expect(tagsInput(page)).toHaveValue('');

		await tray.getByRole('button', { name: 'Dismiss' }).click();
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

test('Try again refuses once the source URL is no longer a post it recognises', async ({
	page
}) => {
	// The tray stays open while the operator edits the form, so the URL under it
	// can stop being a post. Try again then refuses like the pill does, rather
	// than sitting there looking clickable and doing nothing.
	await openUploadForm(page);
	await stubSuggestions(page, 502, { error: 'unavailable' });
	await pill(page).click();

	const retry = page.getByRole('button', { name: 'Try again' });
	await expect(retry).toHaveAttribute('aria-disabled', 'false');

	await page.fill('input[name="sourcePostUrl"]', '');
	await expect(retry).toHaveAttribute('aria-disabled', 'true');
	// It points at the hint that now says what a URL has to be.
	const hintId = await retry.getAttribute('aria-describedby');
	await expect(page.locator(`#${hintId}`)).toHaveText(
		'Add a Bluesky or X post as the source URL to get tag suggestions.'
	);
	// And the tray body says why, rather than leaving the outage sentence beside
	// a button the missing URL is what actually stopped. It states the condition
	// instead of repeating the hint that sits a few lines above it. The eyebrow
	// still names the failure that opened the tray.
	await expect(page.locator('.tag-panel-body')).toHaveText(
		"There's no post at the source post URL to try again with."
	);
	await expect(page.locator('.tag-eyebrow')).toHaveText('Suggestions unavailable');

	// A dispatched click asks nothing and says nothing.
	let asked = 0;
	await page.route(ENDPOINT, (route: Route) => {
		asked += 1;
		return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
	});
	await retry.dispatchEvent('click');
	await expect(page.locator('.tag-eyebrow')).toHaveText('Suggestions unavailable');
	expect(asked).toBe(0);
	// The body swapped when the URL stopped being a post, and a screen reader
	// gets nothing from a swap it cannot see: the sentence the body now draws is
	// written into the live region as the URL goes.
	await expect(liveRegion(page)).toHaveText("There's no post at the source post URL to try again with.");

	// Retyping a post and clearing it again is the same state entered a second
	// time, and a screen reader has to hear it a second time. The region holds
	// the sentence already, so an assertion on its text cannot tell a fresh
	// announcement from the old one: every value it takes is logged instead.
	await page.evaluate(() => {
		const region = document.querySelector('.field > p.sr-only[role="status"]');
		const seen: string[] = [];
		(window as unknown as { __tagLog: string[] }).__tagLog = seen;
		new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(region!, {
			childList: true,
			characterData: true,
			subtree: true
		});
	});
	await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
	await expect(retry).toHaveAttribute('aria-disabled', 'false');
	await page.fill('input[name="sourcePostUrl"]', '');
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { __tagLog: string[] }).__tagLog))
		.toEqual(['', "There's no post at the source post URL to try again with."]);
});

test('the tray action spans the tray on a phone, like the pill above it', async ({ page }) => {
	// Stacked at 390px the field's own Suggest tags pill spans the column, and
	// Save spans the tray on the backfill page. A Try again left at its intrinsic
	// width reads as an aside rather than as the tray's action.
	await page.setViewportSize({ width: 390, height: 844 });
	await openUploadForm(page);
	await stubSuggestions(page, 502, { error: 'unavailable' });
	await pill(page).click();

	const retry = page.getByRole('button', { name: 'Try again' });
	const box = (await retry.boundingBox())!;
	// The tray's content box: its own width less the border and padding it draws.
	const content = await page.locator('.tag-tray').evaluate((el) => el.clientWidth
		- parseFloat(getComputedStyle(el).paddingLeft)
		- parseFloat(getComputedStyle(el).paddingRight));
	expect(Math.abs(box.width - content)).toBeLessThanOrEqual(1);
});

test('the Sign in link spans the tray on a phone, like Try again in its place', async ({ page }) => {
	// A dead session draws an anchor where Try again would be, and the two are
	// the same control to the operator. An anchor left at its intrinsic width
	// would be the one tray action that reads as an aside.
	await page.setViewportSize({ width: 390, height: 844 });
	await openUploadForm(page);
	await stubSuggestions(page, 401, { error: 'unauthorized' });
	await pill(page).click();

	const signIn = page.getByRole('link', { name: 'Sign in' });
	await expect(signIn).toHaveAttribute('href', '/admin/login');
	const box = (await signIn.boundingBox())!;
	const content = await page.locator('.tag-tray').evaluate((el) => el.clientWidth
		- parseFloat(getComputedStyle(el).paddingLeft)
		- parseFloat(getComputedStyle(el).paddingRight));
	expect(Math.abs(box.width - content)).toBeLessThanOrEqual(1);
});

test('a 422 answers in the hint rather than the tray', async ({ page }) => {
	// The endpoint could not read a post at the link. There is no tray for that:
	// the hint under the field says so, and the pill stays clickable, since the
	// operator can edit the URL and ask again.
	await openUploadForm(page);
	await stubSuggestions(page, 422, { error: 'unsupported_source' });

	await pill(page).click();
	await expect(page.locator('.tag-tray')).toHaveCount(0);
	// The field holds a link the client recogniser accepted, so the hint names
	// that link rather than asking for a URL that is already there.
	await expect(page.locator('#tags-hint')).toHaveText(
		"Sona can't look up this link. Check the source post URL."
	);
	await expect(liveRegion(page)).toHaveText(
		"Sona can't look up this link. Check the source post URL."
	);
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
	// The refused URL lives in another field. A screen reader user who tabs to
	// it finds the refusal on it, rather than only under the Tags field.
	await expect(page.locator('input[name="sourcePostUrl"]')).toHaveAttribute(
		'aria-describedby',
		'tags-hint'
	);
	// And it is drawn as a warning, like the same sentence in the tray, rather
	// than in the note colour the "Existing:" line under it uses.
	const warn = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--status-warn)';
		document.body.append(probe);
		const value = getComputedStyle(probe).color;
		probe.remove();
		return value;
	});
	await expect(page.locator('#tags-hint')).toHaveCSS('color', warn);

	// Clear the field and the refusal is the operator's to fix again, so the
	// hint goes back to saying what a URL has to be.
	await page.fill('input[name="sourcePostUrl"]', '');
	await expect(page.locator('#tags-hint')).toHaveText(
		'Add a Bluesky or X post as the source URL to get tag suggestions.'
	);
	// The live region goes with it. Left holding the refusal, it would be the
	// field's last word to a screen reader about a link that is no longer there.
	await expect(liveRegion(page)).toHaveText('');

	// And a different post gets the ordinary hint back, not the refusal the
	// previous URL earned: the answer was about the link that was in the field.
	await page.fill('input[name="sourcePostUrl"]', BSKY_POST);
	// The upload form's hint carries its multi-tile clause too; what matters is
	// that the sentence is the ordinary one again.
	await expect(page.locator('#tags-hint')).toContainText(
		'Suggestions come from entail.dev, which reads the source post.'
	);
	await expect(page.locator('#tags-hint')).not.toHaveClass(/warn/);
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
	// The description goes with the refusal: the field is no longer being
	// refused, so it no longer points at the hint.
	await expect(page.locator('input[name="sourcePostUrl"]')).not.toHaveAttribute(
		'aria-describedby',
		'tags-hint'
	);
});

test('a tray that opens over an already-cleared URL says so, in the body and out loud', async ({
	page
}) => {
	// The failure lands on a field that no longer holds a post, so the tray opens
	// straight into the no-post state: nothing about the URL changed while the
	// tray was up, so a sentence announced only on that transition would leave a
	// screen reader with the "Reading the Bluesky post" line as the last word.
	await openUploadForm(page);
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(ENDPOINT, async (route: Route) => {
		await held;
		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'unavailable' })
		});
	});

	await pill(page).click();
	await expect(page.locator('.tag-spin')).toBeVisible();
	await page.fill('input[name="sourcePostUrl"]', '');
	release();

	await expect(page.locator('.tag-eyebrow')).toHaveText('Suggestions unavailable');
	await expect(page.locator('.tag-panel-body')).toHaveText(
		"There's no post at the source post URL to try again with."
	);
	await expect(liveRegion(page)).toHaveText(
		"There's no post at the source post URL to try again with."
	);
});

test('a 422 that lands after the URL has been edited is dropped, not shown', async ({ page }) => {
	// The refusal is about the link the lookup went out with. By the time it
	// lands the field holds a different post, and the reset that follows an edit
	// has already run — so showing it would leave the hint refusing a link the
	// operator cannot see.
	await openUploadForm(page);
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(ENDPOINT, async (route: Route) => {
		await held;
		await route.fulfill({
			status: 422,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'unsupported_source' })
		});
	});

	await pill(page).click();
	await expect(page.locator('.tag-spin')).toBeVisible();
	await page.fill(
		'input[name="sourcePostUrl"]',
		'https://bsky.app/profile/kirin.example/post/3kq7x2def'
	);
	release();

	// Back to idle: the ordinary hint, nothing announced, and a pill that runs.
	await expect(page.locator('.tag-spin')).toHaveCount(0);
	await expect(page.locator('#tags-hint')).toContainText(
		'Suggestions come from entail.dev, which reads the source post.'
	);
	await expect(liveRegion(page)).toHaveText('');
	await expect(page.locator('input[name="sourcePostUrl"]')).not.toHaveAttribute(
		'aria-describedby',
		'tags-hint'
	);
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
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
	await loginRetrying(page);
	// Image 4 is seeded nsfw=1. The box reads the stored row, so a classifier
	// rating is the only thing that could ever move it — and it never does.
	await gotoAfterLogin(page, '/admin/images/4/edit');
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

test('a post with no picture says so rather than blaming the classifier', async ({ page }) => {
	// An X post that is text, video or a GIF: the endpoint answers 200 with no
	// tags and imageCount 0 without asking entail.dev anything, so the tray must
	// not say entail.dev read the post and was unconvinced.
	await loginRetrying(page);
	await gotoAfterLogin(page, '/admin/images/1/edit');
	await expect(tagsInput(page)).toBeVisible();
	await stubSuggestions(page, 200, { source: 'x', tags: [], rating: null, imageCount: 0 });

	await page.fill('input[name="sourcePostUrl"]', 'https://x.com/kirin/status/1789012345678901234');
	await expect(pill(page)).toHaveAttribute('aria-disabled', 'false');
	await pill(page).click();

	await expect(page.locator('.tag-eyebrow')).toHaveText('No tags to suggest');
	await expect(page.locator('.tag-panel-body')).toHaveText(
		'That post has no picture for entail.dev to look at.'
	);
	await expect(liveRegion(page)).toContainText(
		'That post has no picture for entail.dev to look at.'
	);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('the edit page looks up the URL in the field, not the stored one', async ({ page }) => {
	await loginRetrying(page);
	// Image 1 is seeded with no source post; the field is what the operator
	// types, and the lookup has to follow it.
	await gotoAfterLogin(page, '/admin/images/1/edit');
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
