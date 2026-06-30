import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { fursuitPhotos } from '$lib/server/db/schema';
import { fursuitPhotoFromRow } from '$lib/server/fursuit-import';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found');

	const db = getDb(platform!.env.DB);
	const row = await db.select().from(fursuitPhotos).where(eq(fursuitPhotos.id, id)).get();
	if (!row) error(404, 'Fursuit photo not found');

	const photo = fursuitPhotoFromRow(row);
	// Defense-in-depth: render only if the license permits OR the admin recorded
	// direct permission from the photographer. A later license reclassification
	// can't expose a stored row that no longer qualifies.
	if (!photo.license.displayable && !photo.permissionSource) error(404, 'Fursuit photo not found');

	return { photo };
};
