import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, images, stickers, stickerPacks } from '$lib/server/db/schema';
import { eq, sql, like } from 'drizzle-orm';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { sanitizeText } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import {
	isRegistryEnabled,
	resolveRegistryEnv,
	registrySubmit,
	registrySubmissionsMine,
	artistSocials,
	parseAliases
} from '$lib/server/registry';
import { fetchRegistryCatalog } from '$lib/server/registry-import';
import { artistDiffersFromRegistry } from '$lib/server/registry-diff';
import { approvedSubmissionGlobalId, artistInCatalog } from '$lib/server/registry-submissions';
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
			globalId: artists.globalId,
			aliases: artists.aliases,
			createdAt: artists.createdAt,
			artworkCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.artist_id = artists.id)`,
			stickerCount: sql<number>`(SELECT COUNT(*) FROM stickers WHERE stickers.artist_id = artists.id)`
		})
		.from(artists)
		.where(whereClause)
		.orderBy(artists.name)
		.limit(perPage)
		.offset((page - 1) * perPage);

	// Which of the artists on this page have an open registry submission? (Match an
	// update by its target global_id, a create by the proposed display name.)
	const renv = await resolveRegistryEnv(db, platform?.env);
	const registryEnabled = isRegistryEnabled(renv);
	let pendingArtistIds: number[] = [];
	// Linked artists that already match the registry catalog — their "submit" is a
	// no-op and gets disabled. Fails open: an empty/unreachable catalog leaves it {}.
	const upToDate: Record<number, boolean> = {};
	if (registryEnabled) {
		const subs = await registrySubmissionsMine(renv);

		// An APPROVED submission means the maintainer linked this artist into the
		// registry. Stamp the global id now (marking it shared) instead of waiting
		// for the next background sync — otherwise the pending badge just clears, the
		// artist still looks unshared, and its "submit" re-enables, inviting a
		// duplicate submission of an already-approved artist.
		for (const a of allArtists) {
			const linkedId = approvedSubmissionGlobalId(a, subs);
			if (!linkedId) continue;
			// The unique index on global_id forbids two local rows sharing an id.
			const taken = await db
				.select({ id: artists.id })
				.from(artists)
				.where(eq(artists.globalId, linkedId))
				.get();
			if (taken) continue;
			await db
				.update(artists)
				.set({ globalId: linkedId, registrySyncedAt: new Date().toISOString() })
				.where(eq(artists.id, a.id));
			a.globalId = linkedId; // reflect in this render so the badge + guard update
		}

		const pending = subs.filter((s) => s.status === 'pending');
		pendingArtistIds = allArtists
			.filter((a) =>
				pending.some((s) => {
					if (s.targetGlobalId) return !!a.globalId && s.targetGlobalId === a.globalId;
					try {
						return (JSON.parse(s.payload).displayName as string) === a.name;
					} catch {
						return false;
					}
				})
			)
			.map((a) => a.id);

		// One catalog fetch; compare each linked artist against its entry. A linked
		// artist that already matches has nothing to submit; an unlinked artist
		// that's already in the catalog would be a duplicate — disable "submit" for
		// both so an already-shared artist can't be resubmitted.
		const catalog = await fetchRegistryCatalog(renv);
		const byGlobalId = new Map(catalog.map((r) => [r.globalId, r]));
		for (const a of allArtists) {
			if (a.globalId) {
				const entry = byGlobalId.get(a.globalId);
				if (entry && !artistDiffersFromRegistry(a, entry)) upToDate[a.id] = true;
			} else if (artistInCatalog(a, catalog)) {
				upToDate[a.id] = true;
			}
		}
	}

	return {
		// Surface registry-synced former names ("formerly …") so a renamed artist
		// (e.g. Boltie→Zaps) is explainable from the admin list, not just the
		// public gallery. Skip aliases identical to the current display name.
		artists: allArtists.map((a) => ({
			...a,
			formerly: parseAliases(a.aliases)
				.map((al) => al.displayName)
				.filter((n) => n.toLowerCase() !== a.name.toLowerCase())
		})),
		page,
		total,
		totalPages: Math.ceil(total / perPage),
		q,
		registryEnabled,
		pendingArtistIds,
		upToDate
	};
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
		const twitterUrl = normalizeSocialUrl('twitter', data.get('twitter') as string) || null;
		const blueskyUrl = normalizeSocialUrl('bluesky', data.get('bluesky') as string) || null;
		const telegramUrl = normalizeSocialUrl('telegram', data.get('telegram') as string) || null;
		const furAffinityUrl = normalizeSocialUrl('furaffinity', data.get('furaffinity') as string) || null;
		const deviantArtUrl = normalizeSocialUrl('deviantart', data.get('deviantart') as string) || null;
		const patreonUrl = normalizeSocialUrl('patreon', data.get('patreon') as string) || null;
		const instagramUrl = normalizeSocialUrl('instagram', data.get('instagram') as string) || null;

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

	submitToRegistry: async ({ request, platform }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		const renv = await resolveRegistryEnv(db, env);
		if (!isRegistryEnabled(renv)) return fail(400, { error: 'Shared registry is not configured.' });
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Artist ID is required' });

		const a = await db.select().from(artists).where(eq(artists.id, id)).get();
		if (!a) return fail(404, { error: 'Artist not found' });

		const result = await registrySubmit(renv, {
			kind: a.globalId ? 'update' : 'create',
			targetGlobalId: a.globalId ?? undefined,
			baseVersion: a.registryVersion ?? undefined,
			payload: {
				displayName: a.name,
				avatarUrl: a.avatarUrl,
				bio: null,
				socials: artistSocials(a)
			}
		});
		if (!result) return fail(502, { error: 'Registry submission failed (registry unreachable?).' });
		return { success: true, submitted: true };
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
