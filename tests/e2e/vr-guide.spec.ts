import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';
import { MAX_VR_MODEL_BYTES, formatBytes } from '../../src/lib/vr';

// VR export guide (SONA-162): a static admin documentation page at
// /admin/vr/guide. Runs on the SHARED read-only DB/server under fullyParallel —
// everything here reads; nothing is submitted or mutated. The page has no gate
// of its own (documentation stays reachable however the VR early-access gate
// is set), so this needs only the admin session.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('the guide renders its heading and the measured blendshape numbers', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/guide');

	await expect(
		page.getByRole('heading', { name: 'Export your VRChat avatar as a VRM' })
	).toBeVisible();

	// The document title composes the guide title with the site name, like the
	// public routes — not the root layout's bare site name.
	await expect(page).toHaveTitle(/Export your VRChat avatar as a VRM/);

	// The round-1 a11y remediation, pinned: each step heading's accessible name
	// carries the sr-only "Step {n}." prefix, and the steps list keeps list
	// semantics (explicit role="list" — list-style:none strips the implicit
	// role in Safari/VoiceOver).
	await expect(
		page.getByRole('heading', { name: /Step 1\. Work in a copy of your project/ })
	).toBeVisible();
	await expect(page.getByRole('heading', { name: /Step 4\./ })).toBeVisible();
	await expect(
		page.getByRole('list').filter({ has: page.locator('.step') }).getByRole('listitem')
	).toHaveCount(6);

	// The verified measurements from the blendshape step — the guide's core
	// claim (the values are pinned in src/lib/vr-guide-copy.test.ts; this
	// asserts each number renders IN ITS OWN row, not merely somewhere on the
	// page).
	await expect(
		page.locator('.numbers > div', { hasText: 'Same model, stripped' })
	).toContainText('7.28 MB');
	await expect(
		page.locator('.numbers > div', { hasText: 'Export, all blendshapes' })
	).toContainText('147.85 MB');
	await expect(
		page.locator('.numbers > div', { hasText: 'Textures (3 × 2048²), either way' })
	).toContainText('~5 MB');

	// The step-4 size limit interpolates the real cap from $lib/vr — the page
	// must show the formatted number, never the raw {max} token.
	await expect(page.getByText(formatBytes(MAX_VR_MODEL_BYTES))).toBeVisible();
	await expect(page.locator('.guide')).not.toContainText('{max}');

	// Inline markers went through the rich() renderer: bold runs render as
	// <strong>, backtick paths as .kbd-path chips, and no literal ** leaks.
	await expect(
		page.locator('strong', { hasText: 'The Unity project your avatar lives in.' })
	).toBeVisible();
	await expect(page.locator('.kbd-path', { hasText: 'VRM/MToon' })).toBeVisible();
	await expect(page.locator('.guide')).not.toContainText('**');
});

// One 320px overflow check per locale: the EN risk is the step-2 menu-path
// chip (once nowrap, it pushed scrollWidth to ~404px at this width), the JA
// risk is line-wrapping (kinsoku, long katakana runs) — the whole document
// must fit either way. The paraglide locale cookie
// (src/lib/paraglide/runtime.js cookieName) switches the SSR locale for ja.
for (const [locale, expectedHeading] of [
	['en', 'Export your VRChat avatar as a VRM'],
	['ja', 'VRChatアバターをVRMとして書き出す']
] as const) {
	test(`the ${locale} guide does not force horizontal scroll on a 320px viewport`, async ({ page }) => {
		await adminLogin(page, PASSWORD);
		if (locale === 'ja') {
			await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
		}
		await page.setViewportSize({ width: 320, height: 800 });
		await page.goto('/admin/vr/guide');

		await expect(page.getByRole('heading', { name: expectedHeading })).toBeVisible();
		const fits = await page.evaluate(
			() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth
		);
		expect(fits).toBe(true);
	});
}

test('a troubleshooting row is a native details element that toggles open', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/guide');

	// Closed by default: the answer is hidden until its summary is clicked.
	const answer = page.getByText('Blendshapes, almost always.');
	await expect(answer).toBeHidden();
	await page.getByText('The file is too large').click();
	await expect(answer).toBeVisible();
});
