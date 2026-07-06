import { dev } from '$app/environment';
import { fail } from '@sveltejs/kit';
import { UTApi } from 'uploadthing/server';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage, collectReferencedUrls } from '$lib/server/storage';
import { images } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

const PROVIDER_LABEL = { uploadthing: 'UploadThing', r2: 'Cloudflare R2' } as const;

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db, { fresh: true });
	// Consolidate everything ONTO the active provider (set in Settings); the other
	// provider is the "source" we migrate from and later clean up.
	const target = settings.storageProvider;
	const source: 'uploadthing' | 'r2' = target === 'uploadthing' ? 'r2' : 'uploadthing';

	const rows = await db.select({ imageUrl: images.imageUrl, fileSize: images.fileSize }).from(images);
	const total = rows.length;
	const totalSize = rows.reduce((sum, r) => sum + (r.fileSize ?? 0), 0);

	// How many already live on the target (for resume / progress on load).
	let alreadyOnTarget = 0;
	try {
		const targetStorage = getStorage(platform?.env, settings, target);
		alreadyOnTarget = rows.filter((r) => targetStorage.owns(r.imageUrl)).length;
	} catch {
		// target not configured — UI will surface this
	}

	// Leftover originals on the source (UploadThing) that the DB no longer
	// references — drives whether to show the cleanup section at all.
	let sourceLeftover = 0;
	const token = platform?.env.UPLOADTHING_TOKEN;
	if (source === 'uploadthing' && token) {
		try {
			const utapi = new UTApi({ token });
			const listing = await Promise.race([
				utapi.listFiles({ limit: 500 }),
				new Promise<{ files: never[] }>((_, reject) =>
					setTimeout(() => reject(new Error('UT timeout')), 5000)
				)
			]);
			const referenced = new Set(
				rows.map((r) => r.imageUrl.match(/\/f\/([^/?#]+)/)?.[1]).filter((k): k is string => !!k)
			);
			sourceLeftover = listing.files.filter((f) => !referenced.has(f.key)).length;
		} catch {
			// UT slow/unreachable — assume unknown; we'll still allow cleanup.
			sourceLeftover = -1;
		}
	}

	return {
		source,
		target,
		sourceLabel: PROVIDER_LABEL[source],
		targetLabel: PROVIDER_LABEL[target],
		total,
		totalSize,
		alreadyOnTarget,
		sourceLeftover
	};
};

export const actions = {
	// Delete the original files left on the source provider (UploadThing) after
	// migrating onto the active provider. Removes files no longer referenced by the DB.
	cleanup: async ({ platform }) => {
		// Dev shares the live UploadThing token; deleting "orphans" here would nuke
		// files prod still references. Only allow cleanup from production.
		if (dev) {
			return fail(400, {
				error: 'Cleanup is disabled in dev — it would delete from the live UploadThing account that production uses.'
			});
		}

		const db = getDb(platform!.env.DB);
		try {
			const settings = await getSettings(db, { fresh: true });
			// The source = the non-active provider (where the pre-migration originals sit).
			const source: 'uploadthing' | 'r2' = settings.storageProvider === 'uploadthing' ? 'r2' : 'uploadthing';
			// The reference set is EVERY URL-bearing column plus URL-ish settings —
			// not just images.imageUrl. The source provider may still hold sticker
			// files, thumbnails, avatars and covers the DB references; anything
			// missed would be deleted as an "orphan". The 1h gate protects an
			// upload racing this button (bytes land before any D1 row exists).
			const referenced = await collectReferencedUrls(db, settings);
			const deleted = await getStorage(platform?.env, settings, source).deleteOrphans(referenced, {
				olderThan: new Date(Date.now() - 60 * 60 * 1000)
			});
			return {
				success: true,
				message: deleted === 0 ? 'No leftover originals to delete.' : `Deleted ${deleted} original file${deleted === 1 ? '' : 's'} from ${PROVIDER_LABEL[source]}.`
			};
		} catch (e) {
			return fail(500, { error: `Cleanup failed: ${e instanceof Error ? e.message : 'unknown error'}` });
		}
	}
} satisfies Actions;
