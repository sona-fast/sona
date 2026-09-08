import { test, expect, type Locator, type Page } from '@playwright/test';
import { gotoAfterLogin, gotoRetrying, loginRetrying } from './admin-login';
import { ENDPOINT, stubSuggestions } from './tag-suggestions-helpers';

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
// The seed (tests/e2e/fixtures/seed.sql) lists 23 untagged images with a post
// URL, ids 101–123, newest first. One page is 20 rows. The total is READ from
// the page rather than pinned at 23: the save tests below take their rows off
// the list, so a retry of this file starts from a shorter one.
const PAGE = 20;
const BSKY_POST = 'https://bsky.app/profile/kirin.example/post/3kq7x2abc';

test.describe.configure({ mode: 'serial' });

/** The image ids the list is showing, newest first. The seeded titles carry
 * the id, which is the only place a row exposes it. */
async function listedIds(page: Page): Promise<number[]> {
	const titles = await page.locator('li.rowcard .rowtitle').allTextContents();
	return titles.map((title) => Number(/Backfill (\d+)/.exec(title)?.[1]));
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
	// The retried click can leave a same-URL navigation still landing, and the
	// re-render that lands with it detaches the tray's buttons under a click that
	// has already resolved its element. Settle the page before the caller acts on
	// the tray.
	await page.waitForLoadState('networkidle');
	return target;
}

/** The row's own save action, so a test can hold it open or answer it. */
const savePost = (url: URL) =>
	url.pathname === '/admin/images/suggest-tags' && url.search.includes('/save');

/** What the action answers when the image is gone: one of the save failures that
 * lands on the generic "couldn't save" sentence rather than on the conflict. */
const SAVE_NOT_FOUND = JSON.stringify({
	type: 'failure',
	status: 404,
	data: '[{"error":1},"not_found"]'
});

/** A row card's content width: what a control that spans the row measures at
 * the phone breakpoint, where .tag-actions stacks and its pill widens to it. */
async function cardContentWidth(target: Locator) {
	return target.evaluate((el) => el.clientWidth
		- parseFloat(getComputedStyle(el).paddingLeft)
		- parseFloat(getComputedStyle(el).paddingRight));
}

/** The rgb() a CSS custom property resolves to in the page, for toHaveCSS. */
async function cssVarColor(page: Page, token: string) {
	return page.evaluate((name) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = `var(${name})`;
		document.body.append(probe);
		const value = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return value;
	}, token);
}

async function openList(page: Page, search = '') {
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, `/admin/images/suggest-tags${search}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Suggest tags' })).toBeVisible();
}

test('Load more grows the list rather than paging away from it', async ({ page, baseURL }) => {
	await openList(page);
	await expect(page.locator('li.rowcard')).toHaveCount(PAGE);
	const showing = page.getByText(/^Showing \d+ of \d+$/);
	await expect(showing).toContainText(`Showing ${PAGE} of `);
	const total = Number(/of (\d+)$/.exec((await showing.textContent()) ?? '')?.[1]);
	expect(total).toBeGreaterThan(PAGE);

	// The placeholder replaces a thumbnail that 404s, which takes a client
	// handler: it standing in for the image is the page saying it has hydrated.
	// Clicking before that is a full page load, and the focus move below is a
	// client behaviour.
	await expect(page.locator('.rowthumb svg').first()).toBeVisible();

	const shownIds = await listedIds(page);
	const last = shownIds[shownIds.length - 1];
	// A row above the fold picks up tags elsewhere before the click. The reloaded
	// list is a row shorter and everything below it moves up, so the row that
	// follows the last one on screen is no longer at the position it was at. On a
	// retry this row is already tagged and the post is refused, which is fine: the
	// assertion below reads the list it actually got.
	await page.request.post('/admin/images/suggest-tags?/save', {
		form: { id: '122', tags: 'backfilled' },
		headers: { origin: baseURL! }
	});

	// A row speaks into the region before the list grows, so the growth sentence
	// below lands on a region a row still has a claim on.
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});
	const spoke = await clickSuggest(page, 'Backfill 121');

	// Activated from the keyboard, which is the path the focus move is for: the
	// ring asserted below only draws when the last interaction was a key press.
	const loadMore = page.getByRole('link', { name: 'Load more' });

	// Stacked at 390px it is the list's one action, so it spans the list and
	// centres its label the way every pill on a row does. Asserted here rather
	// than in the phone test below, which runs after enough saves to take the
	// list under one page, where there is no Load more at all.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(loadMore).toHaveCSS('justify-content', 'center');
	const [pillWidth, cardWidth] = await page.evaluate(() => [
		document.querySelector('.load-more')!.getBoundingClientRect().width,
		document.querySelector('li.rowcard')!.getBoundingClientRect().width
	]);
	expect(Math.abs(pillWidth - cardWidth)).toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 1280, height: 720 });

	await loadMore.focus();
	await loadMore.press('Enter');
	// No Load more left, and the oldest row is listed: the rest of the list is on
	// screen. Not an exact count — a retry of this file starts from a list this
	// test has already taken a row off.
	await expect(page.getByRole('link', { name: 'Load more' })).toHaveCount(0);
	await expect(page.locator('li.rowcard').first()).toContainText('Backfill 123');
	await expect(page.locator('li.rowcard').last()).toContainText('Backfill 101');
	const grown = await listedIds(page);
	expect(grown.length).toBeGreaterThan(PAGE);

	// The link that had focus is gone with the click; focus lands on the row that
	// follows the last one that was on screen, rather than dropping to the top of
	// the document or on whatever now sits at that position.
	const next = grown[grown.indexOf(last) + 1];
	expect(next, 'no row follows the last one that was on screen').toBeTruthy();
	const landed = row(page, `Backfill ${next}`).locator('.rowtitle');
	await expect(landed).toBeFocused();
	// A heading is only focusable because the page put focus on it, so it carries
	// the app's ring like the buttons do — otherwise the focus move is invisible.
	await expect(landed).toHaveCSS('outline-style', 'solid');
	await expect(landed).toHaveCSS('outline-width', '2px');

	// Nothing else says how far the list grew: the link is gone and the hint with
	// it, so the region carries the count.
	const region = page.locator('p.sr-only[role="status"]');
	await expect(region).toHaveText(`Showing ${grown.length} of ${grown.length}`);

	// The list is what spoke last, not the row that spoke before it, so the row's
	// Dismiss has nothing of its own to clear and leaves the count standing.
	await spoke.getByRole('button', { name: 'Dismiss suggestions for Backfill 121' }).click();
	await expect(spoke.locator('.tag-chip')).toHaveCount(0);
	await expect(region).toHaveText(`Showing ${grown.length} of ${grown.length}`);
});

test('a row meta line names the source without an orphaned separator', async ({ page }) => {
	await openList(page);
	// Every seeded row credits Test Artist, so the separator is earned here; an
	// X row says so.
	await expect(row(page, 'Backfill 123').locator('.rowmeta')).toHaveText('Test Artist · X post');
	await expect(row(page, 'Backfill 121').locator('.rowmeta')).toHaveText('Test Artist · Bluesky post');
	// The seeded thumbnails 404 by design, so the row degrades to its placeholder
	// rather than the browser's broken-image glyph.
	await expect(row(page, 'Backfill 123').locator('.rowthumb svg')).toBeVisible();
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
	// The expanded row lines up with the title, not with the card padding. The
	// chips are a child component, so check the rendered box too: a scoped rule
	// that cannot reach the component root would leave the row at the card edge
	// while the eyebrow above it stayed indented.
	await expect(target.locator('.tag-eyebrow')).toHaveCSS('margin-left', '68px');
	// One evaluate, so both rects come from the same frame rather than from
	// either side of a re-render.
	const [eyebrowX, chipRowX] = await target.evaluate((row) => [
		row.querySelector('.tag-eyebrow')!.getBoundingClientRect().x,
		row.querySelector('.tag-chiprow')!.getBoundingClientRect().x
	]);
	expect(chipRowX).toBe(eyebrowX);
	await expect(target.getByText("Sona doesn't change the NSFW setting here.")).toBeVisible();

	const save = target.getByRole('button', { name: /^Save \d+ tags? to Backfill 120$/ });
	await expect(save).toHaveText('Save 4 tags');
	await target.getByRole('button', { name: 'beach' }).click();
	await expect(save).toHaveText('Save 3 tags');
	await expect(chips).toHaveCount(4);

	// With every chip left out Save does nothing, so it stops wearing the row's
	// loudest fill and its pointer cursor: it takes the refused pill's treatment.
	for (const tag of ['mammal', 'canine', 'fox']) {
		await target.getByRole('button', { name: tag }).click();
	}
	await expect(save).toHaveText('Save 0 tags');
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(save).toHaveCSS('cursor', 'default');
	await expect(save).toHaveCSS('background-color', await cssVarColor(page, '--secondary'));

	// And it does nothing rather than merely looking refused: the button is
	// aria-disabled, not disabled, so the click still reaches the form and the
	// submit handler is what cancels it.
	let saveCalls = 0;
	await page.route(savePost, (route) => {
		saveCalls += 1;
		return route.abort();
	});
	// Dispatched rather than clicked: Playwright waits for an aria-disabled
	// control to become enabled, so a real click never lands.
	await save.dispatchEvent('click');
	// The refusal is not silent — the region says what to do first.
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		'Backfill 120. Pick at least one tag to save.'
	);
	expect(saveCalls).toBe(0);

	// Every value the region takes from here on, in order: the second refusal
	// writes the sentence the region already holds, and a text node that never
	// changes is a mutation Playwright cannot poll for after the fact.
	await page.evaluate(() => {
		const region = document.querySelector('p.sr-only[role="status"]');
		const seen: string[] = [];
		(window as unknown as { __regionLog: string[] }).__regionLog = seen;
		new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(region!, {
			childList: true,
			characterData: true,
			subtree: true
		});
	});
	await save.dispatchEvent('click');
	// Blanked between the two identical sentences, so the second one is a change
	// the live region announces rather than a no-op.
	await expect
		.poll(() =>
			page
				.evaluate(() => (window as unknown as { __regionLog: string[] }).__regionLog)
				.then((log) => log.slice(-2))
		)
		.toEqual(['', 'Backfill 120. Pick at least one tag to save.']);
	expect(saveCalls).toBe(0);

	// Nothing left the page and nothing left the tray: every chip is still there
	// to pick from.
	await expect(chips).toHaveCount(4);
	await expect(save).toHaveText('Save 0 tags');
	await page.unroute(savePost);

	// Picked again, so the button goes back to being the row's primary action.
	await target.getByRole('button', { name: 'fox' }).click();
	await expect(save).toHaveAttribute('aria-disabled', 'false');
	await expect(save).toHaveCSS('cursor', 'pointer');

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
	await expect(target.locator('.tag-chip')).toHaveCount(3);
	// The chip has reported itself detached in the instant after the count
	// assertion passes, the way the row's own pill does, so the click and the
	// count the Save label takes from it are retried as a pair. Reading
	// aria-pressed first keeps the retry from toggling the chip back on.
	await expect(async () => {
		const chip = target.getByRole('button', { name: 'window' });
		if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
		await expect(
			target.getByRole('button', { name: 'Save 2 tags to Backfill 119' })
		).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 15_000 });
	await target.getByRole('button', { name: 'Save 2 tags to Backfill 119' }).click();

	const savedLine = target.locator('.tag-status-line');
	await expect(savedLine).toHaveText('Saved 2 tags.');
	await expect(savedLine).toBeFocused();
	// The line carries the count and takes the focus, so the title says nothing
	// about the save on top of it.
	await expect(target.locator('.rowtitle .tag')).toHaveCount(0);
	const statics = target.locator('.tag-chip-static');
	await expect(statics).toHaveCount(2);
	// The labels the chips showed, not the sanitized names the row stored.
	await expect(statics.nth(0)).toHaveText('rain drops');
	await expect(statics.nth(1)).toHaveText('cozy');
	const action = target.getByRole('link', { name: 'Edit image Backfill 119' });
	await expect(action).toHaveAttribute('href', '/admin/images/119/edit');
	// The row's one action, beside static chips wearing the same capsule: its
	// border is what tells them apart, so it is not the chips' resting border.
	const chipBorder = await statics.first().evaluate((el) => getComputedStyle(el).borderTopColor);
	await expect(action).not.toHaveCSS('border-top-color', chipBorder);
	// And it stands off the chip row rather than reading as one more line of it.
	const chipBox = await target.locator('.tag-chiprow').boundingBox();
	const actionBox = await action.boundingBox();
	expect(actionBox!.y - (chipBox!.y + chipBox!.height)).toBeGreaterThan(12);

	// Stacked at 390px it is the row's one action, so it spans the card the way
	// Save did before it: the phone rule for a tray's pill reaches this anchor.
	await page.setViewportSize({ width: 390, height: 844 });
	const phoneBox = (await action.boundingBox())!;
	expect(Math.abs(phoneBox.width - (await cardContentWidth(target)))).toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 1280, height: 720 });

	// The tags are real: the edit form loads them, and the row is off the list.
	await gotoRetrying(page, '/admin/images/119/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('rain-drops, cozy');
	await gotoRetrying(page, '/admin/images/suggest-tags');
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
	// The row's only action, so it takes the pill's border rather than reading as
	// muted text — and an anchor wearing it keeps the button's lack of underline.
	await expect(edit).toHaveClass(/tag-pill/);
	await expect(edit).toHaveCSS('text-decoration-line', 'none');
	await expect(edit).not.toHaveCSS('border-top-width', '0px');
	// And at 390px it spans the card, like every other tray action stacked there.
	await page.setViewportSize({ width: 390, height: 844 });
	const editBox = (await edit.boundingBox())!;
	expect(Math.abs(editBox.width - (await cardContentWidth(target)))).toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 1280, height: 720 });
	// One live region serves twenty rows, so the sentence names its image.
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		'Backfill 118. This image was tagged elsewhere since the list loaded. Open it to edit its tags.'
	);

	// The tag written elsewhere survived.
	await gotoRetrying(page, '/admin/images/118/edit');
	await expect(page.locator('input[name="tags"]')).toHaveValue('elsewhere');
});

test('a save that fails for any other reason says so in the row and the live region', async ({ page }) => {
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
	await page.route(savePost, (route) =>
		route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		})
	);

	await target.getByRole('button', { name: 'Save 1 tag to Backfill 116' }).click();

	// Visible, not only announced: a sighted operator otherwise watches a save
	// button that does nothing and a row where nothing changed.
	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	// And it reads as its own group with the Save below it rather than as one
	// more hint line: a step of air above, on top of the card's paragraph gap.
	await expect(target.locator('.tag-eyebrow.warn')).toHaveCSS('margin-top', '4px');
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"Sona couldn't save those tags. Try again."
	);
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		"Backfill 116. Sona couldn't save those tags. Try again."
	);
	// The chips stay, so the operator can try the same save again.
	await expect(target.locator('.tag-chip')).toHaveCount(1);
	await expect(target.locator('.tag-status-line')).toHaveCount(0);
	// The sentence saying nothing landed is where a keyboard user resumes.
	await expect(target.locator('.tag-panel-body')).toBeFocused();
	// Save is the retry here, so the header's Suggest pill goes while the failure
	// shows: it would throw the chips away rather than save them.
	await expect(target.getByRole('button', { name: 'Suggest tags for Backfill 116' })).toHaveCount(
		0
	);

	// Dismiss puts the row back to where a fresh lookup starts, and the pill with
	// it. The row stops saying the last save failed: left alone, "Not saved" sits
	// above chips that were never saved at all.
	await page.unroute(savePost);
	await target.getByRole('button', { name: 'Dismiss suggestions for Backfill 116' }).click();
	const pill = target.getByRole('button', { name: 'Suggest tags for Backfill 116' });
	await expect(pill).toBeVisible();
	await pill.click();
	await expect(target.getByText('1 suggested tag from entail.dev')).toBeVisible();
	await expect(target.locator('.tag-eyebrow.warn')).toHaveCount(0);
	await expect(target.getByText("Sona couldn't save those tags. Try again.")).toHaveCount(0);
});

test('a second identical failure is announced again, not swallowed as an unchanged region', async ({
	page
}) => {
	// A live region announces a change, so writing the sentence it already holds
	// announces nothing. The second click writes "Saving" first, so the identical
	// failure that follows IS a change and is announced without any blanking —
	// which matters on a list where two rows can save at once, since blanking the
	// shared region would throw away whatever the other row just wrote.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 110');
	await page.route(savePost, (route) =>
		route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		})
	);

	const save = target.getByRole('button', { name: 'Save 1 tag to Backfill 110' });
	await save.click();
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"Sona couldn't save those tags. Try again."
	);

	// Every value the region takes from here on, in order: a text node that never
	// changes is a mutation Playwright cannot poll for after the fact.
	await page.evaluate(() => {
		const region = document.querySelector('p.sr-only[role="status"]');
		const seen: string[] = [];
		(window as unknown as { __regionLog: string[] }).__regionLog = seen;
		new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(region!, {
			childList: true,
			characterData: true,
			subtree: true
		});
	});

	// The failure re-rendered the actions under the button the first click
	// resolved, and clicking that stale element once lost the race. Wait for the
	// button the re-render left resting before clicking it again.
	const retry = target.getByRole('button', { name: 'Save 1 tag to Backfill 110' });
	await expect(retry).not.toHaveAttribute('aria-disabled', 'true');
	await retry.click();
	// The last two entries, not the whole log. The click writes the "Saving"
	// sentence first, so the failure that follows is a change the region
	// announces on its own — and the row leaves it at that rather than blanking,
	// which on a list where two rows can save at once would throw away whatever
	// the other row had just written.
	await expect
		.poll(() =>
			page
				.evaluate(() => (window as unknown as { __regionLog: string[] }).__regionLog)
				.then((log) => log.slice(-2))
		)
		.toEqual([
			'Backfill 110. Saving 1 tag.',
			"Backfill 110. Sona couldn't save those tags. Try again."
		]);
	await page.unroute(savePost);
});

test('dismissing one row leaves the sentence another row just wrote in the region', async ({
	page
}) => {
	// The region serves the whole list, and two rows can be working at once.
	// Dismiss used to blank it whatever it held, so closing one tray swallowed the
	// sentence a row saving beside it had just written.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const saver = await clickSuggest(page, 'Backfill 115');
	const closer = await clickSuggest(page, 'Backfill 117');

	// Held open, so the save is still in flight while the other row is dismissed
	// and its sentence is the one standing in the region.
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(savePost, async (route) => {
		await held;
		await route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		});
	});

	const region = page.locator('p.sr-only[role="status"]');
	await saver.getByRole('button', { name: 'Save 1 tag to Backfill 115' }).click();
	await expect(region).toHaveText('Backfill 115. Saving 1 tag.');

	await closer.getByRole('button', { name: 'Dismiss suggestions for Backfill 117' }).click();
	await expect(closer.locator('.tag-chip')).toHaveCount(0);
	await expect(region).toHaveText('Backfill 115. Saving 1 tag.');

	// And a row that IS the one in the region still clears it on Dismiss: nothing
	// of its own is left to announce once its tray is gone.
	release!();
	await expect(saver.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	await expect(region).toHaveText("Backfill 115. Sona couldn't save those tags. Try again.");
	await saver.getByRole('button', { name: 'Dismiss suggestions for Backfill 115' }).click();
	await expect(region).toHaveText('');
	await page.unroute(savePost);
});

test('a row that only looked tags up still clears the region when it is dismissed', async ({
	page
}) => {
	// The row the region is speaking for is remembered on every announcement, the
	// lookup's included — not only on the save ones. Forget it on the lookup path
	// and a row whose tray came from Suggest alone leaves its sentence standing
	// after Dismiss, with no tray left on screen to explain it.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 121');
	const region = page.locator('p.sr-only[role="status"]');
	await expect(region).toHaveText('Backfill 121. 1 suggested tag from entail.dev');

	await target.getByRole('button', { name: 'Dismiss suggestions for Backfill 121' }).click();
	await expect(target.locator('.tag-chip')).toHaveCount(0);
	await expect(region).toHaveText('');
});

test('Dismiss and the row pill are refused while a save is in flight', async ({ page }) => {
	// Dismissing mid-save used to put the row back to idle, and the failure that
	// landed afterwards then set a notice that only renders inside the suggestion
	// tray — leaving a row with a heading and nothing else, unrecoverable without
	// a reload. The row pill during a save is the same race.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 112');

	// The save is held open, so everything below happens while it is in flight.
	let release: (() => void) | undefined;
	let saveCalls = 0;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(savePost, async (route) => {
		saveCalls += 1;
		await held;
		await route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		});
	});

	// Located by its position in the row, not by its name: the name is part of
	// what is under test here and changes while the save runs.
	const save = target.locator('form.tag-actions button[type="submit"]');
	await expect(save).toHaveAttribute('aria-label', 'Save 1 tag to Backfill 112');
	// Measured before the save starts: the refused state draws a real border, and
	// a border appearing from nothing would widen Dismiss and shove the row.
	const dismiss = target.getByRole('button', { name: 'Dismiss suggestions for Backfill 112' });
	const restBox = await dismiss.boundingBox();
	// Save's own resting box, to check the width hold is let go of once the save
	// answers rather than pinning the button at the "Saving" width for good.
	const saveRestBox = await save.boundingBox();
	// Focused first: Firefox on macOS does not focus a button on mousedown, and
	// what is under test is that the save does not take focus away.
	await save.focus();
	await save.click();

	// aria-disabled, not disabled: a real disabled attribute drops focus to the
	// body for the whole round trip, leaving a keyboard user nowhere.
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(save).toBeFocused();
	// And it reads as refused while it runs, the same as with nothing picked.
	await expect(save).toHaveCSS('cursor', 'default');
	await expect(save).toHaveCSS('background-color', await cssVarColor(page, '--secondary'));
	// The spinner stays: the row is working, not merely refusing.
	await expect(save.locator('.tag-spin')).toBeVisible();
	// And the label says so rather than still offering a count the click already
	// took. The name it reads out keeps the row's title, the way the pill's does.
	await expect(save).toHaveText('Saving');
	await expect(save).toHaveAttribute('aria-label', 'Saving tags for Backfill 112');
	// And the region says what the button is doing, rather than still holding the
	// sentence from before the click.
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		'Backfill 112. Saving 1 tag.'
	);

	await expect(dismiss).toHaveAttribute('aria-disabled', 'true');
	// The refused text button reads as refused the same way Save beside it does —
	// same fill, same label colour, same outline — so the two are one state on a
	// touch screen, where the cursor and the hover say nothing.
	await expect(dismiss).toHaveCSS('cursor', 'default');
	await expect(dismiss).toHaveCSS('background-color', await cssVarColor(page, '--secondary'));
	await expect(dismiss).toHaveCSS('border-top-color', await cssVarColor(page, '--border'));
	const inertLabel = await save.evaluate((el) => getComputedStyle(el).color);
	await expect(dismiss).toHaveCSS('color', inertLabel);
	// And a hover over it holds all of that, rather than brightening the way the
	// enabled button's hover does.
	await dismiss.hover();
	await expect(dismiss).toHaveCSS('color', inertLabel);
	await expect(dismiss).toHaveCSS('background-color', await cssVarColor(page, '--secondary'));
	// The refused border is drawn over the transparent one the rest rule reserves,
	// so Dismiss is the same size mid-save as it was before the click. And Save
	// holds its resting width while its label narrows, so Dismiss does not slide
	// left out from under the pointer that just pressed Save either.
	// Within a pixel: the hold rounds the resting width up to a whole pixel, so
	// Dismiss can end a fraction to the right of where it rested, never left of it
	// and never out from under the pointer. Directional, not an absolute
	// tolerance: rounding the held width DOWN slides Dismiss left by a fraction of
	// a pixel, which a one-pixel window either way would wave through.
	const savingBox = await dismiss.boundingBox();
	expect(Math.abs(savingBox!.width - restBox!.width)).toBeLessThanOrEqual(1);
	expect(Math.abs(savingBox!.height - restBox!.height)).toBeLessThanOrEqual(1);
	expect(savingBox!.x).toBeGreaterThanOrEqual(restBox!.x - 0.01);
	expect(savingBox!.x - restBox!.x).toBeLessThanOrEqual(1);
	const pill = target.getByRole('button', { name: 'Suggest tags for Backfill 112' });
	await expect(pill).toHaveAttribute('aria-disabled', 'true');
	// Dispatched rather than clicked: Playwright waits for an aria-disabled
	// control to become enabled, so a real click never lands. What is under test
	// is that the handlers refuse the event.
	await dismiss.dispatchEvent('click');
	await pill.dispatchEvent('click');
	await save.dispatchEvent('click');
	await expect(target.locator('.tag-chip')).toHaveCount(1);
	await expect(target.locator('.tag-skel-chip')).toHaveCount(0);
	// The second Save never left the page: the submit handler cancelled it.
	expect(saveCalls).toBe(1);
	await expect(save).toBeFocused();

	release!();

	// The failure lands on a row that is still showing its chips, so it has
	// somewhere to say so and something to try again with.
	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"Sona couldn't save those tags. Try again."
	);
	await expect(target.locator('.tag-chip')).toHaveCount(1);
	await expect(save).toHaveAttribute('aria-disabled', 'false');
	// The label goes back to offering the count, so the retry says what it will do.
	await expect(save).toHaveText('Save 1 tag');
	await expect(save).toHaveAttribute('aria-label', 'Save 1 tag to Backfill 112');
	await expect(target.locator('.tag-panel-body')).toBeFocused();
	// And the width hold is let go of with the label, so the button sizes itself
	// to whatever it says next rather than staying pinned at the saving width.
	expect(await save.evaluate((el) => el.style.minWidth)).toBe('');
	const settledBox = await save.boundingBox();
	expect(Math.abs(settledBox!.width - saveRestBox!.width)).toBeLessThanOrEqual(1);
	await page.unroute(savePost);
});

test('a chip turned off mid-save leaves the Saving sentence standing', async ({ page }) => {
	// The chips stay clickable while a save runs, so the row can end up with a
	// save in flight and nothing picked. The refusal that follows a click on Save
	// then has to stay silent: the region is already saying the save is running,
	// and "Pick at least one tag to save." would talk over it about a save that is
	// still going to land.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 109');

	let release: (() => void) | undefined;
	let saveCalls = 0;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(savePost, async (route) => {
		saveCalls += 1;
		await held;
		await route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		});
	});

	const region = page.locator('p.sr-only[role="status"]');
	const save = target.locator('form.tag-actions button[type="submit"]');
	await save.click();
	await expect(save).toHaveText('Saving');
	await expect(region).toHaveText('Backfill 109. Saving 1 tag.');

	// Every value the region takes from here on: the refusal would blank it before
	// writing, and a blank that is written back over is a mutation an assertion on
	// the text alone can run straight past.
	await page.evaluate(() => {
		const live = document.querySelector('p.sr-only[role="status"]');
		const seen: string[] = [];
		(window as unknown as { __regionLog: string[] }).__regionLog = seen;
		new MutationObserver(() => seen.push(live?.textContent ?? '')).observe(live!, {
			childList: true,
			characterData: true,
			subtree: true
		});
	});

	// Nothing picked, with the save still in flight.
	await target.getByRole('button', { name: 'fox' }).click();
	// Dispatched rather than clicked: Playwright waits for an aria-disabled
	// control to become enabled, so a real click never lands.
	await save.dispatchEvent('click');
	// Two frames is longer than the blank-and-rewrite the refusal would take.
	await page.evaluate(
		() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
	);
	expect(
		await page.evaluate(() => (window as unknown as { __regionLog: string[] }).__regionLog)
	).toEqual([]);
	await expect(region).toHaveText('Backfill 109. Saving 1 tag.');
	// And the second click never left the page.
	expect(saveCalls).toBe(1);

	release!();
	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	await page.unroute(savePost);
});

test('a save whose request never lands blames the row, not the page', async ({ page }) => {
	// Offline, or a dropped connection: enhance reports a thrown fetch as an error
	// result with no status. Handing that to applyAction renders the error page
	// over the list and throws away every row's staged chips.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 111');
	await page.route(savePost, (route) => route.abort());

	await target.getByRole('button', { name: 'Save 1 tag to Backfill 111' }).click();

	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"Sona couldn't save those tags. Try again."
	);
	await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
		"Backfill 111. Sona couldn't save those tags. Try again."
	);
	// The list is still the list: no error page, and the chips are still staged.
	await expect(page.getByRole('heading', { level: 1, name: 'Suggest tags' })).toBeVisible();
	await expect(page.locator('li.rowcard').first()).toBeVisible();
	await expect(target.locator('.tag-chip')).toHaveCount(1);
	await page.unroute(savePost);
});

test('a row\'s pill keeps focus and says it is working while the lookup runs', async ({ page }) => {
	// The tray that would hold Try again is the skeleton while the lookup runs, so
	// the pill is the only control left for focus to be on — under a name that
	// says which image is being read.
	await openList(page);
	await page.route(ENDPOINT, () => new Promise<void>(() => {}));

	const target = row(page, 'Backfill 113');
	const pill = target.getByRole('button', { name: 'Suggest tags for Backfill 113' });
	await expect(async () => {
		await pill.click();
		await expect(target.locator('.tag-skel-chip')).toHaveCount(5, { timeout: 1500 });
	}).toPass();

	const working = target.getByRole('button', { name: 'Suggesting tags for Backfill 113' });
	await expect(working).toBeVisible();
	await expect(working).toBeFocused();
	await expect(working).toHaveAttribute('aria-disabled', 'true');
});

test('a save answered with a redirect follows it rather than blaming the save', async ({ page }) => {
	// An expired session answers the action with a redirect to the login page, and
	// a thrown error has its own page. Either way "Couldn't save those tags" would
	// strand the operator on a list that can no longer save anything.
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 115');
	await page.route(
		(url) => url.pathname === '/admin/images/suggest-tags' && url.search.includes('/save'),
		(route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ type: 'redirect', status: 303, location: '/admin/login' })
			})
	);

	await target.getByRole('button', { name: 'Save 1 tag to Backfill 115' }).click();

	// The redirect is followed. This session is still signed in, so the login page
	// sends it on to the image list; what matters is that the list was left.
	await page.waitForURL('**/admin/images');
	await expect(page.getByText("Sona couldn't save those tags. Try again.")).toHaveCount(0);
});

test('the edit page keeps what the operator typed when the sidebar form submits', async ({ page }) => {
	// The reference form calls update(), which invalidates every load. The Tags
	// field, the source URL and the NSFW box are the operator's, not the row's:
	// if they follow `data`, that invalidation reverts them and the next Save
	// writes the reverted values.
	await loginRetrying(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/images/101/edit');

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

test('an expanded row drops its indent on a phone, where the head wraps', async ({ page }) => {
	// The row's expansion lines up with the title, past the thumbnail column. At
	// 390px the head wraps and there is no column to clear, so the indent would
	// leave the tray pushed off the card.
	await page.setViewportSize({ width: 390, height: 844 });
	await openList(page);
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});

	const target = await clickSuggest(page, 'Backfill 114');
	await expect(target.locator('.tag-eyebrow')).toHaveCSS('margin-left', '0px');
	// The chips drop the indent with everything else, rather than sitting alone
	// at the card edge on desktop and alone in from it here.
	await expect(target.locator('.tag-chiprow')).toHaveCSS('margin-left', '0px');
	const [phoneEyebrowX, phoneChipRowX] = await target.evaluate((row) => [
		row.querySelector('.tag-eyebrow')!.getBoundingClientRect().x,
		row.querySelector('.tag-chiprow')!.getBoundingClientRect().x
	]);
	expect(phoneChipRowX).toBe(phoneEyebrowX);

	// Stacked, Save spans the tray and Dismiss sits under it. A phone has no
	// cursor and no hover, so the refused Dismiss keeps the fill the refused
	// controls share on one line and spans the tray with it, rather than leaving
	// a short pill orphaned at the left edge.
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(savePost, async (route) => {
		await held;
		await route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: SAVE_NOT_FOUND
		});
	});
	const save = target.locator('form.tag-actions button[type="submit"]');
	const saveRestBox = await save.boundingBox();
	const dismiss = target.getByRole('button', { name: 'Dismiss suggestions for Backfill 114' });
	const restColor = await dismiss.evaluate((el) => getComputedStyle(el).color);
	const dismissRestBox = await dismiss.boundingBox();
	await save.click();
	await expect(dismiss).toHaveAttribute('aria-disabled', 'true');
	await expect(dismiss).toHaveCSS('background-color', await cssVarColor(page, '--secondary'));
	// One inert row: the refused Dismiss takes the width Save takes here.
	const refusedBox = await dismiss.boundingBox();
	const saveRefusedBox = await save.boundingBox();
	expect(Math.abs(refusedBox!.width - saveRefusedBox!.width)).toBeLessThanOrEqual(1);
	// And it grows rightward from the edge it rested at, so the label the pointer
	// was over does not travel. Directional for the same reason as the one-line
	// case: a fill that leaked left would sit inside a one-pixel window.
	expect(refusedBox!.x).toBeGreaterThanOrEqual(dismissRestBox!.x - 0.01);
	expect(refusedBox!.x - dismissRestBox!.x).toBeLessThanOrEqual(1);
	// And the label darkens, so the refused state is legible without a cursor or
	// a hover to say so.
	const refusedColor = await dismiss.evaluate((el) => getComputedStyle(el).color);
	expect(refusedColor).not.toBe(restColor);

	release!();
	await expect(target.locator('.tag-eyebrow.warn')).toHaveText('Not saved');
	// The width the label narrowing was holding is handed back once the save
	// answers: no inline min-width left on the button, and the box it settles at
	// is the one it rested at before the click.
	expect(await save.evaluate((el) => el.style.minWidth)).toBe('');
	const settledBox = await save.boundingBox();
	expect(Math.abs(settledBox!.width - saveRestBox!.width)).toBeLessThanOrEqual(1);
	await page.unroute(savePost);
});

test('the edit page re-seeds its fields when a client-side navigation swaps the image', async ({ page }) => {
	// The Tags, Source Post URL and NSFW fields are $state seeded from `data`, so
	// an invalidation does not revert what the operator typed. A same-route
	// navigation to a DIFFERENT image is the one case they must follow `data`
	// again — otherwise image A's typed tags are staged onto image B and saved.
	await loginRetrying(page, PASSWORD);

	// What image 102 actually stores, read first: the rows above tag their own
	// images, and the last test in this file tags whatever is left.
	await gotoAfterLogin(page, '/admin/images/102/edit');
	const storedTags = await page.locator('input[name="tags"]').inputValue();
	const storedUrl = await page.locator('input[name="sourcePostUrl"]').inputValue();

	await gotoRetrying(page, '/admin/images/101/edit');
	const tags = page.locator('input[name="tags"]');
	const url = page.locator('input[name="sourcePostUrl"]');
	const pill = page.getByRole('button', { name: 'Suggest tags', exact: true });

	// The pill's enabled state is computed in the browser, so it flipping is proof
	// the page has hydrated and the typing below will not be overwritten by it.
	await url.fill('https://www.furaffinity.net/view/12345/');
	await expect(pill).toHaveAttribute('aria-disabled', 'true');
	await url.fill(BSKY_POST);
	await tags.fill('typed-on-101');
	await expect(pill).toHaveAttribute('aria-disabled', 'false');

	// A tray open on image 101: its chips would otherwise still be there to Add
	// onto image 102 after the navigation below.
	await stubSuggestions(page, 200, {
		source: 'bluesky',
		tags: ['fox'],
		rating: 'safe',
		imageCount: 1
	});
	await pill.click();
	await expect(page.locator('.tag-tray .tag-chip')).toHaveCount(1);

	// A client-side navigation, not page.goto: a full load would re-render from
	// scratch and pass whether or not the fields follow `data`. No in-app link
	// goes edit to edit, so this injects one — SvelteKit intercepts anchor clicks
	// anywhere in the document.
	await page.evaluate(() => {
		const a = document.createElement('a');
		a.href = '/admin/images/102/edit';
		a.id = 'e2e-edit-102';
		a.textContent = 'to 102';
		document.body.appendChild(a);
	});
	await page.locator('#e2e-edit-102').click();
	await page.waitForURL('**/admin/images/102/edit');

	await expect(tags).toHaveValue(storedTags);
	await expect(url).toHaveValue(storedUrl);
	await expect(page.locator('.tag-tray')).toHaveCount(0);
});

test('a failed lookup replaces the row pill with a tray that offers Try again', async ({ page }) => {
	await openList(page);
	await stubSuggestions(page, 502, { error: 'unavailable' });

	const target = await clickSuggest(page, 'Backfill 117');
	await expect(target.getByText('Suggestions unavailable')).toBeVisible();
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"entail.dev didn't answer. Your tags are unchanged."
	);

	// One control per row fires the lookup: the tray's Try again replaces the
	// row's Suggest pill rather than sitting beside it.
	await expect(target.getByRole('button', { name: 'Suggest tags for Backfill 117' })).toHaveCount(0);
	await expect(target.locator('.tag-panel-body')).toBeFocused();

	// Try again is its own action, named as such. The pill comes back while the
	// second lookup runs and takes focus, then the answer's sentence takes it.
	await stubSuggestions(page, 202, { error: 'not_ready' });
	await target.getByRole('button', { name: 'Try again for Backfill 117' }).click();
	await expect(target.getByText('No tags yet')).toBeVisible();
	await expect(target.locator('.tag-panel-body')).toBeFocused();
});

test('a row whose source URL is not a post says so and offers no second try', async ({ page }) => {
	// The forms answer a 422 under the field; a row has no field, so the tray
	// says it. Nothing was sent for that URL — the endpoint refuses it before it
	// asks anyone — so the sentence blames neither entail.dev nor the operator's
	// tags, and there is nothing another click could change.
	await openList(page);
	await stubSuggestions(page, 422, { error: 'unsupported_source' });

	const target = await clickSuggest(page, 'Backfill 117');
	await expect(target.getByText('Suggestions unavailable')).toBeVisible();
	await expect(target.locator('.tag-panel-body')).toHaveText(
		"Sona can't look up this link. Check the source post URL."
	);
	await expect(target.getByRole('button', { name: 'Try again for Backfill 117' })).toHaveCount(0);
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

	await gotoRetrying(page, '/admin/images/suggest-tags');
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

	// One left edge: the body and the button line up with the heading's text, not
	// with the icon beside it. At 390px the head still does not wrap, so the icon
	// stays on the heading's line instead of taking one of its own.
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 844 });
		const heading = await card.locator('.emptytitle').boundingBox();
		const body = await card.locator('.empty-body').boundingBox();
		const back = await card.getByRole('link', { name: 'Back to All Images' }).boundingBox();
		const glyph = await icon.boundingBox();
		expect(Math.round(body!.x), `body edge at ${width}px`).toBe(Math.round(heading!.x));
		expect(Math.round(back!.x), `button edge at ${width}px`).toBe(Math.round(heading!.x));
		expect(glyph!.y, `icon beside the heading at ${width}px`).toBeLessThan(heading!.y + heading!.height);
		expect(glyph!.x, `icon left of the heading at ${width}px`).toBeLessThan(heading!.x);
	}
});
