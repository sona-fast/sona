import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, loginRetrying, waitForHydration } from './admin-login';
import { settledShot } from './settled-shot';
import { failOnPageErrors } from './page-errors';
import { contrastRatio } from './contrast';

// The commission ledger saved through the real form (SONA-236 PR 2): create an
// entry, move it to Delivered, refuse an out-of-date save from a second tab and
// bring the typed note back, then delete it. Its own writable server (the
// 'commissions' project in playwright.config.ts), where E2E_COMMISSION_GATE
// opens the early-access gate. The tests run in order on one ledger. Each step
// saves a screenshot under test-results.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

failOnPageErrors();
const TITLE = 'E2E ref sheet';

test.describe.configure({ mode: 'serial' });

/** A fresh document that has hydrated, so the status select and use:enhance
 * are attached before the test touches them. */
async function open(page: Page, url: string) {
	await gotoAfterLogin(page, url);
	await waitForHydration(page);
}

// The visible line, not the announcer's copy of it outside the form.
const draftNote = (page: Page) => page.locator('form.entry-form').getByText('Your draft is back.');

const section = (page: Page, heading: 'Active' | 'Finished') =>
	page.locator('section', { has: page.getByRole('heading', { level: 2, name: heading }) });

test('creates an entry that lists under Active', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');

	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(TITLE);
	await page.locator('label.char-chip', { hasText: 'Taro' }).click();
	await page.locator('label.char-chip', { hasText: 'Thistle' }).click();
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await page.getByLabel('Amount').fill('120.00');
	await page.getByLabel('Requested').fill('2026-10-02');

	// Hold the save so a second click and an Enter land while it's in flight.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let posts = 0;
	const createPost = (url: URL) => url.pathname === '/admin/commissions/new';
	await page.route(
		createPost,
		async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posts += 1;
			await held;
			await route.continue();
		}
	);
	const save = page.locator('form.entry-form button[type="submit"]');
	await save.click();
	await expect(save).toHaveAttribute('aria-disabled', 'true');
	await expect(save).toBeFocused();
	await save.click({ force: true });
	await page.keyboard.press('Enter');
	await expect(save).toBeFocused();
	expect(posts).toBe(1);
	release();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	expect(posts).toBe(1);
	await page.unroute(createPost);
	// One save, one entry.
	await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toHaveCount(1);
	const row = section(page, 'Active').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Test Artist');
	await expect(row).toContainText('Taro, Thistle');
	await expect(row).toContainText('Applied');
	await expect(row).toContainText('Unpaid');
	await expect(section(page, 'Finished')).toContainText('Entries you mark Delivered, Not picked, or Canceled move here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-created.png'));

	// At tablet width the section is under the 760px the seven columns need, so
	// each row becomes a card: no header row, and the row lays out as a block.
	await page.setViewportSize({ width: 744, height: 1024 });
	await expect(section(page, 'Active').locator('thead')).toBeHidden();
	await expect(row).toHaveCSS('display', 'block');
	await settledShot(page, testInfo.outputPath('commission-ledger-cards-744.png'));
});

/** Pastes `value` into `input` the way a browser reports a paste. */
async function paste(input: ReturnType<Page['getByLabel']>, value: string) {
	await input.evaluate((el, v) => {
		const field = el as HTMLInputElement;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, v);
		field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: v }));
	}, value);
}

/** Counts the lookup requests the page sends, and keeps what each sent so a
 * failure says which link went out. */
function countLookups(page: Page) {
	const seen = { count: 0, sent: [] as string[] };
	page.on('request', (r) => {
		if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/admin/artist-from-link') return;
		seen.count += 1;
		seen.sent.push(r.postData() ?? '');
	});
	return seen;
}

// Paste a link (SONA-236 PR 4), on New entry. Nothing here saves an entry.
// fixtures/commissions.sql gives Test Artist (1) twitter.com/E2E_Artist, adds
// name_only_artist (50) with no links, and Twin One (51) and Twin Two (52)
// sharing twin_artist.
test('a pasted link picks the artist it names, or says why it can\'t', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const link = page.getByLabel('Link to where you asked');
	const artist = page.getByLabel('Artist', { exact: true });
	const card = page.locator('.lookup');
	await expect(artist).toHaveValue('');
	// A fresh form brought nothing back.
	await expect(draftNote(page)).toHaveCount(0);

	// No artist chosen yet: the one artist with the handle is picked. Their
	// stored link is twitter.com in another letter case.
	await paste(link, 'https://x.com/e2e_artist/status/1843920577201');
	await expect(card.getByText('e2e_artist is already in your artist list as Test Artist.')).toBeVisible();
	await expect(artist).toHaveValue('1');
	await expect(card.getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
	const liveRegion = page.locator('[aria-live="polite"]');
	await expect(
		liveRegion.filter({ hasText: 'e2e_artist is already in your artist list as Test Artist. Using Test Artist as the artist.' })
	).toHaveCount(1);
	await settledShot(page, testInfo.outputPath('commission-link-match.png'));
	await page.setViewportSize({ width: 390, height: 844 });
	// A full-size tap target on a phone.
	const usingBox = await card.getByRole('button', { name: 'Using Test Artist' }).boundingBox();
	expect(usingBox?.height).toBeGreaterThanOrEqual(44);
	await settledShot(page, testInfo.outputPath('commission-link-match-390.png'));
	await page.setViewportSize({ width: 1280, height: 720 });

	// The lookup's own pick gives way to the next link's match.
	await paste(link, 'https://x.com/solo_artist/status/5');
	await expect(card.getByText('solo_artist is already in your artist list as Solo Artist.')).toBeVisible();
	await expect(artist).toHaveValue('53');

	// A lookup that fails says nothing about the artist, so the pick stays.
	await page.route('**/api/admin/artist-from-link', (route) => route.abort('connectionreset'));
	await paste(link, 'https://x.com/twin_artist/status/6');
	await expect(
		page.locator('#ce-link-msg').getByText("Sona couldn't look up this link. Pick the artist from the list instead.")
	).toBeVisible();
	await expect(artist).toHaveValue('53');
	await page.unrouteAll({ behavior: 'wait' });
	// A link that names several artists, or none, takes the lookup's pick away,
	// so a save can't keep an artist nobody chose.
	await paste(link, 'https://x.com/twin_artist/status/6');
	await expect(card.getByText('twin_artist is in your artist list more than once. Pick one.')).toBeVisible();
	await expect(artist).toHaveValue('');
	await paste(link, 'https://x.com/solo_artist/status/5');
	await expect(artist).toHaveValue('53');
	await paste(link, 'https://x.com/nobody_here/status/3');
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	await expect(artist).toHaveValue('');

	// The owner's own pick doesn't: a match is offered, not imposed.
	await artist.selectOption({ label: 'Avatar Artist' });
	await paste(link, 'https://twitter.com/E2E_Artist/status/2');
	await expect(card.getByRole('button', { name: 'Use Test Artist' })).toBeVisible();
	await expect(artist).toHaveValue('2');
	await expect(liveRegion.filter({ hasText: 'Using Test Artist as the artist.' })).toHaveCount(0);
	// The check says "this is your artist", so it waits for the owner to agree.
	await expect(card.locator('.outcome svg')).toHaveCount(0);
	await card.getByRole('button', { name: 'Use Test Artist' }).click();
	await expect(artist).toHaveValue('1');
	await expect(card.getByRole('button', { name: 'Using Test Artist' })).toBeVisible();
	await expect(card.locator('.outcome svg')).toHaveCount(1);

	// A link with no handle in it: the list is still there to pick from.
	await link.fill('https://www.furaffinity.net/view/58123456/');
	await link.press('Tab');
	await expect(
		page.locator('#ce-link-msg').getByText("This link doesn't include the artist's handle. Pick the artist from the list instead.")
	).toBeVisible();
	await expect(link).toHaveAttribute('aria-describedby', /ce-link-msg/);
	await expect(artist).toBeEnabled();
	await artist.selectOption({ label: 'Avatar Artist' });

	// A handle nobody holds: the page offers to add them, and makes no artist
	// until the owner asks (Q26).
	await link.fill('https://x.com/nobody_here/status/1');
	await link.press('Tab');
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	await expect(card.getByRole('button', { name: 'Add nobody_here as a new artist' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(artist).toHaveValue('2');
	await expect(link).toHaveValue('https://x.com/nobody_here/status/1');
	await settledShot(page, testInfo.outputPath('commission-link-no-match.png'));

	// Add {handle}: the dialog takes the handle, never the pasted post link, and
	// starts private. Cancel makes nothing.
	await paste(link, 'https://x.com/new_from_link/status/9');
	const addHandle = card.getByRole('button', { name: 'Add new_from_link as a new artist' });
	// Drawn as the same pill as Add New Artist below it, not a rectangle.
	const addNewArtist = page.getByRole('button', { name: 'Add New Artist' });
	const pillRadius = await addNewArtist.evaluate((el) => getComputedStyle(el).borderRadius);
	expect(pillRadius).not.toBe('0px');
	await expect(addHandle).toHaveCSS('border-radius', pillRadius);
	await addHandle.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Artist Name')).toHaveValue('new_from_link');
	await expect(dialog.getByLabel('Twitter')).toHaveValue('new_from_link');
	await expect(
		dialog.getByText('Sona filled the name and Twitter link from the link you pasted. They\'re a guess until you check them.')
	).toBeVisible();
	await expect(dialog.getByLabel('Keep private (commission ledger only)')).toBeChecked();
	await settledShot(page, testInfo.outputPath('commission-link-add-artist.png'));
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(addHandle).toBeFocused();
	await expect(artist).toHaveValue('2');

	await addHandle.click();
	await dialog.getByRole('button', { name: 'Create Artist' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(card.getByText('Added new_from_link to your artist list.')).toBeVisible();
	await expect(card.getByRole('button', { name: 'Using new_from_link' })).toBeVisible();
	await expect(artist.locator('option:checked')).toHaveText('new_from_link');
	await expect(liveRegion.filter({ hasText: 'Using new_from_link as the artist.' })).toHaveCount(1);
	// The same link now finds the artist the owner just made.
	await paste(link, 'https://x.com/nobody_here/status/1');
	await paste(link, 'https://x.com/new_from_link/status/9');
	await expect(card.getByText('new_from_link is already in your artist list as new_from_link.')).toBeVisible();

	// Another platform's link fills that platform's field, and the line names it.
	await paste(link, 'https://www.furaffinity.net/user/fa_from_link/');
	await card.getByRole('button', { name: 'Add fa_from_link as a new artist' }).click();
	await expect(dialog.getByLabel('Artist Name')).toHaveValue('fa_from_link');
	await expect(dialog.getByLabel('FurAffinity')).toHaveValue('fa_from_link');
	await expect(dialog.getByLabel('Twitter')).toHaveValue('');
	await expect(
		dialog.getByText('Sona filled the name and FurAffinity link from the link you pasted. They\'re a guess until you check them.')
	).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	// FurTrack has no artist column to match against, so its links are refused
	// and offer no Add.
	await paste(link, 'https://www.furtrack.com/user/ft_from_link');
	await expect(
		page.locator('#ce-link-msg').getByText("Sona can't find artists from this kind of link. Pick the artist from the list instead.")
	).toBeVisible();
	await expect(card).toHaveCount(0);

	// The endpoint takes POST only, so a link never rides in a query string.
	const get = await page.request.get('/api/admin/artist-from-link?url=https%3A%2F%2Fx.com%2Fa');
	expect(get.status()).toBe(405);
});

test('a name that only looks like the handle, or a handle two artists share, waits for the owner', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const link = page.getByLabel('Link to where you asked');
	const artist = page.getByLabel('Artist', { exact: true });
	const card = page.locator('.lookup');

	await paste(link, 'https://x.com/name_only_artist/status/1');
	// One line says what was found; it doesn't also claim the artist is missing.
	const nameOnly = card.getByText('None of your artists links to name_only_artist, but one has that name and might be them.');
	await expect(nameOnly).toBeVisible();
	await expect(card.getByText("name_only_artist isn't in your artist list yet.")).toHaveCount(0);
	await expect(artist).toHaveValue('');
	await card.getByRole('button', { name: 'Use name_only_artist' }).click();
	await expect(artist).toHaveValue('50');
	await expect(card.getByRole('button', { name: 'Using name_only_artist' })).toBeVisible();
	// Taken, the suggestion isn't second-guessed: no "might be them" line and
	// no offer to add the handle as a new artist beside it.
	await expect(nameOnly).toHaveCount(0);
	await expect(card.getByRole('button', { name: /as a new artist$/ })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-link-name-only.png'));

	await artist.selectOption('');
	await paste(link, 'https://x.com/twin_artist/status/1');
	await expect(card.getByText('twin_artist is in your artist list more than once. Pick one.')).toBeVisible();
	await expect(card.getByRole('button', { name: /^Use Twin/ })).toHaveCount(2);
	await expect(artist).toHaveValue('');
	// Each Use button sits beside the name it picks, not across the row.
	for (const match of await card.locator('.match').all()) {
		const name = await match.locator('.name').boundingBox();
		const use = await match.getByRole('button').boundingBox();
		expect(use!.x - (name!.x + name!.width)).toBeLessThan(40);
	}
	await settledShot(page, testInfo.outputPath('commission-link-several.png'));
});

test('a lookup sends once per link, drops a stale answer, and can be tried again', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const link = page.getByLabel('Link to where you asked');
	const artist = page.getByLabel('Artist', { exact: true });
	const card = page.locator('.lookup');
	const lookups = countLookups(page);

	// Typing sends nothing until the owner leaves the field, then sends once.
	await link.pressSequentially('https://x.com/nobody_here/status/7');
	await page.waitForTimeout(500);
	expect(lookups.sent).toEqual([]);
	await link.press('Tab');
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	expect(lookups.count).toBe(1);
	// A paste sends at once, and leaving the field afterwards doesn't send again.
	await paste(link, 'https://x.com/nobody_else/status/8');
	await expect(card.getByText("nobody_else isn't in your artist list yet.")).toBeVisible();
	await link.press('Tab');
	await page.waitForTimeout(500);
	expect(lookups.count).toBe(2);
	// Clearing the field clears the lookup.
	await link.fill('');
	await expect(card).toHaveCount(0);

	// An answer that arrives after the owner moved on to another link is
	// dropped: link A's match would pick Test Artist, so it's held until B is
	// answered.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/admin/artist-from-link', async (route) => {
		if (route.request().postData()?.includes('e2e_artist')) await held;
		await route.continue();
	});
	await paste(link, 'https://x.com/e2e_artist/status/1');
	await paste(link, 'https://x.com/nobody_here/status/9');
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	const staleAnswer = page.waitForResponse(
		(r) => r.url().endsWith('/api/admin/artist-from-link') && !!r.request().postData()?.includes('e2e_artist')
	);
	release();
	await staleAnswer;
	// Past the response, the page has had its chance to apply it.
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	await expect(card.getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	await expect(page.getByText('e2e_artist is already in your artist list as Test Artist.')).toHaveCount(0);
	await expect(artist).toHaveValue('');
	await page.unrouteAll({ behavior: 'wait' });

	// The same link pasted again after clearing is a new request: a late
	// answer to the first one must not land on it. The first is held, the
	// second fails, then the first arrives with a match that would pick Test
	// Artist.
	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
	let sameLink = 0;
	await page.route('**/api/admin/artist-from-link', async (route) => {
		if (!route.request().postData()?.includes('e2e_artist/status/4')) return route.continue();
		sameLink += 1;
		if (sameLink === 1) {
			await firstHeld;
			return route.continue();
		}
		return route.abort('connectionreset');
	});
	await paste(link, 'https://x.com/e2e_artist/status/4');
	await link.fill('');
	await paste(link, 'https://x.com/e2e_artist/status/4');
	const failedLine = page
		.locator('#ce-link-msg')
		.getByText("Sona couldn't look up this link. Pick the artist from the list instead.");
	await expect(failedLine).toBeVisible();
	const lateAnswer = page.waitForResponse(
		(r) => r.url().endsWith('/api/admin/artist-from-link') && !!r.request().postData()?.includes('e2e_artist/status/4')
	);
	releaseFirst();
	await lateAnswer;
	await expect(failedLine).toBeVisible();
	await expect(card).toHaveCount(0);
	await expect(artist).toHaveValue('');
	await page.unrouteAll({ behavior: 'wait' });

	// An answer dropped because the owner edited the field mid-lookup leaves
	// nothing stuck: once the field is back to that link and they leave it, the
	// link is looked up again.
	await link.fill('');
	let releaseEdited!: () => void;
	const editedHeld = new Promise<void>((resolve) => (releaseEdited = resolve));
	let editedLink = 0;
	await page.route('**/api/admin/artist-from-link', async (route) => {
		if (route.request().postData()?.includes('e2e_artist/status/5') && ++editedLink === 1) await editedHeld;
		await route.continue();
	});
	await link.focus();
	await paste(link, 'https://x.com/e2e_artist/status/5');
	await link.press('End');
	await link.press('x');
	const droppedAnswer = page.waitForResponse(
		(r) => r.url().endsWith('/api/admin/artist-from-link') && !!r.request().postData()?.includes('e2e_artist/status/5')
	);
	releaseEdited();
	await droppedAnswer;
	await link.press('Backspace');
	await link.press('Tab');
	await expect(card.getByText('e2e_artist is already in your artist list as Test Artist.')).toBeVisible();
	expect(editedLink).toBe(2);
	await page.unrouteAll({ behavior: 'wait' });
	await link.fill('');
	await artist.selectOption('');

	// A lookup that didn't get through can be tried again with the same link.
	let failNext = true;
	await page.route('**/api/admin/artist-from-link', (route) => {
		if (failNext) {
			failNext = false;
			return route.abort('connectionreset');
		}
		return route.continue();
	});
	const before = lookups.count;
	await paste(link, 'https://x.com/e2e_artist/status/3');
	const failedAgain = page
		.locator('#ce-link-msg')
		.getByText("Sona couldn't look up this link. Pick the artist from the list instead.");
	await expect(failedAgain).toBeVisible();
	// The warning line takes the warning color, not the muted hint color.
	const warnColor = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--status-warn)';
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(page.locator('#ce-link-msg.hint-warn')).toHaveCSS('color', warnColor);
	await paste(link, 'https://x.com/e2e_artist/status/3');
	await expect(card.getByText('e2e_artist is already in your artist list as Test Artist.')).toBeVisible();
	expect(lookups.count - before).toBe(2);
});

test('the draft survives a trip to the Artists page, and the lookup asks again on return', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const link = page.getByLabel('Link to where you asked');
	const artist = page.getByLabel('Artist', { exact: true });
	await page.getByLabel('Title').fill('E2E draft title');
	// A FurAffinity handle, because adding an artist with an X or Bluesky
	// handle fetches their avatar from that site.
	await paste(link, 'https://www.furaffinity.net/user/draft_artist/');
	const card = page.locator('.lookup');
	await expect(card.getByText("draft_artist isn't in your artist list yet.")).toBeVisible();
	// The owner goes to the Artists page anyway (the sidebar link; the card
	// offers Add instead) and adds the artist there.
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Artists' }).click();
	await expect(page).toHaveURL(/\/admin\/artists$/);
	// Through the same endpoint the add dialog uses.
	const created = await page.request.post('/api/artists', { data: { name: 'Draft Artist', furaffinity: 'draft_artist' } });
	expect(created.ok()).toBe(true);
	const { id } = (await created.json()) as { id: number };

	await page.goBack();
	await expect(page).toHaveURL(/\/admin\/commissions\/new$/);
	await expect(page.getByLabel('Title')).toHaveValue('E2E draft title');
	await expect(link).toHaveValue('https://www.furaffinity.net/user/draft_artist/');
	await expect(draftNote(page)).toBeVisible();
	// Asked again, so the answer knows about the new artist, and picks them.
	await expect(card.getByText('draft_artist is already in your artist list as Draft Artist.')).toBeVisible();
	await expect(artist).toHaveValue(String(id));
	await settledShot(page, testInfo.outputPath('commission-link-draft-restored.png'));
});

test("a restored draft keeps the lookup's own pick replaceable", async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	const link = page.getByLabel('Link to where you asked');
	const artist = page.getByLabel('Artist', { exact: true });
	const card = page.locator('.lookup');
	await paste(link, 'https://x.com/e2e_artist/status/21');
	await expect(artist).toHaveValue('1');

	await page.locator('.sidebar-nav').getByRole('link', { name: 'Artists' }).click();
	await expect(page).toHaveURL(/\/admin\/artists$/);
	await page.goBack();
	await expect(card.getByText('e2e_artist is already in your artist list as Test Artist.')).toBeVisible();
	await expect(artist).toHaveValue('1');

	// Still the lookup's pick, so the next link's match replaces it.
	await paste(link, 'https://x.com/solo_artist/status/22');
	await expect(card.getByText('solo_artist is already in your artist list as Solo Artist.')).toBeVisible();
	await expect(artist).toHaveValue('53');
});

test('Back during a navigation leaves the ledger pages working', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	// A slow machine, so Back lands before the Artists page has finished
	// rendering. SvelteKit then shows the page being left the Artists page's
	// data; the page-error guard fails this test if that throws.
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
	for (let i = 0; i < 4; i++) {
		await page.locator('.sidebar-nav').getByRole('link', { name: 'Artists' }).click();
		await expect(page).toHaveURL(/\/admin\/artists$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/admin\/commissions\/new$/);
	}
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	await expect(page.getByRole('heading', { level: 1, name: 'New entry' })).toBeVisible();
	await expect(page.getByLabel('Link to where you asked')).toBeVisible();
});

test('a saved form leaves no draft to come back to', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill('E2E saved once');
	await paste(page.getByLabel('Link to where you asked'), 'https://x.com/nobody_here/status/30');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);

	// Back to the form: empty, so saving again can't make a second entry.
	await page.goBack();
	await expect(page).toHaveURL(/\/admin\/commissions\/new$/);
	await expect(page.getByLabel('Title')).toHaveValue('');
	await expect(page.locator('.lookup')).toHaveCount(0);

	// Leave the ledger as the next steps expect it: one entry.
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: 'Edit E2E saved once' }).getAttribute('href');
	await open(page, editUrl!);
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
});

test('moving the entry to Delivered lists it under Finished', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// The saved price comes back in its typed form.
	await expect(page.getByLabel('Amount')).toHaveValue('120.00');
	await page.getByLabel('Status').selectOption('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).not.toHaveValue('');
	// A date the owner picks, which Add to gallery must keep later.
	await page.getByLabel('Delivered', { exact: true }).fill('2026-01-02');
	await settledShot(page, testInfo.outputPath('commission-entry-edit.png'));
	await page.getByRole('button', { name: 'Save changes' }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Delivered');
	await expect(row).toContainText('Not in your gallery');
	await expect(section(page, 'Active')).toContainText('Entries you mark Applied, Waitlisted, Accepted, or In progress show here.');
	await settledShot(page, testInfo.outputPath('commission-ledger-finished.png'));
});

// One small PNG: the upload is stubbed below, so only the browser reads it.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

/** Uploads one file and saves it as `title`. The file goes to storage first;
 * the stub answers with an asset the site already serves, so the piece
 * renders. setInputFiles doesn't reach Svelte's delegated change handler, so
 * the change is dispatched by hand, retried until hydration attaches it. */
async function uploadPiece(page: Page, title: string | null, lands: RegExp = /\/admin\/commissions\?added=\d+$/) {
	await page.route(
		(url) => url.pathname === '/api/upload',
		(route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: '/e2e-avatar.svg' }) })
	);
	await expect(async () => {
		await page.setInputFiles('input[type="file"]', { name: 'piece.png', mimeType: 'image/png', buffer: PNG });
		await page.evaluate(() =>
			document.querySelector('input[type="file"]')!.dispatchEvent(new Event('change', { bubbles: true }))
		);
		await expect(page.locator('input[name="imageUrl_0"]')).toHaveValue('/e2e-avatar.svg', { timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	// A variant has no title of its own: it takes its piece's.
	if (title !== null) await page.locator('input[name="title"]').fill(title);
	await page.getByRole('button', { name: 'Upload Artwork' }).click();
	await expect(page).toHaveURL(lands);
}

const galleryPanel = (page: Page) =>
	page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Gallery' }) });

test("leaving an entry's upload for a plain one drops everything the entry filled", async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await section(page, 'Finished').getByRole('link', { name: `Add to gallery: ${TITLE}` }).click();
	await expect(page.getByRole('note')).toContainText(`From your commission: ${TITLE}.`);
	await waitForHydration(page);
	await expect(page.locator('input[name="commissionId"]')).toHaveCount(1);

	// The sidebar's Upload is the same page with no entry: SvelteKit keeps the
	// page mounted across it unless something makes it start over.
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Upload' }).click();
	await expect(page).toHaveURL(/\/admin\/upload$/);
	await expect(page.getByText('From your commission')).toHaveCount(0);
	await expect(page.locator('input[name="commissionId"]')).toHaveCount(0);
	await expect(page.locator('select[name="artistId"]')).toHaveValue('');
	await expect(page.locator('input[name="char-1"]')).not.toBeChecked();
	await expect(page.locator('input[name="char-2"]')).not.toBeChecked();
	await expect(page.locator('input[name="published"]')).not.toBeChecked();
	await settledShot(page, testInfo.outputPath('commission-upload-plain-after-entry.png'));

	// Saved, it's an ordinary upload, and the entry stays as it was.
	await page.locator('select[name="artistId"]').selectOption({ label: 'Test Artist' });
	await uploadPiece(page, 'E2E unrelated piece', /\/admin\/images$/);
	await open(page, '/admin/commissions');
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row).toContainText('Not in your gallery');
	await expect(row.getByRole('link', { name: 'E2E unrelated piece' })).toHaveCount(0);
});

test('Add to gallery uploads a new piece and links it to the entry', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: `Edit ${TITLE}` }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Delivered and not in the gallery yet: the panel offers Add to gallery.
	const panel = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Gallery' }) });
	await expect(panel).toContainText('Not in your gallery');
	await expect(panel).toContainText('Opens the upload form with this entry');
	await expect(panel.getByRole('link', { name: 'Add to gallery' })).toHaveClass(/btn-primary/);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-delivered.png'));
	await panel.getByRole('link', { name: 'Add to gallery' }).click();

	await expect(page.getByRole('heading', { level: 1, name: 'Upload New Artwork' })).toBeVisible();
	await waitForHydration(page);
	await expect(page.getByRole('note')).toContainText(`From your commission: ${TITLE}.`);
	await expect(page.getByRole('note')).toContainText('This becomes a new piece.');
	// The artist and characters come from the entry. The title, source, and date
	// stay empty, and the piece starts private.
	await expect(page.locator('select[name="artistId"]')).toHaveValue('1');
	await expect(page.locator('input[name="char-1"]')).toBeChecked();
	await expect(page.locator('input[name="char-2"]')).toBeChecked();
	await expect(page.locator('input[name="title"]')).toHaveValue('');
	await expect(page.locator('input[name="sourcePostUrl"]')).toHaveValue('');
	await expect(page.locator('input[name="commissionedAt"]')).toHaveValue('');
	await expect(page.locator('input[name="published"]')).toBeChecked();
	// No Look up artist and no prompt to set one up: it would send the image to
	// FuzzySearch, and the entry already names the artist.
	await expect(page.getByRole('button', { name: 'Look up artist' })).toHaveCount(0);
	await expect(page.locator('#lookup-hint')).toHaveCount(0);
	// A new piece can still become the owner's reference sheet.
	await expect(page.locator('input[name="useAsReference"]')).toHaveCount(1);
	await settledShot(page, testInfo.outputPath('commission-upload-prefilled.png'));

	await uploadPiece(page, 'E2E Snowfall');

	const notice = page.locator('.notice.ok');
	await expect(notice).toContainText('Added to your gallery as a private piece: E2E Snowfall.');
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	await expect(row.getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await expect(row.locator('.thumb img')).toHaveAttribute('src', /e2e-avatar\.svg/);
	await settledShot(page, testInfo.outputPath('commission-ledger-linked.png'));

	// The entry's panel now shows the piece and offers a variant instead. Opened
	// by its address: a click straight after the upload's client-side redirect
	// can land before the ledger finishes settling and go nowhere.
	const editUrl = await row.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');
	await open(page, editUrl!);
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await expect(panel.getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await expect(panel.getByRole('link', { name: 'Add a variant' })).toHaveAttribute('href', /\/admin\/upload\?commission=\d+$/);
	await expect(panel.getByRole('link', { name: 'Add to gallery' })).toHaveCount(0);
	// The Delivered date the owner set stays as it was.
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue('2026-01-02');

	// Add a variant opens the upload for that piece: no group choice, and no
	// reference-sheet box, since a variant can't be the reference sheet.
	await panel.getByRole('link', { name: 'Add a variant' }).click();
	await expect(page.getByRole('note')).toContainText('This adds a variant to the piece E2E Snowfall.');
	await waitForHydration(page);
	await expect(page.getByText('Variant of', { exact: true })).toBeVisible();
	await expect(page.locator('input[name="groupMode"]')).toHaveCount(0);
	await expect(page.locator('input[name="useAsReference"]')).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-upload-variant.png'));
});

const ENTRY_ART_HINT =
	"Look up artist isn't available for art you added from a commission entry. The entry already names the artist.";

/** Saves or removes a throwaway FuzzySearch key through the settings page's own
 * actions. Never used: the tests below only check what the edit page offers. */
async function setLookupKey(page: Page, on: boolean) {
	const action = on ? 'saveFuzzysearchKey' : 'removeFuzzysearchKey';
	const res = await page.request.post(`/admin/settings?/${action}`, {
		form: on ? { fuzzysearchApiKey: 'e2e-not-a-real-key' } : {},
		headers: { origin: new URL(page.url()).origin, 'x-sveltekit-action': 'true' }
	});
	expect(res.ok()).toBe(true);
	expect(((await res.json()) as { type: string }).type).toBe('success');
}

test('a piece added from an entry offers no Look up artist, and says why', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const row = section(page, 'Finished').getByRole('row', { name: new RegExp(TITLE) });
	const pieceUrl = await row.getByRole('link', { name: 'E2E Snowfall' }).getAttribute('href');
	const entryUrl = await row.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');
	await setLookupKey(page, true);
	try {
		// With the key saved, a piece no entry links to offers the lookup.
		await open(page, '/admin/images/1/edit');
		await expect(page.getByRole('button', { name: 'Look up artist' })).toBeVisible();

		// The entry's piece doesn't, and the hint says why.
		await open(page, pieceUrl!);
		await expect(page.locator('input[name="title"]')).toHaveValue('E2E Snowfall');
		await expect(page.getByRole('button', { name: 'Look up artist' })).toHaveCount(0);
		await expect(page.locator('#lookup-hint')).toHaveText(
			ENTRY_ART_HINT
		);
		await settledShot(page, testInfo.outputPath('commission-piece-no-lookup.png'));

		// A variant added from the entry is entry art too.
		await open(page, entryUrl!);
		await galleryPanel(page).getByRole('link', { name: 'Add a variant' }).click();
		await waitForHydration(page);
		await uploadPiece(page, null, /\/admin\/commissions\?added=\d+&variants=\d+$/);
		const variantId = new URL(page.url()).searchParams.get('variants');
		await open(page, `/admin/images/${variantId}/edit`);
		await expect(page.getByRole('button', { name: 'Look up artist' })).toHaveCount(0);
		await expect(page.locator('#lookup-hint')).toHaveText(
			ENTRY_ART_HINT
		);
	} finally {
		await setLookupKey(page, false);
	}
});

test('phone width: the ledger and the prefilled upload, light and dark', async ({ page }, testInfo) => {
	const title = 'E2E delivered';
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Status').selectOption('delivered');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);

	// One linked entry and one delivered entry not in the gallery yet.
	await page.setViewportSize({ width: 390, height: 844 });
	const shoot = async (name: string) => {
		for (const mode of ['light', 'dark']) {
			await page.evaluate((m) => document.documentElement.setAttribute('data-theme', m), mode);
			await settledShot(page, testInfo.outputPath(`${name}-390-${mode}.png`));
		}
	};
	await open(page, '/admin/commissions');
	await expect(section(page, 'Finished').getByRole('link', { name: 'E2E Snowfall' })).toBeVisible();
	await shoot('commission-ledger-phone');

	await section(page, 'Finished').getByRole('link', { name: `Add to gallery: ${title}` }).click();
	// The upload page drops its heading at phone width, so wait on the note.
	await expect(page.getByRole('note')).toContainText(`From your commission: ${title}.`);
	await waitForHydration(page);
	await shoot('commission-upload-prefilled-phone');

	// Leave the ledger as the next steps expect it: one entry.
	await page.setViewportSize({ width: 1280, height: 720 });
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: `Edit ${title}` }).getAttribute('href');
	await open(page, editUrl!);
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('link', { name: `Edit ${title}` })).toHaveCount(0);
});

test("an entry with no Delivered date gets the browser's date when added to the gallery", async ({ page }, testInfo) => {
	const title = 'E2E in progress';
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Artist', { exact: true }).selectOption({ label: 'Test Artist' });
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Status').selectOption('cancelled');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const editUrl = await page.getByRole('link', { name: `Edit ${title}` }).getAttribute('href');

	// Canceled: nothing to add.
	await open(page, editUrl!);
	await expect(galleryPanel(page)).toContainText("You can't add an entry marked Not picked or Canceled to your gallery.");
	await expect(galleryPanel(page).getByRole('link')).toHaveCount(0);
	await expect(galleryPanel(page).getByRole('button')).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-closed.png'));

	// In progress, with no Delivered date.
	await page.getByLabel('Status').selectOption('in_progress');
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue('');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await open(page, editUrl!);
	const add = galleryPanel(page).getByRole('link', { name: 'Add to gallery' });
	await expect(add).toBeVisible();
	await expect(add).toHaveClass(/btn-secondary/);
	await expect(galleryPanel(page)).toContainText('Saving the upload marks this entry Delivered.');
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-active.png'));

	// Unsaved changes hold the button back until they're saved or undone.
	await page.getByLabel('Notes').fill('Not saved yet');
	const held = galleryPanel(page).getByRole('button', { name: 'Add to gallery' });
	await expect(held).toHaveAttribute('aria-disabled', 'true');
	await expect(galleryPanel(page)).toContainText('Save your changes first.');
	// Held, it reads as not ready: the secondary fill, hover included, with a
	// label that still clears 4.5:1 as rendered.
	await held.hover();
	await expect.poll(() => held.evaluate((el) => el.getAnimations().length)).toBe(0);
	const [label, fill, secondary] = await held.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--secondary)';
		document.body.append(probe);
		const style = getComputedStyle(el);
		const found = [style.color, style.backgroundColor, getComputedStyle(probe).backgroundColor];
		probe.remove();
		return found;
	});
	expect(fill).toBe(secondary);
	expect(contrastRatio(label, fill)).toBeGreaterThanOrEqual(4.5);
	await settledShot(page, testInfo.outputPath('commission-entry-gallery-dirty.png'));
	await page.getByLabel('Notes').fill('');
	await expect(add).toBeVisible();

	await add.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Upload New Artwork' })).toBeVisible();
	await waitForHydration(page);
	await uploadPiece(page, 'E2E Second piece');

	// Delivered now, dated by the browser that saved it.
	const today = await page.evaluate(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	});
	await open(page, editUrl!);
	await expect(page.getByLabel('Status')).toHaveValue('delivered');
	await expect(page.getByLabel('Delivered', { exact: true })).toHaveValue(today);

	// Leave the ledger as the next steps expect it: one entry.
	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('link', { name: `Edit ${title}` })).toHaveCount(0);
});

test('an out-of-date save is refused, and Reload entry brings the typed note back', async ({ page, context }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: `Edit ${TITLE}` }).getAttribute('href');

	// This tab opens the form first.
	await open(page, editUrl!);

	// Another tab changes the entry and saves.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByLabel('Title').fill(`${TITLE} (renamed)`);
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	// This tab, still on the old copy, changes the note and the payment.
	await page.getByLabel('Notes').fill('Typed before the reload.');
	await page.getByLabel('Payment').selectOption('deposit');

	// Record every text the alert ever shows, from the moment it's added, so a
	// first render with half the message (read out, then rewritten) is caught.
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { alertTexts: string[] }).alertTexts = seen;
		const record = (el: Element) => {
			const text = el.textContent?.trim() ?? '';
			if (seen.at(-1) !== text) seen.push(text);
		};
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
				for (const node of mutation.addedNodes) {
					if (node instanceof Element) node.querySelectorAll('[role="alert"]').forEach(record);
					if (node instanceof Element && node.matches('[role="alert"]')) record(node);
				}
				const alert = target?.closest('[role="alert"]');
				if (alert) record(alert);
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	await page.getByRole('button', { name: 'Save changes' }).click();

	const alert = page.getByRole('alert').filter({ hasText: 'changed after you opened it' });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText('Your note comes with it, but your changes to Payment don');
	await expect(alert).toBeFocused();
	const texts = await page.evaluate(() => (window as unknown as { alertTexts: string[] }).alertTexts);
	expect(texts.length, JSON.stringify(texts)).toBeGreaterThan(0);
	expect(texts[0]).toContain('your changes to Payment');
	expect(new Set(texts).size, JSON.stringify(texts)).toBe(1);
	await page.getByText('Why did this happen?').click();
	await expect(page.getByText('Another tab or device changed this entry')).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-stale.png'));

	await page.getByRole('button', { name: 'Reload entry' }).click();
	const notes = page.getByLabel('Notes');
	await expect(notes).toHaveValue('Typed before the reload.');
	await expect(notes).toBeFocused();
	await expect(page.getByLabel('Title')).toHaveValue(`${TITLE} (renamed)`);
	await expect(page.getByLabel('Payment')).toHaveValue('unpaid');
	await expect(page.getByText("Your note from before the reload isn't saved yet. Save changes to keep it.")).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-entry-reloaded.png'));

	// The reloaded form carries the current version, so this save goes through.
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(section(page, 'Finished').getByRole('row', { name: /renamed/ })).toBeVisible();
});

test('Reload entry clears the last lookup, and the same link can be looked up again', async ({ page, context }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).getAttribute('href');
	await open(page, editUrl!);
	const lookups = countLookups(page);

	// Another tab saves, so this tab's save will be out of date.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	const link = page.getByLabel('Link to where you asked');
	await paste(link, 'https://x.com/nobody_here/status/12');
	await expect(page.locator('.lookup').getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	await page.getByRole('button', { name: 'Save changes' }).click();
	await page.getByRole('button', { name: 'Reload entry' }).click();
	await expect(page.locator('.lookup')).toHaveCount(0);
	await expect(page.locator('#ce-link-msg')).toHaveCount(0);

	const before = lookups.count;
	await paste(link, 'https://x.com/nobody_here/status/12');
	await expect(page.locator('.lookup').getByText("nobody_here isn't in your artist list yet.")).toBeVisible();
	expect(lookups.count - before).toBe(1);
});

test('a draft typed against an older copy of the entry is dropped on return', async ({ page, context }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).getAttribute('href');
	await open(page, editUrl!);
	const kind = page.getByLabel('Kind');
	const keptKind = await kind.inputValue();

	await page.getByLabel('Notes').fill('E2E draft note');
	await paste(page.getByLabel('Link to where you asked'), 'https://x.com/nobody_here/status/40');
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Artists' }).click();
	await expect(page).toHaveURL(/\/admin\/artists$/);

	// Meanwhile another tab changes the entry and saves.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByLabel('Kind').fill('Changed elsewhere');
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();

	// Back: the current entry, not the old draft over it.
	await page.goBack();
	await expect(kind).toHaveValue('Changed elsewhere');
	await expect(page.getByLabel('Notes')).not.toHaveValue('E2E draft note');
	await expect(page.getByLabel('Link to where you asked')).not.toHaveValue('https://x.com/nobody_here/status/40');
	await expect(draftNote(page)).toHaveCount(0);
	// Saving now keeps the other tab's change.
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await open(page, editUrl!);
	await expect(kind).toHaveValue('Changed elsewhere');

	// Put the kind back for the steps after this one, and check a saved edit
	// leaves no draft: Back shows what was saved.
	await kind.fill(keptKind);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await page.goBack();
	await expect(kind).toHaveValue(keptKind);
});

test('Reload entry takes away the draft-is-back line', async ({ page, context }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	const editUrl = await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).getAttribute('href');
	await open(page, editUrl!);
	const notes = page.getByLabel('Notes');
	const keptNotes = await notes.inputValue();

	await notes.fill('E2E draft before reload');
	await paste(page.getByLabel('Link to where you asked'), 'https://x.com/nobody_here/status/41');
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Artists' }).click();
	await expect(page).toHaveURL(/\/admin\/artists$/);
	await page.goBack();
	await expect(notes).toHaveValue('E2E draft before reload');
	await expect(draftNote(page)).toBeVisible();

	// Another tab saves, so this save is out of date and offers Reload entry.
	const other = await context.newPage();
	await open(other, editUrl!);
	await other.getByRole('button', { name: 'Save changes' }).click();
	await expect(other).toHaveURL(/\/admin\/commissions$/);
	await other.close();
	await page.getByRole('button', { name: 'Save changes' }).click();
	await page.getByRole('button', { name: 'Reload entry' }).click();
	// The form shows the saved entry now, with only the typed note carried over.
	await expect(notes).toHaveValue('E2E draft before reload');
	await expect(draftNote(page)).toHaveCount(0);

	// Leave the entry as it was for the steps after this one.
	await notes.fill(keptNotes);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
});

test('an entry deleted elsewhere: save says so, and delete counts as done', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Both actions answer as the server does once the entry is gone. The stubs
	// never reach the server, so the entry is still there for the next test.
	const missing = { status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'failure', status: 404, data: '[{"missing":1},true]' }) };
	const action = (name: string) => (url: URL) => url.pathname.endsWith('/edit') && url.search === `?/${name}`;
	await page.route(action('save'), (route) => route.fulfill(missing));
	await page.route(action('delete'), (route) => route.fulfill(missing));

	await page.getByRole('button', { name: 'Save changes' }).click();
	const alert = page.getByRole('alert').filter({ hasText: 'This entry was deleted somewhere else' });
	await expect(alert).toBeVisible();
	await expect(alert).toBeFocused();
	await expect(alert.getByRole('link', { name: 'Go back to your ledger' })).toHaveAttribute('href', '/admin/commissions');
	await expect(page.getByRole('status').filter({ hasText: "Couldn't save the entry" })).toHaveCount(0);
	await settledShot(page, testInfo.outputPath('commission-entry-missing.png'));

	await page.getByRole('button', { name: 'Delete entry' }).click();
	await page.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('status').filter({ hasText: "Couldn't delete the entry" })).toHaveCount(0);
});

test('deleting the entry empties the ledger', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions');
	await page.getByRole('link', { name: new RegExp(`^Edit ${TITLE}`) }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Edit entry' })).toBeVisible();
	await waitForHydration(page);

	// Hovered, the label keeps 4.5:1 against what the browser actually paints.
	const deleteButton = page.getByRole('button', { name: 'Delete entry' });
	await deleteButton.hover();
	// The button eases its background, and reduced motion doesn't stop that, so
	// read the colors only once the hover has finished.
	await expect.poll(() => deleteButton.evaluate((el) => el.getAnimations().length)).toBe(0);
	const [color, background, pageBackground] = await deleteButton.evaluate((el) => {
		const probe = document.createElement('span');
		probe.style.backgroundColor = 'var(--background)';
		document.body.append(probe);
		const style = getComputedStyle(el);
		const found = [style.color, style.backgroundColor, getComputedStyle(probe).backgroundColor];
		probe.remove();
		return found;
	});
	expect(background).toBe(pageBackground);
	expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
	await deleteButton.click();
	const dialog = page.getByRole('dialog', { name: 'Delete this entry?' });
	await expect(dialog).toContainText('Test Artist stays in your artist list');
	await settledShot(page, testInfo.outputPath('commission-entry-delete.png'));
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

	await expect(page).toHaveURL(/\/admin\/commissions$/);
	await expect(page.getByRole('heading', { name: 'No commissions yet' })).toBeVisible();
	await settledShot(page, testInfo.outputPath('commission-ledger-emptied.png'));
});

test('signing out forgets unsaved drafts', async ({ page }) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');
	await page.getByLabel('Title').fill('E2E draft before sign-out');
	await page.locator('.sidebar-nav').getByRole('link', { name: 'Commissions' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	// A reload writes the drafts SvelteKit holds to sessionStorage, as closing
	// or hiding the tab would.
	await page.reload();
	await waitForHydration(page);
	const stored = () => page.evaluate(() => sessionStorage.getItem('sveltekit:snapshot') ?? '');
	expect(await stored()).toContain('E2E draft before sign-out');

	// A sign-out that doesn't go through keeps the owner signed in, so it
	// keeps their drafts too, including through the next reload.
	await page.route('**/admin/logout', (route) => route.abort('connectionreset'));
	await page.locator('.sidebar-footer').getByRole('button', { name: 'Logout' }).click();
	await page.waitForTimeout(500);
	await page.unrouteAll({ behavior: 'wait' });
	await page.reload();
	await waitForHydration(page);
	expect(await stored()).toContain('E2E draft before sign-out');

	await page.locator('.sidebar-footer').getByRole('button', { name: 'Logout' }).click();
	await expect(page).toHaveURL(/\/admin\/login$/);
	expect(await stored()).not.toContain('E2E draft before sign-out');
});

test('Other currency finds a currency, and Add New Artist makes a private artist for the entry', async ({ page }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await open(page, '/admin/commissions/new');

	// No saved entry has a price now, so the row leads with the browser's region.
	await expect(page.getByRole('radio', { name: /USD/ })).toBeChecked();
	await expect(page.locator('#ce-currency-hint')).toHaveText('Pick the currency the artist charges in.');

	// Other currency: search by code, Escape closes back to the button, Enter picks.
	const other = page.getByRole('button', { name: 'Other currency' });
	await other.click();
	const find = page.getByRole('combobox', { name: 'Find a currency' });
	const results = page.getByRole('listbox', { name: 'Find a currency' });
	await expect(find).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(find).toBeHidden();
	await expect(other).toBeFocused();
	// Down and Up move through the list and wrap at both ends; Enter picks the
	// active option.
	await other.click();
	const options = results.getByRole('option');
	const firstId = (await options.first().getAttribute('id'))!;
	const secondId = (await options.nth(1).getAttribute('id'))!;
	const lastId = (await options.last().getAttribute('id'))!;
	await expect(find).toHaveAttribute('aria-activedescendant', firstId);
	await page.keyboard.press('ArrowUp');
	await expect(find).toHaveAttribute('aria-activedescendant', lastId);
	await page.keyboard.press('ArrowDown');
	await expect(find).toHaveAttribute('aria-activedescendant', firstId);
	await page.keyboard.press('ArrowDown');
	await expect(find).toHaveAttribute('aria-activedescendant', secondId);
	await page.keyboard.press('Enter');
	const secondCode = secondId.replace('ce-currency-opt-', '');
	await expect(page.getByRole('radio', { name: new RegExp(secondCode) })).toBeChecked();
	// With nothing matching, there's no list, only the count saying so.
	await other.click();
	await find.fill('zzzz');
	await expect(results).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'No currency matches “zzzz”.' })).toBeVisible();
	await find.fill('krw');
	await expect(results.getByRole('option')).toHaveCount(1);
	await page.keyboard.press('Enter');
	const krw = page.getByRole('radio', { name: /KRW/ });
	await expect(krw).toBeChecked();
	await expect(krw).toBeFocused();
	await expect(page.locator('#ce-price-hint')).toHaveText(/^KRW amounts are whole numbers\./);
	// The list marks the current currency in words, not only with a check.
	await other.click();
	await find.fill('krw');
	await expect(results.getByRole('option', { name: /KRW.*\(current\)/ })).toBeVisible();
	// A name in the admin language matches too.
	await find.fill('swiss');
	await expect(results.getByRole('option', { name: /CHF/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await settledShot(page, testInfo.outputPath('commission-entry-currency-picked.png'));

	// Add New Artist: focus lands in the dialog, so Escape closes it.
	const addArtist = page.getByRole('button', { name: 'Add New Artist' });
	await addArtist.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Artist Name')).toBeFocused();
	// Tab stays inside the dialog: back past its first control wraps to its last.
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.locator(':focus')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(addArtist).toBeFocused();

	await addArtist.click();
	// An entry's artist starts private, so a sync can't share them before Save.
	await expect(dialog.getByLabel('Keep private (commission ledger only)')).toBeChecked();
	await dialog.getByLabel('Artist Name').fill('E2E Private Artist');
	await settledShot(page, testInfo.outputPath('commission-entry-new-artist.png'));
	await dialog.getByRole('button', { name: 'Create Artist' }).click();
	await expect(dialog).toBeHidden();
	const artist = page.getByLabel('Artist', { exact: true });
	await expect(artist.locator('option:checked')).toHaveText('E2E Private Artist');
	await expect(artist).toBeFocused();

	await page.getByLabel('Title').fill('E2E won entry');
	await page.getByLabel('Amount').fill('50000');
	await page.getByRole('button', { name: 'Save entry' }).click();
	await expect(page).toHaveURL(/\/admin\/commissions$/);
	const row = section(page, 'Active').getByRole('row', { name: /E2E won entry/ });
	await expect(row).toContainText('E2E Private Artist');

	// The artist was stored private.
	await open(page, '/admin/artists');
	await page
		.getByRole('row', { name: /E2E Private Artist/ })
		.getByRole('button', { name: 'Edit artist' })
		.click();
	// The Edit Artist modal has no dialog role, so the label alone finds it.
	await expect(page.getByLabel('Keep private (commission ledger only)')).toBeChecked();

	// Back on a new entry, the row leads with the newest saved currency.
	await open(page, '/admin/commissions/new');
	await expect(page.getByRole('radio').first()).toHaveAccessibleName(/KRW/);
	await expect(page.getByRole('radio', { name: /KRW/ })).toBeChecked();
	await expect(page.locator('#ce-currency-hint')).toHaveText('The currencies you used most recently show first.');

	// A Japanese owner finds the yen by its Japanese name.
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	try {
		await open(page, '/admin/commissions/new');
		await page.getByRole('button', { name: 'その他の通貨' }).click();
		await page.getByRole('combobox', { name: '通貨を検索' }).fill('円');
		await expect(page.getByRole('listbox', { name: '通貨を検索' }).getByRole('option', { name: /JPY/ })).toBeVisible();
	} finally {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', domain: 'localhost', path: '/' }]);
	}
});
