import { test, expect } from '@playwright/test';
import { adminLogin, gotoAfterLogin } from './admin-login';
import { expectSkipLinkReachesMain, firstTabStop, waitForNavHeight } from './site-chrome-helpers';

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
test('the admin upload button clears the wrapped bottom nav at 320px and 200% text', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.setViewportSize({ width: 320, height: 800 });
	await gotoAfterLogin(page, '/admin/images');
	await expect(page.locator('.fab')).toBeVisible();
	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	await waitForNavHeight(page);

	const m = await page.evaluate(() => {
		const tabs = [...document.querySelectorAll('nav.mobile-nav .tab')];
		return {
			rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
			fabBottom: document.querySelector('.fab')!.getBoundingClientRect().bottom,
			navTop: document.querySelector('nav.mobile-nav')!.getBoundingClientRect().top
		};
	});
	expect(m.rows, 'the bar wraps at this size, or this test proves nothing').toBeGreaterThan(1);
	expect(m.fabBottom).toBeLessThanOrEqual(m.navTop);
});

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

		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(main).toHaveCount(1);
		await expect(main).toBeVisible();
		expect(await main.evaluate((el) => el.parentElement?.closest('header') !== null)).toBe(true);
	});
}
