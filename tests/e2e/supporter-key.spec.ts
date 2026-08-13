import { test, expect, type Page } from '@playwright/test';
import { adminLogin } from './admin-login';

// Supporter-key settings flow (SONA-105): the Account tab's empty state renders
// (explainer + Key field), a garbage key is rejected with the invalid error AND
// the correct aria wiring (aria-invalid + aria-describedby → the error's id), and
// a real-signature-but-expired key is rejected with the distinct expired error.
//
// The expired token below was signed by the REAL production private key (which
// lives only on sona.fast) — reaching the expired error, not the invalid one,
// exercises signature verification against the baked-in public key end to end.
// It's exp 1752710400 (in the past), so it's useless to a freeloader; the unit
// test supporter-key.test.ts documents it as the key-rotation tripwire.
//
// Neither submission persists (both fail validation before setRawSetting), so
// this spec doesn't mutate the shared e2e DB.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

// Real-key-signed, already-expired token (see supporter-key.test.ts).
const EXPIRED_TOKEN =
	'eyJ2IjoxLCJsb2dpbiI6Imtub3duLWFuc3dlciIsInRpZXIiOjgsImV4cCI6MTc1MjcxMDQwMH0.fr25p4GX1PXoTdqBTBTYQImZGdGKo13I5GDil_KXNi2dDVxBQaNiLQ5sGoVcapBmjPxV-0ADYAKCaFP-_CDTDA';

async function login(page: Page) {
	await adminLogin(page, PASSWORD);
}

const keyInput = (page: Page) => page.locator('input[name="supporterKey"]');
const saveButton = (page: Page) =>
	page.locator('form[action="?/saveSupporterKey"] button[type="submit"]');
const fieldError = (page: Page) => page.locator('.field-error#supporter-key-error');

// The account sections are hidden by CSS until the Account tab is active, and the
// tab toggle is client JS — so the click only "takes" once hydrated. Retry the
// whole click-until-visible like the palette spec's hydration-sensitive steps.
async function openAccountTab(page: Page) {
	await expect(async () => {
		await page.getByRole('tab', { name: 'Account', exact: true }).click();
		await expect(keyInput(page)).toBeVisible({ timeout: 1500 });
	}).toPass();
}

test.describe('admin settings supporter key', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
		await openAccountTab(page);
	});

	test('the empty state renders the explainer and the Key field', async ({ page }) => {
		await expect(page.getByText(/New features ship in an early-access window/)).toBeVisible();
		await expect(keyInput(page)).toBeVisible();
		// The eyebrow follows the fork's theme conventions, not sona.fast marketing
		// chrome: no "//" slash prefix (that device belongs to the marketing site).
		const eyebrow = page.locator('.key-eyebrow').first();
		await expect(eyebrow).toBeVisible();
		await expect(eyebrow).not.toContainText('//');
	});

	test('a garbage key shows the invalid error with the correct aria wiring', async ({ page }) => {
		await keyInput(page).fill('not-a-real-key');
		await saveButton(page).click();

		await expect(fieldError(page)).toHaveText(
			/That key didn't validate — make sure you copied the whole thing\./
		);
		// The aria-wiring the test gate demanded: the input points screen readers at
		// the just-rendered error via aria-describedby, and marks itself invalid.
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
		await expect(keyInput(page)).toHaveAttribute('aria-describedby', 'supporter-key-error');
	});

	test('a real-signature-but-expired key shows the distinct expired error', async ({ page }) => {
		await keyInput(page).fill(EXPIRED_TOKEN);
		await saveButton(page).click();

		// Distinct from the invalid copy — proves the signature verified against the
		// baked public key (reached the expiry check, not bad-signature).
		await expect(fieldError(page)).toHaveText(/That key expired .* re-mint at sona\.fast\/supporter-key\./);
		await expect(keyInput(page)).toHaveAttribute('aria-invalid', 'true');
	});
});

test.describe('admin settings supporter key — UTC viewer', () => {
	// Pinned, not inherited: without this the runner's own zone decides the date
	// and the test passes or fails by geography.
	test.use({ timezoneId: 'UTC' });

	test('a UTC browser gets the UTC calendar day', async ({ page }) => {
		await login(page);
		await page.goto('/admin/settings');
		await openAccountTab(page);
		await keyInput(page).fill(EXPIRED_TOKEN);
		await saveButton(page).click();

		// The token's last covered instant is 2025-07-16T23:59:59Z.
		await expect(fieldError(page)).toContainText('2025.07.16');
	});
});

// SONA-119: the operator's zone reaches the server through a cookie the admin
// layout writes on every signed-in navigation, and the server renders every
// expiry date in it. This drives the whole round trip in a real browser — the
// unit tests only ever feed the server a hand-written cookie, so nothing else
// would catch the client half silently breaking (wrong cookie name, wrong path,
// a throwing Intl call) and leaving every operator on UTC, which is the very bug
// SONA-119 exists to fix.
//
// The expired token's last covered instant is 2025-07-16T23:59:59Z: still the
// 16th in UTC, already the 17th in Tokyo. One date tells the two apart.
test.describe('admin settings supporter key — viewer timezone', () => {
	test.use({ timezoneId: 'Asia/Tokyo' });

	test('the sign-in screen alone plants no operator cookie', async ({ page, context }) => {
		// The cookie is the operator's, scoped to /admin — an anonymous visitor who
		// only ever loads the sign-in screen must not get one.
		await page.goto('/admin/login');
		await expect(page.locator('input[type="password"]')).toBeVisible();

		expect((await context.cookies()).find((c) => c.name === 'tz')).toBeUndefined();
	});

	test('the browser publishes its zone and the server dates the key in it', async ({
		page,
		context
	}) => {
		await login(page);
		// Reached by clicking the sidebar, NOT page.goto: the admin layout is reused
		// across client-side navigation, so a mount-only cookie write would run just
		// once — on the sign-in page, where it is skipped — and this would catch it.
		await page.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/\/admin\/settings/);
		await openAccountTab(page);

		// Written by the layout's effect, scoped to the admin area — never to public
		// pages. The raw value is URI-encoded (the slash in an IANA zone);
		// SvelteKit's cookies.get decodes it, which the date below then proves.
		await expect(async () => {
			const tz = (await context.cookies()).find((c) => c.name === 'tz');
			expect(tz).toMatchObject({ value: 'Asia%2FTokyo', path: '/admin' });
		}).toPass();

		await keyInput(page).fill(EXPIRED_TOKEN);
		await saveButton(page).click();

		// The server read the cookie: Tokyo's calendar day, not UTC's.
		await expect(fieldError(page)).toContainText('2025.07.17');
	});
});
