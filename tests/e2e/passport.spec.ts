import { test, expect } from '@playwright/test';

// The passport homepage (landingLayout = 'passport'), end to end. This file runs
// under two projects, each on its own seeded server (see playwright.config.ts):
//
//   passport        the shared fixture plus fixtures/passport.sql: an NSFW
//                   designated ref sheet, three published pieces by one artist,
//                   four published VR avatars, two socials, a confirmed
//                   convention running today and one upcoming, and one fursuit
//                   photo from a past event (FurTrack in mock mode).
//   passport-empty  the same fixture with every piece, avatar, convention,
//                   social and the pronouns taken away (fixtures/
//                   passport-empty.sql): a fresh fork.
//
// Read-only throughout: no login and no writes. This asserts markup, never
// pixels.

test.describe('populated passport', () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== 'passport', 'runs on the populated passport server');
	});

	test('renders the data page: one h1, the details, and the blurred NSFW ref sheet', async ({ page }) => {
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

		// The designated ref sheet is NSFW: linked to its piece page, blurred,
		// labelled, eager, and with no reveal button inside the link.
		const picture = data.locator('a.photo-frame');
		await expect(picture).toHaveAttribute('href', '/gallery/mature-ref-sheet');
		const img = picture.locator('img');
		await expect(img).toHaveClass(/blurred/);
		await expect(img).toHaveAttribute('loading', 'eager');
		await expect(img).toHaveAttribute('fetchpriority', 'high');
		await expect(picture.locator('.gate')).toHaveText('NSFW');
		await expect(picture.locator('button')).toHaveCount(0);
		await expect(data.locator('figcaption')).toContainText('Ref sheet. Art by Test Artist');

		// Socials open in a new tab and say so.
		const instagram = data.getByRole('link', { name: 'Instagram (opens in a new tab)' });
		await expect(instagram).toHaveAttribute('target', '_blank');
		await expect(instagram).toHaveAttribute('rel', 'noopener noreferrer');
	});

	// A link preview shows no blur, so the NSFW ref sheet never becomes the
	// og:image: the admin avatar stands in.
	test('advertises the admin avatar, not the NSFW ref sheet, as the link preview', async ({ page }) => {
		await page.goto('/');

		const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
		expect(ogImage).toMatch(/\/e2e-face\.png$/);
		expect(ogImage).not.toContain('e2e-avatar.svg');
	});

	test('renders every stamp as a link named for its feature and count', async ({ page }) => {
		await page.goto('/');

		const stamps = page.getByRole('region', { name: 'Stamps', exact: true });
		await expect(stamps.getByText('Each stamp opens that part of the site.')).toBeVisible();

		// The live convention leads the page, linked to /connect.
		const live = stamps.getByRole('link', { name: /^Here now: E2E Live Con, Denver, CO, until / });
		await expect(live).toHaveAttribute('href', '/connect');

		const site = stamps.getByRole('list', { name: 'On this site' });
		await expect(site.getByRole('link')).toHaveCount(4);
		await expect(site.getByRole('link', { name: 'Gallery, 3 pieces by 1 artist' })).toHaveAttribute('href', '/gallery');
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
	test('punctuates the stamps, the NSFW picture and the caption for Japanese', async ({ page }) => {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

		const stamps = page.getByRole('region', { name: '査証', exact: true });
		await expect(
			stamps.getByRole('link', { name: 'ギャラリー、作品 3点、アーティスト 1人', exact: true })
		).toHaveAttribute('href', '/gallery');
		const next = stamps.locator('a.stamp--next');
		await expect(next).toHaveAccessibleName(/^次回：E2E Next Con、\d{4}年\d{1,2}月$/);
		// The place keeps its own ASCII comma, so a space, not a 読点, joins it to
		// the date.
		await expect(stamps.locator('a.stamp--live')).toHaveAccessibleName(
			/^参加中：E2E Live Con、Denver, CO \d{1,2}月\d{1,2}日\(.\)まで$/
		);
		// The About line's zero-width space is a visual break point only: the
		// visible text keeps it, the spoken name drops it.
		const about = stamps.locator('a[href="/about"]');
		await expect(about).toHaveAccessibleName('サイトについて、リンクと参加予定のコン');
		await expect(about.locator('.line')).toHaveText('リンクと\u200b参加予定のコン');

		const data = page.getByRole('region', { name: 'E2E', exact: true });
		await expect(data.locator('a.photo-frame')).toHaveAccessibleName(/、NSFW$/);
		await expect(data.locator('figcaption')).toContainText('設定画。作者');
	});

	// The header and the phone tab bar say which page this is ("page") on the
	// Gallery itself, and only which section ("true") on a piece inside it.
	test('marks the Gallery nav links as the current page or the current section', async ({ page }) => {
		const links = () => [page.locator('header a.nav-link[href="/gallery"]'), page.locator('nav.mobile-nav a[href="/gallery"]')];

		await page.goto('/gallery');
		for (const link of links()) await expect(link).toHaveAttribute('aria-current', 'page');
		// The card titles sit straight under the page h1, so they are h2s.
		await expect(page.locator('a.card h2.card-title').first()).toBeVisible();
		await expect(page.locator('a.card h3')).toHaveCount(0);

		await page.goto('/gallery/mature-ref-sheet');
		for (const link of links()) await expect(link).toHaveAttribute('aria-current', 'true');
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
		await expect(stamps.getByRole('link')).toHaveCount(0);
		await expect(stamps.getByRole('heading', { level: 3 })).toHaveCount(0);
		await expect(page.locator('.book')).toHaveClass(/book--single/);
	});
});
