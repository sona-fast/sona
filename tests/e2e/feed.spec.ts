import { test, expect } from '@playwright/test';

// RSS feed (SONA-172). Like the oEmbed spec, every test here uses the bare
// `request`/`page` fixtures and never adminLogin: the feed is fetched
// anonymously by feed readers, which is the whole point of it.
//
// Runs on the SHARED read-only DB/server (tests/e2e/fixtures/seed.sql), so
// nothing here writes a setting. The seed gives the gating rules real rows to
// bite on: image 1 published+SFW, image 2 an NSFW variant, image 4 unpublished,
// image 5 NSFW, avatar 1 published, avatar 2 an unpublished draft, and avatar 3
// published with an NSFW poster.

/** The <title> of each <item>, in document order. */
function itemTitles(body: string): string[] {
	return [...body.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
}

test('anonymous GET returns a parseable RSS document', async ({ request }) => {
	const res = await request.get('/feed.xml');
	expect(res.status()).toBe(200);
	// The content type is what makes a browser offer the feed to a reader rather
	// than rendering or downloading it.
	expect(res.headers()['content-type']).toBe('application/rss+xml; charset=utf-8');

	const body = await res.text();
	expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
	expect(body).toContain('<rss version="2.0"');
	expect(body).toContain('<title>E2E Test Gallery</title>');
	expect(body).toContain('All artwork belongs to their respective artists.');
});

test('lists published SFW work and nothing else', async ({ request }) => {
	const titles = itemTitles(await (await request.get('/feed.xml')).text());

	expect(titles).toContain('Parent Piece SFW');
	expect(titles).toContain('E2E VR Avatar');
	// A variant — the same artwork under a near-identical title — and NSFW too.
	expect(titles).not.toContain('Variant Piece NSFW');
	// Unpublished.
	expect(titles).not.toContain('E2E VR Draft');
	// NSFW.
	expect(titles).not.toContain('Mature Ref Sheet');
	// Published, and its own nsfw flag is 0 — but its poster is NSFW, so the
	// effective flag the /vr loader uses must keep it out.
	expect(titles).not.toContain('E2E Mature Poster');
});

test('credits the artist and points each entry at its own page', async ({ request, baseURL }) => {
	const body = await (await request.get('/feed.xml')).text();
	expect(body).toContain(`<link>${baseURL}/gallery/parent-piece</link>`);
	expect(body).toContain(`<guid isPermaLink="true">${baseURL}/gallery/parent-piece</guid>`);
	expect(body).toContain('<dc:creator>Test Artist</dc:creator>');
});

test('a wrong key gets the ordinary SFW feed, never an error', async ({ request }) => {
	// A 403 would confirm that a key exists to be guessed at. The seed enables no
	// NSFW feed at all, so this also covers the hard-gate case.
	const res = await request.get(`/feed.xml?key=${'a'.repeat(32)}`);
	expect(res.status()).toBe(200);

	const body = await res.text();
	expect(itemTitles(body)).not.toContain('Variant Piece NSFW');
	expect(body).not.toContain('RTA-5042-1996-1400-1577-RTA');
	expect(res.headers()['x-robots-tag']).toBeUndefined();
});

test('revalidates with a 304 instead of resending the document', async ({ request }) => {
	const first = await request.get('/feed.xml');
	const etag = first.headers()['etag'];
	expect(etag).toBeTruthy();

	const second = await request.get('/feed.xml', { headers: { 'if-none-match': etag } });
	expect(second.status()).toBe(304);
});

test('is discoverable from the footer and from the page head', async ({ page }) => {
	await page.goto('/gallery');

	// The visible route in: a text link in the footer's link nav.
	const link = page.locator('footer a[href="/feed.xml"]').first();
	await expect(link).toBeVisible();
	await expect(link).toHaveText('RSS feed');

	// The machine route in: autodiscovery, which is how a reader's "subscribe to
	// this page" button finds the feed. Lives in the root layout, so it is
	// present on the homepage too — which escapes the (public) layout.
	for (const path of ['/gallery', '/']) {
		await page.goto(path);
		await expect(
			page.locator('link[rel="alternate"][type="application/rss+xml"]')
		).toHaveAttribute('href', '/feed.xml');
	}
});
