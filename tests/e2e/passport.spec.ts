import { test, expect, type Page } from '@playwright/test';

// The passport homepage (landingLayout = 'passport'), end to end. This file runs
// under two projects, each on its own seeded server (see playwright.config.ts):
//
//   passport        the shared fixture plus fixtures/passport.sql: four
//                   published pieces by one artist, only one of them in the
//                   picture pool (one NSFW, two tagged with a character who
//                   is not the owner), four published VR avatars, two
//                   socials, a confirmed convention running today and one
//                   upcoming, and one fursuit photo from a past event
//                   (FurTrack in mock mode).
//   passport-empty  the same fixture with every piece, avatar, convention,
//                   social and the pronouns taken away (fixtures/
//                   passport-empty.sql): a fresh fork.
//
// Read-only throughout: no login and no writes. This asserts markup, not
// pixels, apart from the card's offset below the header, which the mock fixes.

// The artist list opens on client input, so retry until hydration has wired it.
// The listbox shares the combobox's label, so the lookup fails if it loses its name.
async function expectArtistEmptyState(page: Page, label: string, expectedText: string) {
	const artist = page.getByRole('combobox', { name: label, exact: true });
	await expect(async () => {
		await artist.fill('zzqx no such artist');
		await expect(page.getByRole('listbox', { name: label, exact: true })).toContainText(expectedText, { timeout: 1000 });
	}).toPass();
	return artist;
}

test.describe('populated passport', () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== 'passport', 'runs on the populated passport server');
	});

	test('renders the data page: one h1, the details, and the piece of the day', async ({ page }) => {
		await page.goto('/');

		await expect(page.locator('h1')).toHaveCount(1);
		const data = page.getByRole('region', { name: 'E2E', exact: true });
		await expect(data.getByRole('heading', { level: 1, name: 'E2E' })).toBeVisible();

		// Pronouns speak once, with the hidden prefix.
		await expect(data.locator('.f-value', { hasText: 'they/them' })).toHaveText('Pronouns: they/them');
		const details = data.locator('dl');
		await expect(details).toContainText('Species');
		await expect(details).toContainText('Red fox');
		await expect(details).toContainText(new URL(page.url()).host);
		await expect(details).toContainText('Commissioning since');
		await expect(details).toContainText('2019');
		await expect(data.getByText('A red fox in a blue jacket, seeded for the browser tests.')).toBeVisible();

		// The one piece in the pool: not the NSFW piece, and not the pieces tagged
		// with a character who isn't the owner. Linked to its piece page, named by
		// its title, eager, and with no NSFW gate.
		const picture = data.locator('a.photo-frame');
		await expect(picture).toHaveAttribute('href', '/gallery/e2e-daily-piece');
		await expect(picture).toHaveAccessibleName('E2E Daily Piece');
		await expect(data.getByRole('link', { name: 'E2E Daily Piece', exact: true })).toHaveCount(1);
		const img = picture.locator('img');
		await expect(img).toHaveAttribute('alt', 'E2E Daily Piece');
		await expect(img).toHaveAttribute('loading', 'eager');
		await expect(img).toHaveAttribute('fetchpriority', 'high');
		await expect(picture.locator('.gate, button')).toHaveCount(0);
		await expect(img).toHaveCSS('filter', 'none');
		// The caption is the credit alone: no title and no "Ref sheet".
		const caption = data.locator('figcaption');
		await expect(caption).toHaveText('Art by Test Artist');
		await expect(caption.getByRole('link', { name: 'Test Artist' })).toHaveAttribute(
			'href',
			'/gallery?artist=Test%20Artist'
		);
		await expect(data).not.toContainText('Ref sheet');

		// Socials open in a new tab and say so.
		const instagram = data.getByRole('link', { name: 'Instagram (opens in a new tab)' });
		await expect(instagram).toHaveAttribute('target', '_blank');
		await expect(instagram).toHaveAttribute('rel', 'noopener noreferrer');
	});

	// The pool is SFW only, so the piece of the day is always the link preview.
	test('advertises the piece of the day as the link preview', async ({ page }) => {
		await page.goto('/');

		const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
		expect(ogImage).toMatch(/\/e2e-avatar\.svg$/);
	});

	// The mock puts the card 28px below the header on desktop and 16px below
	// the top on mobile, where the header is hidden.
	test('places the card where the mock does', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		const gap = await page.evaluate(
			() =>
				document.querySelector('.book')!.getBoundingClientRect().top -
				document.querySelector('header')!.getBoundingClientRect().bottom
		);
		expect(gap).toBe(28);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		const top = await page.evaluate(() => document.querySelector('.book')!.getBoundingClientRect().top);
		expect(top).toBe(16);
	});

	// With the Stamps heading hidden and no note under it, the stamps page's
	// first visible item sits level with the data page's "Passport" label: the
	// Here now stamp when a convention is live, otherwise the "On this site"
	// label. The fixture has a live convention, so the second half takes the
	// Here now stamp out of the page to reach the other state.
	test('starts the stamps page level with the Passport label', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		const tops = () =>
			page.evaluate(() => ({
				passport: document.querySelector('.page--data .page-label')!.getBoundingClientRect().top,
				stamps: document.querySelector('.page--stamps')!.getBoundingClientRect().top,
				live: document.querySelector('.page--stamps .live')?.getBoundingClientRect().top ?? null,
				site: document.querySelector('#pp-site')!.getBoundingClientRect().top
			}));
		let t = await tops();
		expect(t.live).toBe(t.passport);
		// 28px of page padding, as in the mock.
		expect(t.passport - t.stamps).toBe(28);

		await page.evaluate(() => document.querySelector('.page--stamps .live')!.remove());
		t = await tops();
		expect(t.site).toBe(t.passport);

		// On a phone the stamps page sits under the data page, and its first
		// item starts at the mock's 20px page padding.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		t = await tops();
		expect(t.live! - t.stamps).toBe(21);
		await page.evaluate(() => document.querySelector('.page--stamps .live')!.remove());
		t = await tops();
		expect(t.site - t.stamps).toBe(21);
	});

	// The name steps down from 36px to the mock's 28px on a phone-width page,
	// and a stamp's kicker and its date keep the mock's 1.5 line height (12px
	// on 18px, 14px on 21px).
	test('sizes the name and the stamp lines as the mock does', async ({ page }) => {
		const measure = () =>
			page.evaluate(() => ({
				name: getComputedStyle(document.querySelector('h1.name')!).fontSize,
				kicker: getComputedStyle(document.querySelector('.stamp .kicker')!).lineHeight,
				date: getComputedStyle(document.querySelector('.stamp .date')!).lineHeight,
				// The mock's font shorthand resets the Elsewhere rows to normal.
				socials: getComputedStyle(document.querySelector('.socials')!).lineHeight
			}));
		const lines = { kicker: '18px', date: '21px', socials: 'normal' };

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		expect(await measure()).toEqual({ name: '28px', ...lines });

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/');
		expect(await measure()).toEqual({ name: '36px', ...lines });
	});

	test('renders every stamp as a link named for its feature and count', async ({ page }) => {
		await page.goto('/');

		// The heading names the region for screen readers and shows nothing, and
		// no note sits under it.
		const stamps = page.getByRole('region', { name: 'Stamps', exact: true });
		const heading = stamps.getByRole('heading', { level: 2, name: 'Stamps', exact: true });
		await expect(heading).toHaveCount(1);
		await expect(heading).toHaveClass(/\bsr-only\b/);
		await expect(heading).toHaveCSS('clip', 'rect(0px, 0px, 0px, 0px)');
		expect(await heading.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
		await expect(page.getByText('Each stamp opens that part of the site.')).toHaveCount(0);

		// The live convention leads the page, linked to /connect.
		const live = stamps.getByRole('link', { name: /^Here now: E2E Live Con, Denver, CO, until / });
		await expect(live).toHaveAttribute('href', '/connect');

		const site = stamps.getByRole('list', { name: 'On this site' });
		await expect(site.getByRole('link')).toHaveCount(4);
		await expect(site.getByRole('link', { name: 'Gallery, 4 pieces by 1 artist' })).toHaveAttribute('href', '/gallery');
		const fursuit = site.getByRole('link', { name: 'Fursuit photos, 1 photo by 1 photographer' });
		await expect(fursuit).toHaveAttribute('href', '/gallery?view=fursuit');
		await expect(fursuit).toHaveClass(/stamp--rect/);
		await expect(site.getByRole('link', { name: 'VR avatars, 4 avatars' })).toHaveAttribute('href', '/vr');
		await expect(site.getByRole('link', { name: 'About, Links and upcoming conventions' })).toHaveAttribute('href', '/about');

		// No sticker pack and no collection in this fixture: those stamps are
		// absent, never shown with a zero.
		await expect(stamps.getByRole('link', { name: /Stickers|Collections/ })).toHaveCount(0);
		await expect(stamps).not.toContainText(/\b0 /);

		// Next (dashed) before the past event; the live convention is not
		// repeated here.
		const cons = stamps.getByRole('list', { name: 'Conventions' });
		await expect(cons.getByRole('link')).toHaveCount(2);
		const next = cons.getByRole('link').nth(0);
		await expect(next).toHaveAccessibleName(/^Next: E2E Next Con, [A-Z][a-z]{2} \d{4}$/);
		await expect(next).toHaveAttribute('href', '/connect');
		await expect(next).toHaveClass(/stamp--next/);
		const past = cons.getByRole('link').nth(1);
		await expect(past).toHaveAccessibleName('E2E Past Con 2025, Jun 2025, 1 photo');
		await expect(past).toHaveAttribute('href', '/gallery?view=fursuit&event=E2E%20Past%20Con%202025');
		await expect(past).toHaveClass(/stamp--past/);
		await expect(cons).not.toContainText('E2E Live Con');
		await expect(stamps.getByText('This passport has no stamps yet.')).toHaveCount(0);
	});

	// Japanese punctuates the accessible names and the caption with its own
	// full-width forms, and runs on after 。 with no space. The paraglide locale
	// cookie switches the SSR locale, as in vr-guide.spec.ts.
	test('punctuates the stamps and the caption for Japanese', async ({ page }) => {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

		const stamps = page.getByRole('region', { name: '査証', exact: true });
		await expect(
			stamps.getByRole('link', { name: 'ギャラリー、作品 4点、アーティスト 1人', exact: true })
		).toHaveAttribute('href', '/gallery');
		const next = stamps.locator('a.stamp--next');
		await expect(next).toHaveAccessibleName(/^次回：E2E Next Con、\d{4}年\d{1,2}月$/);
		// The place keeps its own ASCII comma, so a space, not a 読点, joins it to
		// the date.
		await expect(stamps.locator('a.stamp--live')).toHaveAccessibleName(
			/^参加中：E2E Live Con、Denver, CO \d{1,2}月\d{1,2}日\(.\)まで$/
		);
		// The About line's zero-width space is a visual break point only: the
		// visible text keeps it, the spoken name drops it. toHaveAccessibleName
		// and toHaveText strip U+200B before comparing, so the raw attribute and
		// textContent are what show the strip happened.
		const about = stamps.locator('a[href="/about"]');
		await expect(about).toHaveAttribute('aria-label', 'サイトについて、リンクと参加予定のコン');
		const raw = await about.evaluate((el) => ({
			label: el.getAttribute('aria-label') ?? '',
			line: el.querySelector('.line')?.textContent ?? ''
		}));
		expect(raw.label).not.toContain('\u200b');
		expect(raw.line).toBe('リンクと\u200b参加予定のコン');

		// The full-width colon runs straight on into the artist's name.
		const data = page.getByRole('region', { name: 'E2E', exact: true });
		await expect(data.locator('a.photo-frame')).toHaveAccessibleName('E2E Daily Piece');
		await expect(data.locator('figcaption')).toHaveText('作者：Test Artist');
		await expect(data).not.toContainText('設定画');
	});

	// The header and the phone tab bar say which page this is ("page") on the
	// Gallery itself, and only which section ("true") on a piece inside it. The
	// root and an unrelated page (About) mark only their own links. This is the
	// rendered check that the unit suite's source pins in
	// chrome-a11y-markup.test.ts stand in for.
	test('marks the Gallery nav links as the current page or the current section', async ({ page }) => {
		const links = () => [page.locator('header a.nav-link[href="/gallery"]'), page.locator('nav.mobile-nav a[href="/gallery"]')];
		const aboutLinks = () => [page.locator('header a.nav-link[href="/about"]'), page.locator('nav.mobile-nav a[href="/about"]')];

		await page.goto('/');
		await expect(page.locator('header a.logo')).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('nav.mobile-nav a[href="/"]')).toHaveAttribute('aria-current', 'page');
		for (const link of links()) await expect(link).not.toHaveAttribute('aria-current');

		await page.goto('/gallery');
		for (const link of links()) await expect(link).toHaveAttribute('aria-current', 'page');
		for (const link of aboutLinks()) await expect(link).not.toHaveAttribute('aria-current');
		// The card titles sit straight under the page h1, so they are h2s.
		await expect(page.locator('a.card h2.card-title').first()).toBeVisible();
		await expect(page.locator('a.card h3')).toHaveCount(0);

		await page.goto('/gallery/mature-ref-sheet');
		for (const link of links()) await expect(link).toHaveAttribute('aria-current', 'true');

		await page.goto('/about');
		for (const link of aboutLinks()) await expect(link).toHaveAttribute('aria-current', 'page');
		for (const link of links()) await expect(link).not.toHaveAttribute('aria-current');
	});

	// The gallery's filter row: every input and select has a name, the view toggle says
	// which view is on without colour, and the view switch is plain buttons and
	// links marked like the nav, not a tablist with no tabpanels.
	test('names the gallery filters and marks the current view and layout', async ({ page }) => {
		await page.goto('/gallery');
		for (const name of ['Tag', 'Artist', 'Character', 'Sort by']) {
			await expect(page.getByRole('combobox', { name, exact: true })).toBeVisible();
		}
		// The artist list's empty state is a translated message.
		const artist = await expectArtistEmptyState(page, 'Artist', 'No matching artists');
		// The listbox's children are options: the empty state is one that can't be
		// picked, and no bare list item sits between the listbox and its options.
		const empty = page.getByRole('option', { name: 'No matching artists' });
		await expect(empty).toBeVisible();
		await expect(empty).toHaveAttribute('aria-disabled', 'true');
		await artist.fill('');
		await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
		await expect(page.getByRole('listbox').getByRole('listitem')).toHaveCount(0);
		await artist.press('Escape');
		await expect(page.getByRole('searchbox', { name: 'Search artworks', exact: true })).toBeVisible();
		await expect(page.locator('.filters :is(input, select):not([aria-label])')).toHaveCount(0);
		// The search and artist-chevron icons are decorative, so they stay out of
		// the accessibility tree instead of reading as unnamed images.
		await expect(page.locator('.filters :is(.search-wrapper, .combobox)').getByRole('img')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'false');
		// The toggle is a client action: retry until the click lands after
		// hydration. A second click on List view is harmless.
		await expect(async () => {
			await page.getByRole('button', { name: 'List view' }).click();
			await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true', { timeout: 1000 });
		}).toPass();
		await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'false');

		const tabs = page.locator('.tabs');
		await expect(page.getByRole('tablist')).toHaveCount(0);
		await expect(tabs.getByRole('button', { name: 'Artwork' })).toHaveAttribute('aria-current', 'page');
		await expect(tabs.locator('[aria-current]')).toHaveCount(1);

		await page.goto('/gallery?view=fursuit');
		await expect(tabs.getByRole('button', { name: 'Fursuit Photos' })).toHaveAttribute('aria-current', 'page');
		await expect(tabs.locator('[aria-current]')).toHaveCount(1);
		for (const name of ['Photographer', 'Event']) {
			await expect(page.getByRole('combobox', { name, exact: true })).toBeVisible();
		}

		// Japanese gets its own empty-state message, not the English one.
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		await page.goto('/gallery');
		await expectArtistEmptyState(page, 'アーティスト', '一致するアーティストはいません');
	});

	// Strict line-break gives way when a word cannot fit its box, so at 320px
	// with 200% text the oval must be roomy enough for "ギャラリー" on one line.
	test('never starts a line of the Japanese Gallery oval with the long-vowel mark', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		await page.goto('/');
		await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
		const name = page.locator('a.stamp--oval .name');
		await expect(name).toHaveText('ギャラリー');
		const lineStarts = await name.evaluate((el) => {
			const text = el.firstChild as Text;
			const starts: string[] = [];
			let top: number | null = null;
			for (let i = 0; i < text.length; i++) {
				const range = document.createRange();
				range.setStart(text, i);
				range.setEnd(text, i + 1);
				const t = range.getClientRects()[0]?.top ?? 0;
				if (top === null || t > top + 1) starts.push(text.data[i]);
				top = t;
			}
			return starts;
		});
		expect(lineStarts).not.toContain('ー');
	});

	// The language buttons' ring as rendered, not just as written in the CSS
	// source. Tab there for real: :focus-visible does not match a programmatic
	// .focus(), which would make the ring assertion vacuous.
	test('rings a keyboard-focused language button in the foreground colour', async ({ page }) => {
		await page.goto('/');
		let reached = false;
		for (let i = 0; i < 40 && !reached; i++) {
			await page.keyboard.press('Tab');
			reached = await page.evaluate(() => !!document.activeElement?.matches('.lang-toggle button'));
		}
		expect(reached).toBe(true);
		const ring = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement;
			const style = getComputedStyle(el);
			// Resolve --foreground to the same rgb() form outline-color computes to.
			const probe = document.createElement('div');
			probe.style.color = 'var(--foreground)';
			document.body.append(probe);
			const foreground = getComputedStyle(probe).color;
			probe.remove();
			return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, foreground };
		});
		expect(ring).toEqual({ style: 'solid', width: '2px', color: ring.foreground, foreground: ring.foreground });
		expect(ring.foreground).not.toBe('rgba(0, 0, 0, 0)');
	});
});

test.describe('fresh-site passport', () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== 'passport-empty', 'runs on the fresh-site passport server');
	});

	test('shows one page: the profile picture, the name and host, and no stamps', async ({ page }) => {
		await page.goto('/');

		await expect(page.locator('h1')).toHaveCount(1);
		const data = page.getByRole('region', { name: 'E2E', exact: true });
		await expect(data.locator('.photo-frame img')).toHaveAttribute('alt', 'E2E, profile picture');
		await expect(data.locator('.photo-frame a, a.photo-frame')).toHaveCount(0);
		await expect(data.locator('figcaption')).toHaveText('Profile picture, unattributed');
		await expect(data.locator('dl')).toContainText(new URL(page.url()).host);
		// Unset rows are not rendered at all.
		await expect(data).not.toContainText('Pronouns');
		await expect(data).not.toContainText('Species');
		await expect(data).not.toContainText('Elsewhere');
		await expect(data).not.toContainText('Commissioning since');
		// The shipped default about sentence stays hidden.
		await expect(data).not.toContainText('A personal gallery for collecting');

		const stamps = page.getByRole('region', { name: 'Stamps', exact: true });
		await expect(stamps.getByText('This passport has no stamps yet.')).toBeVisible();
		// The mock's body line height, 1.5 of 16px.
		await expect(stamps.locator('.stamps-empty')).toHaveCSS('font-size', '16px');
		await expect(stamps.locator('.stamps-empty')).toHaveCSS('line-height', '24px');
		await expect(stamps.getByRole('link')).toHaveCount(0);
		await expect(stamps.getByRole('heading', { level: 3 })).toHaveCount(0);
		await expect(page.locator('.book')).toHaveClass(/book--single/);
	});
});
