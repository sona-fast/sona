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
	// The url must be resolvable by a third-party embedder: absolute, on our own
	// origin, and exactly the CDN transform of the seeded relative path. (That
	// transform only *renders* on the real edge, not against the dev server — this
	// asserts the advertised string, not that it fetches.)
	expect(body.url).toBe(
		`${baseURL}/cdn-cgi/image/width=1200,quality=85,fit=scale-down,format=auto//e2e/parentpiece.png`
	);
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
	const body = await res.json();
	expect(body.title).toBe('Parent Piece SFW');

	// ...and the image the page itself advertises must be the SAME image, at the
	// same size: an embedder that reads og:image and one that reads the oEmbed
	// payload have to end up with one picture, not two.
	const meta = async (property: string) =>
		page.locator(`meta[property="${property}"]`).getAttribute('content');
	expect(await meta('og:image')).toBe(body.url);
	expect(await meta('og:image:width')).toBe(String(body.width));
	expect(await meta('og:image:height')).toBe(String(body.height));
});

test('an unpublished slug is 404 to an anonymous embedder', async ({ request, baseURL }) => {
	const target = `${baseURL}/gallery/mature-poster-source`;
	const res = await request.get(`/api/oembed?url=${encodeURIComponent(target)}`);
	expect(res.status()).toBe(404);
});
