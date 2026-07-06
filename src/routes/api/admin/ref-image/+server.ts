import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

// GET /api/admin/ref-image?id=<imageId>  (admin-only via hooks — everything
// under /api except /api/cron/ requires the admin session).
//
// Streams the stored image bytes same-origin so the ref-sheet color picker can
// read canvas pixels when the original URL would taint the canvas (e.g. dev
// pointing at prod-origin storage URLs). The image URL is looked up BY ID in
// the DB — this endpoint never fetches a caller-supplied URL (SSRF).
export const GET: RequestHandler = async ({ url, platform, fetch }) => {
	const id = Number(url.searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) error(400, 'Invalid image id');

	const db = getDb(platform!.env.DB);
	const row = await db
		.select({ imageUrl: images.imageUrl })
		.from(images)
		.where(eq(images.id, id))
		.get();
	if (!row) error(404, 'Image not found');

	const upstream = await fetch(row.imageUrl);
	if (!upstream.ok || !upstream.body) error(502, 'Could not fetch the stored image');
	return new Response(upstream.body, {
		headers: {
			'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
			'Cache-Control': 'private, no-store'
		}
	});
};
