import { test, expect } from '@playwright/test';

// /connect during a convention: the seed fixture (tests/e2e/fixtures/seed.sql)
// carries one confirmed convention spanning date('now') a day either side, so
// the shared read-only server always renders the here-now block — the one
// surface where the operator's pronouns appear on this page (SONA-210).
//
// Runs on the SHARED DB/server under fullyParallel: read-only throughout.

test('the here-now block renders the live convention with the operator pronouns line', async ({
	page
}) => {
	await page.goto('/connect');

	const block = page.locator('.here-now');
	await expect(block).toBeVisible();
	// The pill is the section's heading, so it is reachable by heading nav.
	await expect(block.locator('h2.live-pill')).toBeVisible();
	await expect(block).toContainText('E2E Live Con');

	// The pronouns line, with its screen-reader prefix intact: textContent keeps
	// the sr-only span, so the separator space the {' '} idiom preserves is
	// asserted here end to end.
	const pronouns = block.locator('.here-pronouns');
	await expect(pronouns).toBeVisible();
	await expect(pronouns).toHaveText('Pronouns: they/them');
});
