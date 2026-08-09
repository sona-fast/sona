import { test, expect } from '@playwright/test';
import { adminLogin } from './admin-login';

// ConfirmDialog smoke (SONA-124 R2-T2): the dialog was rewritten onto the
// shared focus-trap action and serves ~10 destructive admin flows — this pins
// the modal contract on a real consumer (the VR edit page's Delete avatar).
//
// NON-MUTATING by design: the destructive action is NEVER clicked. Open →
// assert dialog semantics + initial focus → Esc → assert it closed, focus
// returned to the invoker, and the row survived. Runs on the SHARED read-only
// DB/server under fullyParallel.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

test('delete confirm: dialog semantics, safe initial focus, Esc closes and restores focus', async ({
	page
}) => {
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/vr/1/edit');
	await expect(page.getByRole('heading', { name: 'Edit avatar' })).toBeVisible();

	const openButton = page.getByRole('button', { name: 'Delete avatar' });

	// Hydration-retry shape (see upload.spec.ts): clicking before Svelte attaches
	// its listeners silently does nothing, so retry until the dialog appears.
	const dialog = page.getByRole('dialog');
	await expect(async () => {
		await openButton.click();
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	// ARIA dialog contract: modal, labelled by its title, described by the message.
	await expect(dialog).toHaveAttribute('aria-modal', 'true');
	await expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-dialog-title');
	await expect(page.locator('#confirm-dialog-title')).toHaveText('Delete this avatar?');

	// Initial focus lands on the SAFE action, not the destructive one.
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

	// Esc closes from anywhere and the focus-trap returns focus to the invoker.
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(openButton).toBeFocused();

	// Row intact: nothing was deleted (the destructive button was never touched).
	await expect(page.locator('input[name="name"]')).toHaveValue('E2E VR Avatar');
	await page.goto('/admin/vr');
	await expect(page.getByText('E2E VR Avatar')).toBeVisible();
});
