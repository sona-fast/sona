import { test, expect } from '@playwright/test';

// oEmbed provider (SONA-168): the endpoint is reachable WITHOUT an admin session,
// which is the whole point — Discord/Slack/Telegram fetch it anonymously. So every
// test here uses the bare `request` fixture, never adminLogin.
//
// Runs on the SHARED read-only DB/server: these are GETs against the seeded rows
// (tests/e2e/fixtures/seed.sql — image 1 published, image 4 unpublished).

test('anonymous GET of the provider endpoint returns the oEmbed payload', async ({
	request,
	baseURL
}) => {
	const target = `${baseURL}/gallery/parent-piece`;
	const res = await request.get(`/api/oembed?url=${encodeURIComponent(target)}`);
	expect(res.status()).toBe(200);

	const body = await res.json();
	expect(body.version).toBe('1.0');
	expect(body.type).toBe('photo');
	expect(body.title).toBe('Parent Piece SFW');
	// The url must be resolvable by a third-party embedder. The exact string is a
	// CDN transform of the seeded relative path, so assert shape, not equality.
	expect(new URL(body.url).host).toBeTruthy();
});

test('the discovery link the gallery page advertises resolves to that same payload', async ({
	page,
	request
}) => {
	await page.goto('/gallery/parent-piece');

	const href = await page
		.locator('link[rel=alternate][type="application/json+oembed"]')
		.getAttribute('href');
	expect(href).toBeTruthy();

	// The head link and the endpoint must not drift: whatever the page advertises
	// is what an embedder will actually fetch.
	const res = await request.get(href!);
	expect(res.status()).toBe(200);
	expect((await res.json()).title).toBe('Parent Piece SFW');
});

test('an unpublished slug is 404 to an anonymous embedder', async ({ request, baseURL }) => {
	const target = `${baseURL}/gallery/mature-poster-source`;
	const res = await request.get(`/api/oembed?url=${encodeURIComponent(target)}`);
	expect(res.status()).toBe(404);
});
