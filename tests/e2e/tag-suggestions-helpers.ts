import type { Page, Route } from '@playwright/test';

// Shared by the two specs that exercise the "Suggest tags" lookup (SONA-220):
// tag-suggestions.spec.ts on /admin/upload and suggest-tags.spec.ts on the
// backfill list. Both intercept the endpoint rather than calling it, so the
// stub belongs in one place.
export const ENDPOINT = '**/api/admin/tag-suggestions';

/** Answer the lookup with one canned response. */
export async function stubSuggestions(page: Page, status: number, body: unknown) {
	await page.route(ENDPOINT, (route: Route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
	);
}
