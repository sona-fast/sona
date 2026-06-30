import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage } from '$lib/server/storage';
import { migrateNextBatch } from '$lib/server/storage/migrate';
import type { RequestHandler } from './$types';

// POST /api/storage/migrate  (admin-only via hooks)
// Migrates one small batch of images to the non-active provider and returns
// progress. The client calls this repeatedly until `remaining` hits 0, keeping
// each request well within Worker limits. Resumable: already-migrated images
// are skipped.
const BATCH_SIZE = 5;

export const POST: RequestHandler = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db, { fresh: true });
	// Consolidate everything ONTO the active provider (the chosen home).
	const targetStorage = getStorage(platform?.env, settings, settings.storageProvider);

	const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);

	const progress = await migrateNextBatch({
		db,
		fetchFn: fetch,
		target: targetStorage,
		batchSize: BATCH_SIZE,
		absolutize
	});

	return json(progress);
};
