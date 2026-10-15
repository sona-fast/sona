import { test, expect } from '@playwright/test';
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
let nextCode = 'invite_used';

test.beforeAll(async () => {
	registry = createServer((req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'refused', code: nextCode }));
	});
	await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
	registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
	await new Promise((resolve) => registry.close(resolve));
});

const cases = [
	['invite_used', 'This invite token was already used or revoked. Ask the registry maintainer for a new one.'],
	['invite_invalid', "The registry didn't accept this invite token. Check it, or ask the registry maintainer for a new one."]
] as const;

for (const [code, message] of cases) {
	test(`shows ${code} on the invite token field and moves focus there`, async ({ page }, testInfo) => {
		nextCode = code;
		await adminLogin(page, PASSWORD);
		await page.goto('/admin/settings?tab=connections');
		// Focus moving to the field is the enhanced form's job, so wait for hydration.
		await page.waitForLoadState('networkidle');

		const token = page.getByLabel('Invite token');
		await token.fill('a-token-the-stub-refuses');
		await page.locator('details.reg-advanced summary').click();
		await page.getByLabel('Registry URL').fill(registryUrl);
		await page.getByRole('button', { name: 'Connect to registry' }).click();

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
