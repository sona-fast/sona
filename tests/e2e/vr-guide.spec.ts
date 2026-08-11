import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

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

	// The verified measurement pair from the blendshape step — the guide's core
	// claim (the copy itself is pinned in src/lib/vr-guide-copy.test.ts; this
	// asserts the page actually renders it).
	await expect(page.getByText('147.85 MB')).toBeVisible();
	await expect(page.getByText('7.28 MB')).toBeVisible();
});

test('a troubleshooting row is a native details element that toggles open', async ({ page }) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/guide');

	// Closed by default: the answer is hidden until its summary is clicked.
	const answer = page.getByText('Blendshapes, almost always.');
	await expect(answer).toBeHidden();
	await page.getByText('The file is too large').click();
	await expect(answer).toBeVisible();
});
