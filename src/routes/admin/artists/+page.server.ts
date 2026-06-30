import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, images, stickers, stickerPacks } from '$lib/server/db/schema';
import { eq, sql, like } from 'drizzle-orm';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 25;
	// Server-side name search so it matches across the WHOLE set, not just the
	// current page. SQLite LIKE is case-insensitive for ASCII.
	const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
	const whereClause = q ? like(artists.name, `%${q}%`) : undefined;

	const totalResult = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(artists)
		.where(whereClause)
		.get();
	const total = totalResult?.count || 0;

	const allArtists = await db
		.select({
			id: artists.id,
			name: artists.name,
			avatarUrl: artists.avatarUrl,
			twitterUrl: artists.twitterUrl,
			blueskyUrl: artists.blueskyUrl,
			telegramUrl: artists.telegramUrl,
			furAffinityUrl: artists.furAffinityUrl,
			deviantArtUrl: artists.deviantArtUrl,
			patreonUrl: artists.patreonUrl,
			instagramUrl: artists.instagramUrl,
			createdAt: artists.createdAt,
			artworkCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.artist_id = artists.id)`,
			stickerCount: sql<number>`(SELECT COUNT(*) FROM stickers WHERE stickers.artist_id = artists.id)`
		})
		.from(artists)
		.where(whereClause)
		.orderBy(artists.name)
		.limit(perPage)
		.offset((page - 1) * perPage);

	return { artists: allArtists, page, total, totalPages: Math.ceil(total / perPage), q };
};

export const actions = {
	create: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const name = sanitizeText(data.get('name') as string, 200);

		if (!name) return fail(400, { error: 'Artist name is required' });

		await db.insert(artists).values({ name });
		return { success: true };
	},

	update: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const name = sanitizeText(data.get('name') as string, 200);
		const twitterUrl = sanitizeUrl(data.get('twitter') as string);
		const blueskyUrl = sanitizeUrl(data.get('bluesky') as string);
		const telegramUrl = sanitizeUrl(data.get('telegram') as string);
		const furAffinityUrl = sanitizeUrl(data.get('furaffinity') as string);
		const deviantArtUrl = sanitizeUrl(data.get('deviantart') as string);
		const patreonUrl = sanitizeUrl(data.get('patreon') as string);
		const instagramUrl = sanitizeUrl(data.get('instagram') as string);

		if (!id) return fail(400, { error: 'Artist ID is required' });
		if (!name) return fail(400, { error: 'Artist name is required' });

		// Try to resolve avatar from social links
		const avatarUrl = await resolveAvatarUrl({ blueskyUrl, twitterUrl, furAffinityUrl, patreonUrl });

		await db
			.update(artists)
			.set({ name, twitterUrl, blueskyUrl, telegramUrl, furAffinityUrl, deviantArtUrl, patreonUrl, instagramUrl, avatarUrl })
			.where(eq(artists.id, id));

		return { success: true };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));

		if (!id) return fail(400, { error: 'Artist ID is required' });

		// Block deletion while the artist is still referenced by artworks OR stickers
		// (stickers.artist_id is a non-cascading FK — deleting would fail / orphan).
		const imageCount = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(images)
			.where(eq(images.artistId, id))
			.get();
		if (imageCount && imageCount.count > 0) {
			return fail(400, { error: 'Cannot delete artist with existing artworks. Remove their images first.' });
		}

		const stickerCountRow = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(stickers)
			.where(eq(stickers.artistId, id))
			.get();
		if (stickerCountRow && stickerCountRow.count > 0) {
			return fail(400, { error: 'Cannot delete artist with existing stickers. Remove their stickers first.' });
		}

		// A pack can list this artist as its manager with 0 stickers (e.g. a Telegram
		// import where every download failed), so it slips past the checks above. The
		// sticker_packs.manager_artist_id FK is non-cascading, so deleting would fail.
		const managedPackRow = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(stickerPacks)
			.where(eq(stickerPacks.managerArtistId, id))
			.get();
		if (managedPackRow && managedPackRow.count > 0) {
			return fail(400, {
				error: `Cannot delete artist who manages ${managedPackRow.count} sticker pack${managedPackRow.count === 1 ? '' : 's'}. Reassign or remove those packs first.`
			});
		}

		// Backstop: any remaining FK reference would otherwise surface as an uncaught 500.
		try {
			await db.delete(artists).where(eq(artists.id, id));
		} catch {
			return fail(400, { error: 'Cannot delete artist while they are still referenced elsewhere.' });
		}
		return { success: true };
	}
} satisfies Actions;
