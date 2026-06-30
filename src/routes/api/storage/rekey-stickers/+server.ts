import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage, deleteFile, isOwnedUrl } from '$lib/server/storage';
import { stickers, stickerPacks, fursuitPhotos } from '$lib/server/db/schema';
import { photographerSlug } from '$lib/server/fursuit-import';
import type { RequestHandler } from './$types';

// POST /api/storage/rekey-stickers  (admin-only via hooks)
//
// One-off, idempotent migration to the "Option B" (entity-partitioned) storage
// layout. Re-keys EXISTING objects to the new scheme and repoints the DB:
//   stickers      → stickers/{packSlug}/{basename}
//   fursuit_photos→ fursuit/{photographerSlug}/{basename}
// where basename is the current object's filename (kept as-is). For each row we
// fetch the current object, re-store it under the new key, update the row's
// imageUrl, then best-effort delete the old object.
//
// Idempotent: a row whose imageUrl already lives at its target key is skipped, so
// re-running is safe. Each row is wrapped in try/catch so one failure can't abort
// the run. Prod has no sticker objects yet (feature unshipped) so this is a no-op
// there; it exists to fix up LOCAL objects stored under the old flat scheme.

interface ReKeyItem {
	table: 'stickers' | 'fursuit_photos';
	id: number;
	status: 'rekeyed' | 'skipped' | 'failed';
	oldUrl?: string;
	newUrl?: string;
	error?: string;
}

/** Last path segment of a stored URL (the object's filename), or '' if unknown. */
function basenameOf(url: string): string {
	try {
		return new URL(url).pathname.split('/').pop() ?? '';
	} catch {
		return url.split('/').pop() ?? '';
	}
}

/** Path portion of a (possibly absolute) URL, used for the idempotency check. */
function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}

export const POST: RequestHandler = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db, { fresh: true });
	const storage = getStorage(platform?.env, settings);
	const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);

	const items: ReKeyItem[] = [];
	let stickersReKeyed = 0;
	let fursuitReKeyed = 0;
	let skipped = 0;
	let failed = 0;

	/**
	 * Re-key one object to `newKey` (when not already there) and return the new
	 * stored URL, or null when the row was skipped (already at target / not ours).
	 */
	async function rekey(oldUrl: string, newKey: string): Promise<string | null> {
		// Already at the target key → nothing to do (idempotent re-run).
		if (pathOf(oldUrl).endsWith(`/${newKey}`)) return null;
		// Only objects we host can be moved; an external URL isn't ours to re-key.
		if (!isOwnedUrl(platform?.env, settings, oldUrl)) return null;

		const res = await fetch(oldUrl);
		if (!res.ok) throw new Error(`fetch ${res.status} for ${oldUrl}`);
		const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
		const body = new Uint8Array(await res.arrayBuffer());

		const { url: storedUrl } = await storage.put({
			suggestedKey: newKey,
			body,
			contentType,
			filename: newKey.split('/').pop() ?? newKey
		});
		const newUrl = absolutize(storedUrl);

		// Best-effort cleanup of the original object (don't fail the row on this).
		try {
			await deleteFile(platform?.env, settings, oldUrl);
		} catch {
			// Orphaned objects can be swept by the existing orphan cleanup.
		}
		return newUrl;
	}

	// --- Stickers → stickers/{packSlug}/{basename} ---
	const stickerRows = await db
		.select({ id: stickers.id, imageUrl: stickers.imageUrl, packSlug: stickerPacks.slug })
		.from(stickers)
		.innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id));

	for (const row of stickerRows) {
		const basename = basenameOf(row.imageUrl);
		const newKey = `stickers/${row.packSlug}/${basename}`;
		try {
			const newUrl = !basename ? null : await rekey(row.imageUrl, newKey);
			if (!newUrl) {
				skipped++;
				items.push({ table: 'stickers', id: row.id, status: 'skipped', oldUrl: row.imageUrl });
				continue;
			}
			await db.update(stickers).set({ imageUrl: newUrl }).where(eq(stickers.id, row.id));
			stickersReKeyed++;
			items.push({ table: 'stickers', id: row.id, status: 'rekeyed', oldUrl: row.imageUrl, newUrl });
		} catch (e) {
			failed++;
			items.push({
				table: 'stickers',
				id: row.id,
				status: 'failed',
				oldUrl: row.imageUrl,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}

	// --- Fursuit photos → fursuit/{photographerSlug}/{basename} ---
	const fursuitRows = await db
		.select({ id: fursuitPhotos.id, imageUrl: fursuitPhotos.imageUrl, photographer: fursuitPhotos.photographer })
		.from(fursuitPhotos);

	for (const row of fursuitRows) {
		const basename = basenameOf(row.imageUrl);
		const newKey = `fursuit/${photographerSlug(row.photographer)}/${basename}`;
		try {
			const newUrl = !basename ? null : await rekey(row.imageUrl, newKey);
			if (!newUrl) {
				skipped++;
				items.push({ table: 'fursuit_photos', id: row.id, status: 'skipped', oldUrl: row.imageUrl });
				continue;
			}
			await db.update(fursuitPhotos).set({ imageUrl: newUrl }).where(eq(fursuitPhotos.id, row.id));
			fursuitReKeyed++;
			items.push({ table: 'fursuit_photos', id: row.id, status: 'rekeyed', oldUrl: row.imageUrl, newUrl });
		} catch (e) {
			failed++;
			items.push({
				table: 'fursuit_photos',
				id: row.id,
				status: 'failed',
				oldUrl: row.imageUrl,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}

	return json({ stickersReKeyed, fursuitReKeyed, skipped, failed, items });
};
