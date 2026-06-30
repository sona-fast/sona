import { fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { characters, fursuitPhotos } from '$lib/server/db/schema';
import { getMode } from '$lib/server/furtrack';
import { getImportCandidates, importFursuitPhotos, fursuitPhotoFromRow } from '$lib/server/fursuit-import';
import type { ImportCandidate } from '$lib/server/fursuit-import';
import { deleteFile } from '$lib/server/storage';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	const enabled = getMode(platform?.env) !== 'off';
	const allCharacters = await db.select({ name: characters.name }).from(characters).orderBy(characters.name);
	// Default to the site's primary character (who the site is for), not a hardcode.
	const character = url.searchParams.get('character') || settings.primaryCharacter || allCharacters[0]?.name || '';

	// Only hit FurTrack when the admin explicitly checks (?check=1).
	let candidates: ImportCandidate[] = [];
	let checked = false;
	let reachError = false;
	let capped = false;

	if (enabled && url.searchParams.get('check')) {
		checked = true;
		try {
			const r = await getImportCandidates({ env: platform?.env, db, fetchFn: fetch, character });
			if (r) {
				candidates = r.candidates;
				capped = r.capped;
			}
		} catch {
			reachError = true;
		}
	}

	// Currently-imported fursuit photos — for the "Manage imported" section that
	// lets the admin delete individual photos (removes the row + the stored R2/UT
	// object). Always loaded so the admin can prune without first re-checking
	// FurTrack. Newest first.
	const importedRows = await db.select().from(fursuitPhotos).orderBy(desc(fursuitPhotos.createdAt));
	const imported = importedRows.map((row) => ({
		...fursuitPhotoFromRow(row),
		furtrackPostId: row.furtrackPostId
	}));

	return {
		enabled,
		characters: allCharacters,
		character,
		checked,
		reachError,
		capped,
		candidates,
		imported
	};
};

export const actions = {
	import: async ({ request, platform, url, fetch }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const data = await request.formData();
		const character = (data.get('character') as string) || settings.primaryCharacter;
		const postIds = (data.getAll('postId') as string[]).map(Number).filter((n) => Number.isInteger(n) && n > 0);

		if (postIds.length === 0) return fail(400, { error: 'No photos selected.' });

		// Per-postId manual permission grants. The UI sends one `permission[<postId>]`
		// field per excluded photo the admin granted permission to, whose value is the
		// non-empty source string ("Telegram DM 2026-05-30", "Twitter @handle", etc.).
		// We accept a grant only for postIds the admin actually selected to import.
		const manualPermissions = new Map<number, string>();
		const selectedSet = new Set(postIds);
		for (const [k, v] of data.entries()) {
			const match = /^permission\[(\d+)\]$/.exec(k);
			if (!match) continue;
			const id = Number(match[1]);
			const source = (v as string).trim();
			if (selectedSet.has(id) && source) manualPermissions.set(id, source);
		}

		const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);
		const result = await importFursuitPhotos({
			env: platform?.env,
			settings,
			db,
			fetchFn: fetch,
			character,
			postIds,
			manualPermissions,
			absolutize
		});

		return { success: true, result };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid photo id.' });

		// Capture the URL before deleting so we can remove the stored object.
		const row = await db.select({ imageUrl: fursuitPhotos.imageUrl }).from(fursuitPhotos).where(eq(fursuitPhotos.id, id)).get();
		if (!row) return fail(404, { error: 'Fursuit photo not found.' });

		// Full delete: row goes (taking the permission_source audit with it), and
		// the FurTrack postId becomes importable again. If the row gets re-imported
		// later and its license is still excluded, the admin will need to record
		// permission again — intentional friction, matches "delete = revoke".
		await db.delete(fursuitPhotos).where(eq(fursuitPhotos.id, id));

		try {
			const settings = await getSettings(db);
			await deleteFile(platform?.env, settings, row.imageUrl);
		} catch {
			// Don't fail the row delete if storage cleanup fails — the public read
			// is now 404 anyway. Orphaned objects can be cleaned with the existing
			// storage orphan cleanup.
		}

		return { deleted: true };
	}
} satisfies Actions;
