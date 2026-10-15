import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminLogin } from './admin-login';

// Connect to the Shared Registry (SONA-237): the registry refuses a used or
// unknown invite token with a code, and the form shows that on the token field
// instead of the generic toast. The site's server makes the registry call, so
// Playwright can't route it; the spec points the form's custom registry URL at
// a stub registry it runs itself. A refused connect stores nothing, so the
// shared e2e DB is left as it was.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e.toml (throwaway local value).
const PASSWORD = 'e2e-admin-password';

let registry: Server;
let registryUrl: string;
// The stub's next reply: one of the two invite codes, or '' for a refusal with no code.
let nextCode = 'invite_used';

test.beforeAll(async () => {
	registry = createServer((req, res) => {
		res.writeHead(nextCode ? 401 : 400, { 'content-type': 'application/json' });
		res.end(JSON.stringify(nextCode ? { error: 'refused', code: nextCode } : { error: 'label too long' }));
	});
	await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
	registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
	await new Promise((resolve) => registry.close(resolve));
});

const cases = [
	['invite_used', 'This invite token has been used or revoked. Ask the registry maintainer for a new one.'],
	[
		'invite_invalid',
		"The registry didn't accept this invite token. Make sure you pasted the whole token, or ask the registry maintainer for a new one."
	]
] as const;

async function submitConnect(page: Page, token: string) {
	await page.getByLabel('Invite token').fill(token);
	const advanced = page.locator('details.reg-advanced');
	if (!(await advanced.evaluate((d) => (d as HTMLDetailsElement).open))) await advanced.locator('summary').click();
	await page.getByLabel('Registry URL').fill(registryUrl);
	await page.getByRole('button', { name: 'Connect to registry' }).click();
}

for (const [code, message] of cases) {
	test(`shows ${code} on the invite token field and moves focus there`, async ({ page }, testInfo) => {
		nextCode = code;
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings?tab=connections');
		// Focus moving to the field is the enhanced form's job, so wait for hydration.
		await page.waitForLoadState('networkidle');

		const token = page.getByLabel('Invite token');
		await submitConnect(page, 'a-token-the-stub-refuses');

		const error = page.locator('#invite-token-error');
		await expect(error).toHaveText(message);
		await expect(token).toHaveAttribute('aria-invalid', 'true');
		await expect(token).toHaveAttribute('aria-describedby', 'invite-token-error');
		await expect(token).toBeFocused();
		// The field message replaces the toast for these two refusals.
		await expect(page.getByText('Could not connect')).toHaveCount(0);

		await page.screenshot({ path: testInfo.outputPath(`registry-${code}.png`), fullPage: false });
	});
}

test('clears the field message when the token changes or a later refusal has no code', async ({ page }) => {
	nextCode = 'invite_used';
	await adminLogin(page, PASSWORD);
	await page.goto('/admin/settings?tab=connections');
	await page.waitForLoadState('networkidle');

	const token = page.getByLabel('Invite token');
	const error = page.locator('#invite-token-error');
	await submitConnect(page, 'first-token');
	await expect(error).toBeVisible();

	// Editing the token clears the stale message and the invalid state.
	await token.pressSequentially('x');
	await expect(error).toHaveCount(0);
	await expect(token).not.toHaveAttribute('aria-invalid', 'true');

	await submitConnect(page, 'first-token');
	await expect(error).toBeVisible();

	// A refusal without an invite code goes back to the toast, with no field message.
	nextCode = '';
	await submitConnect(page, 'second-token');
	await expect(page.getByText('Could not connect: label too long.')).toBeVisible();
	await expect(error).toHaveCount(0);
});

// Login needs script (Turnstile), so this logs in with JavaScript on and reuses
// the session in a context with it off.
test('without JavaScript, the posted form reopens Connections and shows the field message', async ({
	browser
}, testInfo) => {
	nextCode = 'invite_used';
	const baseURL = testInfo.project.use.baseURL;
	const login = await browser.newContext({ baseURL });
	await adminLogin(await login.newPage(), PASSWORD);
	const storageState = await login.storageState();
	await login.close();

	const context = await browser.newContext({ baseURL, storageState, javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto('/admin/settings?tab=connections');

	const token = page.getByLabel('Invite token');
	await token.fill('a-token-the-stub-refuses');
	// A details element opens without script.
	await page.locator('details.reg-advanced summary').click();
	await page.getByLabel('Registry URL').fill(registryUrl);
	await page.getByRole('button', { name: 'Connect to registry' }).click();

	const error = page.locator('#invite-token-error');
	await expect(error).toBeVisible();
	await expect(error).toHaveText(cases[0][1]);
	await expect(token).toHaveAttribute('aria-invalid', 'true');
	await expect(token).toHaveAttribute('aria-describedby', 'invite-token-error');

	await page.screenshot({ path: testInfo.outputPath('registry-invite_used-no-js.png'), fullPage: false });
	await context.close();
});
