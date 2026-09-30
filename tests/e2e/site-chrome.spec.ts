import { test, expect, type Locator, type Page } from '@playwright/test';
import { adminLogin, gotoAfterLogin } from './admin-login';
import {
	expectHeaderToggles,
	expectHeaderTogglesWork,
	expectSkipLinkReachesMain,
	firstTabStop,
	navRowCount,
	resolveStyle,
	serveScaled,
	THEME_NAME,
	waitForNavHeight
} from './site-chrome-helpers';

// Site-chrome accessibility and seed checks from the SONA-229 review, on the
// shared read-only server. No writes; the admin checks sign in with the legacy
// password and only read.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// One URL per layout that renders a <main>: the (public) layout, the mosaic
// homepage (which escapes that layout), the (paths) layout, the connect QR
// page (no nav at all, so the skip link is its only chrome), the auth-exempt
// admin pages, and the root error page. The sign-in page autofocuses its
// password field, so the keyboard starts there and the skip link is the stop
// just before it.
const PAGES: { name: string; url: string; status: number; autofocus?: string }[] = [
	{ name: 'gallery', url: '/gallery', status: 200 },
	{ name: 'homepage', url: '/', status: 200 },
	{ name: 'connect page', url: '/connect', status: 200 },
	{ name: 'connect QR page', url: '/connect/qr', status: 200 },
	{ name: 'admin sign-in', url: '/admin/login', status: 200, autofocus: 'Password' },
	{ name: 'not-found page', url: '/no-such-page-e2e', status: 404 }
];

for (const { name, url, status, autofocus } of PAGES) {
	test(`the ${name} starts with a skip link that moves focus into the main content`, async ({ page }) => {
		const res = await page.goto(url);
		expect(res?.status()).toBe(status);
		await expectSkipLinkReachesMain(page, { autofocus });
	});
}

// The signed-in admin shell is its own layout, with the sidebar ahead of its
// main landmark.
test('the signed-in admin shell starts with a skip link that moves focus into the main content', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);
	await gotoAfterLogin(page, '/admin/images');
	await expectSkipLinkReachesMain(page, { main: 'main.admin-content#main-content' });
});

// WCAG 1.4.4 and 1.4.10 on the admin images page: the floating upload button
// shows only on phones and sits above the bottom nav by the same clearance the
// layouts use, so at 320px with 200% text it must still clear the taller bar.
// Japanese, because at 200% the four English tabs fit one row.
test('the admin upload button clears the wrapped bottom nav at 320px and 200% text', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.setViewportSize({ width: 320, height: 800 });
	await gotoAfterLogin(page, '/admin/images');
	await expect(page.locator('.fab')).toBeVisible();
	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	await waitForNavHeight(page);

	const rows = await navRowCount(page);
	const m = await page.evaluate(() => {
		const nav = document.querySelector('nav.mobile-nav') as HTMLElement;
		return {
			fabBottom: document.querySelector('.fab')!.getBoundingClientRect().bottom,
			navTop: nav.getBoundingClientRect().top,
			navHeight: nav.offsetHeight,
			scrollPadding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom)
		};
	});
	expect(rows, 'the bar wraps at this size, or this test proves nothing').toBeGreaterThan(1);
	expect(m.fabBottom).toBeLessThanOrEqual(m.navTop);
	// A focused control scrolls clear of the whole wrapped bar, not a one-row
	// one, with 6px more for its focus ring.
	expect(m.scrollPadding).toBe(m.navHeight + 6);
});

/**
 * Tab from `before` onto `target` while `target` sits partly or wholly behind
 * the bottom nav, and check the browser scrolls its whole focus ring (the box
 * grown by the outline's offset and width) clear above the bar.
 */
async function expectTabbedRingClearsNav(page: Page, before: Locator, target: Locator) {
	await before.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
	// Put the target's top just under the bar's top edge. The browser clamps
	// the scroll, so on a short page it may not get all the way there.
	await target.evaluate((el) => {
		const navTop = document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top;
		window.scrollBy(0, el.getBoundingClientRect().top + 1 - navTop);
	});
	const start = await target.evaluate((el) => ({
		bottom: el.getBoundingClientRect().bottom,
		navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top
	}));
	expect(start.bottom, 'the target starts behind the bar, or this test proves nothing').toBeGreaterThan(
		start.navTop
	);
	await page.keyboard.press('Tab');
	await expect(target).toBeFocused();
	const m = await target.evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			ringBottom: el.getBoundingClientRect().bottom + parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth),
			navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top
		};
	});
	expect(m.ringBottom).toBeLessThanOrEqual(m.navTop);
}

// A keyboard user tabbing to the last gallery card sees its whole focus ring:
// the bottom of the ring (2px offset, 2px wide), not just the bottom of the
// card, ends at or above the wrapped bottom nav.
test('the last gallery card scrolls its focus ring clear of the wrapped bottom nav', async ({ page }) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.setViewportSize({ width: 320, height: 800 });
	await page.goto('/gallery');
	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	await waitForNavHeight(page);
	const cards = page.locator('.grid a.card');
	await expectTabbedRingClearsNav(page, cards.nth((await cards.count()) - 2), cards.last());
});

// The same for the "made with" badge at the foot of the page, whose ring sits
// 3px out and is 2px wide.
for (const locale of ['en', 'ja']) {
	test(`the ${locale} "made with" badge scrolls its focus ring clear of the bottom nav`, async ({ page }) => {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/gallery');
		await waitForNavHeight(page);
		const credit = page.locator('footer.mobile-credit');
		await expectTabbedRingClearsNav(page, credit.locator('.legal-links a').last(), credit.locator('a.sona-badge'));
	});
}

test('the skip link is translated', async ({ page }) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.goto('/gallery');
	expect(await firstTabStop(page)).toEqual({ className: 'skip-link', text: '本文へスキップ' });
});

// WCAG 1.3.1: a heading outline that jumps from h1 to h3 tells a screen-reader
// user a level is missing. The section labels must stay the same small caps
// they were, so the rendered size is checked too. Every optional section is
// named on the piece that renders it, so a section missing from the seed fails
// here instead of passing unchecked: variant-piece carries a source link, a
// featured character and the variant strip, and ref-sheet carries a tag.
const PIECE_SECTIONS = [
	{ url: '/gallery/variant-piece', sections: ['Source', 'Featured Characters', 'Details', 'Variants'] },
	{ url: '/gallery/ref-sheet', sections: ['Tags', 'Details'] }
];

for (const { url, sections } of PIECE_SECTIONS) {
	test(`the piece page heading outline never skips a level on ${url}`, async ({ page }) => {
		await page.goto(url);
		const levels = await page
			.locator('main h1, main h2, main h3, main h4, main h5, main h6')
			.evaluateAll((els) => els.map((el) => Number(el.tagName.slice(1))));
		expect(levels[0]).toBe(1);
		for (let i = 1; i < levels.length; i++) {
			expect(levels[i], `heading ${i} (h${levels[i]}) follows an h${levels[i - 1]}`).toBeLessThanOrEqual(
				levels[i - 1] + 1
			);
		}

		for (const name of sections) {
			const heading = page.locator('main').getByRole('heading', { name, exact: true });
			await expect(heading).toHaveJSProperty('tagName', 'H2');
			const look = await heading.evaluate((el) => {
				const s = getComputedStyle(el);
				return { size: s.fontSize, transform: s.textTransform };
			});
			expect(look, `the ${name} heading keeps its small-caps look`).toEqual({
				size: '12px',
				transform: 'uppercase'
			});
		}
	});
}

// The seed points each gallery row's thumbnail at the local image route, and
// seed.ts puts the fixture PNG into the bucket under each of those keys. A key
// missing from the bucket shows up here as a card whose image never decodes.
test('every seeded gallery thumbnail loads', async ({ page }) => {
	await page.goto('/gallery');
	const imgs = page.locator('.grid img');
	await expect(imgs.first()).toBeVisible();
	const count = await imgs.count();
	expect(count).toBeGreaterThan(0);
	for (let i = 0; i < count; i++) {
		const img = imgs.nth(i);
		await img.scrollIntoViewIfNeeded();
		await expect(img).toHaveAttribute('src', /-thumb\.png$/);
		await expect
			.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
				message: `thumbnail ${i} decoded`
			})
			.toBe(true);
	}
});

// Both main navs are named "Main" through the message catalog, and only the one
// on screen is in the accessibility tree: the bottom bar on a phone, the
// header's links on a desktop. A dropped or hardcoded label fails the lookup by
// name, and a nav that stays exposed while hidden fails the count.
for (const { locale, name } of [
	{ locale: 'en', name: 'Main' },
	{ locale: 'ja', name: 'メイン' }
]) {
	test(`the ${locale} main nav is named on a phone and on a desktop`, async ({ page }) => {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		const main = page.getByRole('navigation', { name, exact: true });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/gallery');
		await expect(main).toHaveCount(1);
		await expect(main).toHaveClass(/(^|\s)mobile-nav(\s|$)/);
		// The header's own links are hidden on a phone, not just unnamed.
		const headerLinks = page.getByRole('banner').locator('nav');
		await expect(headerLinks).toHaveCount(1);
		await expect(headerLinks).toBeHidden();

		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(main).toHaveCount(1);
		await expect(main).toBeVisible();
		expect(await main.evaluate((el) => el.parentElement?.closest('header') !== null)).toBe(true);
	});
}

// On a phone the bottom nav holds destinations only, and the theme and
// language toggles sit in the page's one header. Every layout with a bottom nav
// is covered: the (public) layout, the homepage that re-renders its chrome, and
// the (paths) layout's own top bar. The toggles must be there and must work.
// /share shares /art's and /connect's layout, but it 404s on this seed, which
// has no fursuit photos.
const PHONE_PAGES = ['/', '/gallery', '/about', '/art', '/connect'];

for (const url of PHONE_PAGES) {
	test(`${url} keeps the theme and language toggles in its one header on a phone`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const res = await page.goto(url);
		expect(res?.status()).toBe(200);
		await waitForNavHeight(page);
		if (url === '/art' || url === '/connect') {
			// The back arrow is a 24px target, and the wordmark keeps its place
			// after the 20px gutter, the 20px arrow and the 12px gap.
			const banner = page.getByRole('banner');
			const back = (await banner.getByRole('link', { name: 'Back home' }).boundingBox())!;
			expect(back.width).toBeGreaterThanOrEqual(24);
			expect(back.height).toBeGreaterThanOrEqual(24);
			expect((await banner.getByRole('link', { name: 'E2E TEST GALLERY' }).boundingBox())!.x).toBe(52);
		}
		await expectHeaderTogglesWork(page);
	});
}

// The theme button's name is translated too.
test('the theme button is named in Japanese', async ({ page }) => {
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	await page.goto('/gallery');
	await waitForNavHeight(page);
	const theme = page.getByRole('banner').getByRole('button', { name: /^(ライト|ダーク)テーマに切り替え$/ });
	const before = await theme.getAttribute('aria-label');
	await theme.click();
	await expect(theme).toHaveAccessibleName(
		before === 'ライトテーマに切り替え' ? 'ダークテーマに切り替え' : 'ライトテーマに切り替え'
	);
});

// The (paths) layout's back arrow has no visible text, so its name carries the
// meaning, in the reader's language.
for (const { locale, name } of [
	{ locale: 'en', name: 'Back home' },
	{ locale: 'ja', name: 'ホームに戻る' }
]) {
	test(`the ${locale} back link on /art is named in the page's language`, async ({ page }) => {
		await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
		await page.goto('/art');
		const back = page.getByRole('banner').getByRole('link', { name, exact: true });
		await expect(back).toHaveCount(1);
		await expect(back).toHaveAttribute('href', '/');
	});
}

// WCAG 1.4.10: a long one-word site name wraps in the (paths) top bar and in
// the public header, and the toggles move under it, instead of widening the
// page past a 320px screen. The seeded name, and the text size, are swapped in
// the served HTML. Script is off, so what is measured is that served page: the
// edit would fail the inline script's CSP hash, and hydration never runs.
test.describe('the phone header with a long site name', () => {
	test.use({ javaScriptEnabled: false });

	for (const { siteName, scale } of [
		{ siteName: 'Wolfgangsdenofartsx', scale: 1 },
		{ siteName: 'Supercalifragilisticexpialidociousfox', scale: 2 }
	]) {
		for (const url of ['/art', '/connect', '/gallery', '/']) {
			test(`${url} fits 320px at ${scale * 100}% text with a ${siteName.length}-character site name`, async ({
				page
			}, testInfo) => {
				await page.setViewportSize({ width: 320, height: 800 });
				await serveScaled(page, url, scale, (html) =>
					html.replaceAll('E2E Test Gallery', siteName).replaceAll('E2E TEST GALLERY', siteName.toUpperCase())
				);
				await page.goto(url);
				const banner = page.getByRole('banner');
				// The (paths) top bar sets the name in capitals; the public header does not.
				const shown = url === '/art' || url === '/connect' ? siteName.toUpperCase() : siteName;
				const name = banner.getByRole('link', { name: shown, exact: true });
				await expect(name).toBeVisible();

				await expectBannerFits(page);
				const nameBox = (await name.boundingBox())!;
				expect(nameBox.x).toBeGreaterThanOrEqual(0);
				expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(320);
				const m = await page.evaluate(() => {
					const header = document.querySelector('header')!;
					return {
						rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
						tops: ['[role="group"]', 'button.theme-toggle'].map(
							(sel) => header.querySelector(sel)!.getBoundingClientRect().top
						),
						headerHeight: header.getBoundingClientRect().height
					};
				});
				expect(m.rootSize).toBe(16 * scale);
				if (scale === 2) {
					// The name fills the row, so the toggles wrap under it rather than
					// squeezing it into a narrow column beside them.
					for (const top of m.tops) {
						expect(top, 'a toggle sits beside the name').toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
					}
				}
				if (scale === 2 && url === '/gallery') {
					// The public header's name grows with the text, and the header
					// grows with it rather than clipping it.
					expect(m.headerHeight).toBeGreaterThanOrEqual(56);
					const nameSize = () => name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
					const big = await nameSize();
					// Script is off, and addStyleTag waits on a load event that never
					// comes; a style element appended from the test does the same job.
					await page.evaluate(() => {
						const style = document.createElement('style');
						style.textContent = 'html { font-size: 100% !important; }';
						document.head.append(style);
					});
					expect(big).toBeCloseTo((await nameSize()) * 2, 1);
				}
				await page.screenshot({
					path: testInfo.outputPath(`phone-header-${url.slice(1) || 'home'}-${scale * 100}pct.png`)
				});
			});
		}
	}
});

// Before script publishes the bar's height, the scroll padding falls back to a
// rem size. At 200% text that fallback must still clear the whole bar plus the
// ring's 6px. Script is off, so the bar's height is never published, and the
// text size is swapped in the served HTML as in the long site name tests.
test.describe('the scroll padding before the nav publishes its height', () => {
	test.use({ javaScriptEnabled: false });

	for (const locale of ['en', 'ja']) {
		test(`the ${locale} fallback clears the bottom nav at 320px and 200% text`, async ({ page }) => {
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
			await page.setViewportSize({ width: 320, height: 800 });
			await serveScaled(page, '/gallery', 2);
			await page.goto('/gallery');
			await expect(page.locator('nav.mobile-nav')).toBeVisible();
			const m = await page.evaluate(() => {
				const root = getComputedStyle(document.documentElement);
				return {
					published: root.getPropertyValue('--mobile-nav-height'),
					rootSize: parseFloat(root.fontSize),
					padding: parseFloat(root.scrollPaddingBottom),
					navHeight: (document.querySelector('nav.mobile-nav') as HTMLElement).offsetHeight
				};
			});
			expect(m.published, 'the height is unpublished, or this test proves nothing').toBe('');
			expect(m.rootSize).toBe(32);
			expect(m.padding).toBeGreaterThanOrEqual(m.navHeight + 6);
		});
	}
});

// The phone header's side gutter matches the 16px the page content uses.
test('the phone header lines the site name up with the page gutter', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	const logo = await page.getByRole('banner').getByRole('link', { name: 'E2E Test Gallery' }).boundingBox();
	expect(logo!.x).toBe(16);
});

// The admin shell drops its sidebar on a phone and shows the same bottom nav,
// so its header has to stay for the toggles too.
test('the admin shell keeps the theme and language toggles on a phone', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoAfterLogin(page, '/admin/images');
	await expectHeaderToggles(page);
});

/**
 * The phone theme toggle at 320px: a 44px target at normal size and at 200%
 * text, with a painted circle smaller than the target that grows to fill it
 * once the text doubles. The circle is the button's content box, which is
 * where its fill is clipped. Its focus ring sits 2px from the circle at both
 * sizes, not from the larger target.
 */
async function expectThemeTarget(page: Page) {
	const theme = page.getByRole('banner').getByRole('button', { name: THEME_NAME });
	const circle = () =>
		theme.evaluate((el) => {
			const s = getComputedStyle(el);
			return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
		});
	const ringGap = () =>
		theme.evaluate((el) => {
			const s = getComputedStyle(el);
			return parseFloat(s.outlineOffset) + parseFloat(s.paddingLeft);
		});
	await page.keyboard.press('Shift');
	await theme.focus();
	expect(await theme.boundingBox()).toMatchObject({ width: 44, height: 44 });
	expect(await circle()).toBeLessThan(44);
	expect(await ringGap()).toBeCloseTo(2, 1);

	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	expect(await theme.boundingBox()).toMatchObject({ width: 44, height: 44 });
	expect(await circle()).toBe(44);
	expect(await ringGap()).toBeCloseTo(2, 1);
}

/** Nothing in the page's header runs off the side, and the page is no wider
 *  than the screen. */
async function expectBannerFits(page: Page) {
	const m = await page.evaluate(() => {
		const inside = [...document.querySelectorAll('header a, header button')].every((el) => {
			const r = el.getBoundingClientRect();
			return r.width === 0 || (r.left >= 0 && r.right <= innerWidth);
		});
		return { docWidth: document.documentElement.scrollWidth, vw: innerWidth, inside };
	});
	expect(m.docWidth).toBeLessThanOrEqual(m.vw);
	expect(m.inside).toBe(true);
}

// Every header that holds the theme toggle gives it the same phone target: the
// (public) header, the (paths) top bar and the admin header.
for (const url of ['/gallery', '/art']) {
	test(`the ${url} theme toggle keeps a 44px target on a phone`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.goto(url);
		await expectThemeTarget(page);
	});
}

// The admin header wraps at 200% text, so it is checked for fit too, and its
// avatar wraps with the toggles rather than onto a row of its own.
test('the admin theme toggle keeps a 44px target on a phone', async ({ page }, testInfo) => {
	const badgeSize = () =>
		page.locator('header .admin-badge').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	await adminLogin(page, PASSWORD);
	// On one row at 390px, the badge starts the header's content and the
	// toggles end it.
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoAfterLogin(page, '/admin/images');
	const edges = await page.evaluate(() => {
		const header = document.querySelector('header')!;
		const r = header.getBoundingClientRect();
		const s = getComputedStyle(header);
		return {
			start: r.left + parseFloat(s.paddingLeft),
			end: r.right - parseFloat(s.paddingRight),
			badgeLeft: document.querySelector('header .admin-badge')!.getBoundingClientRect().left,
			togglesRight: document.querySelector('header .admin-header-end')!.getBoundingClientRect().right
		};
	});
	expect(edges.badgeLeft).toBeCloseTo(edges.start, 0);
	expect(edges.togglesRight).toBeCloseTo(edges.end, 0);
	const badgeBase = await badgeSize();

	await page.setViewportSize({ width: 320, height: 800 });
	await expectThemeTarget(page);

	// The badge grows with the text.
	expect(await badgeSize()).toBeCloseTo(badgeBase * 2, 1);
	await expectBannerFits(page);
	const rows = await page.evaluate(() => {
		const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
		const mid = (sel: string) => box(sel).top + box(sel).height / 2;
		const header = document.querySelector('header')!;
		return {
			theme: mid('header .theme-toggle'),
			avatar: mid('header .admin-avatar'),
			badge: mid('header .admin-badge'),
			badgeLeft: box('header .admin-badge').left,
			contentStart: header.getBoundingClientRect().left + parseFloat(getComputedStyle(header).paddingLeft)
		};
	});
	expect(Math.abs(rows.badge - rows.theme), 'the header wraps, or this test proves nothing').toBeGreaterThan(1);
	// The badge stays at the start of its own row rather than drifting to the end.
	expect(rows.badgeLeft).toBeCloseTo(rows.contentStart, 0);
	expect(rows.avatar, 'the avatar shares a row with the theme toggle').toBeCloseTo(rows.theme, 0);
	await page.screenshot({ path: testInfo.outputPath('admin-header-320-200pct.png') });
});

// The theme toggle's hover shade shows: it differs from the resting circle and
// from the page, and on a phone it stays inside the circle rather than filling
// the 44px target. Both themes, since a token can match the page in one theme
// and the resting circle in the other.
for (const width of [390, 1280]) {
	test(`the theme toggle's hover shade shows at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto('/gallery');
		// The nav publishes its height once hydrated, even hidden on a wide
		// screen (as 0px), so this waits out hydration at both widths.
		await waitForNavHeight(page);
		await page.addStyleTag({ content: '.theme-toggle { transition: none !important; }' });
		const theme = page.getByRole('banner').getByRole('button', { name: THEME_NAME });
		const look = async () => ({
			...(await theme.evaluate((el) => {
				const s = getComputedStyle(el);
				return { clip: s.backgroundClip, fill: s.backgroundColor };
			})),
			background: (await resolveStyle(page, { 'background-color': 'var(--background)' }))['background-color']
		});

		for (let pass = 0; pass < 2; pass++) {
			await page.mouse.move(0, 0);
			const rest = await look();
			await theme.hover();
			const hovered = await look();
			expect(hovered.fill, 'hover differs from the page').not.toBe(hovered.background);
			expect(hovered.fill, 'hover differs from the resting circle').not.toBe(rest.fill);
			if (width <= 768) expect(hovered.clip).toBe('content-box');
			if (pass === 0) {
				const before = await page.locator('html').getAttribute('data-theme');
				await theme.click();
				await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
			}
		}
	});
}

/** The focused element draws the page's ring: an outline in var(--ring),
 *  resolved on a probe element so this holds on every theme. */
async function expectPageRing(target: Locator) {
	const expected = (await resolveStyle(target.page(), { color: 'var(--ring)' })).color;
	const ring = await target.evaluate((el) => {
		const s = getComputedStyle(el);
		return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor };
	});
	expect(ring.style).not.toBe('none');
	expect(ring.width).toBeGreaterThan(0);
	expect(ring.color).toBe(expected);
}

// A keyboard-focused theme toggle shows the page's ring, not the browser's.
test('a focused theme toggle shows the page focus ring', async ({ page }) => {
	await page.goto('/gallery');
	const theme = page.getByRole('banner').getByRole('button', { name: THEME_NAME });
	await page.keyboard.press('Shift');
	await theme.focus();
	await expectPageRing(theme);
});

// The language buttons' labels follow the text size, like the nav's.
test('the language toggle labels grow with the root font size', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	const label = page.getByRole('banner').getByRole('button', { name: 'EN' });
	const size = () => label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	const base = await size();
	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	expect(await size()).toBeCloseTo(base * 2, 1);
	// Tall enough to hit at normal size too.
	await page.addStyleTag({ content: 'html { font-size: 100% !important; }' });
	expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(26);
});

// The active tab is told apart by more than its hue: a mark under it that the
// other tabs lack. And a keyboard-focused tab rings inside the bar's edge.
test('the active bottom tab carries a mark and a focused tab rings inside the bar', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	const marks = await page.locator('nav.mobile-nav .tab').evaluateAll((tabs) =>
		tabs.map((t) => {
			const after = getComputedStyle(t, '::after');
			return {
				href: t.getAttribute('href'),
				painted: after.backgroundColor !== 'rgba(0, 0, 0, 0)' && after.backgroundColor !== 'transparent'
			};
		})
	);
	for (const mark of marks) {
		expect(mark.painted, `the mark on ${mark.href}`).toBe(mark.href === '/gallery');
	}

	// The page's ring is drawn, and its outer edge (the box grown by the
	// outline's offset and width) stays inside the bar's box.
	const about = page.locator('nav.mobile-nav a[href="/about"]');
	await page.keyboard.press('Shift');
	await about.focus();
	await expectPageRing(about);
	const inside = await about.evaluate((el) => {
		const s = getComputedStyle(el);
		const grow = parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
		const r = el.getBoundingClientRect();
		const nav = el.closest('nav')!.getBoundingClientRect();
		return (
			r.left - grow >= nav.left &&
			r.right + grow <= nav.right &&
			r.top - grow >= nav.top &&
			r.bottom + grow <= nav.bottom
		);
	});
	expect(inside, 'the ring runs past the bar').toBe(true);
});

// Forced colours drop author backgrounds. The active tab's mark must still
// differ from the other tabs' empty slots and from the bar behind it.
test('the active bottom tab keeps its mark in forced colours', async ({ page }) => {
	await page.emulateMedia({ forcedColors: 'active' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/gallery');
	const m = await page.evaluate(() => {
		const nav = document.querySelector('nav.mobile-nav')!;
		const tabs = [...nav.querySelectorAll('.tab')];
		const mark = (t: Element) => getComputedStyle(t, '::after').backgroundColor;
		return {
			active: mark(nav.querySelector('.tab.active')!),
			inactive: tabs.filter((t) => !t.classList.contains('active')).map(mark),
			bar: getComputedStyle(nav).backgroundColor
		};
	});
	expect(m.inactive.length).toBeGreaterThan(0);
	for (const other of m.inactive) expect(m.active).not.toBe(other);
	expect(m.active).not.toBe(m.bar);
});
