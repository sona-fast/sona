import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, images, stickers, stickerPacks } from '$lib/server/db/schema';
import { eq, sql, like, or } from 'drizzle-orm';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { sanitizeText } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import {
	isRegistryEnabled,
	resolveRegistryEnv,
	registrySubmit,
	registrySubmissionsMine,
	registryGetArtist,
	artistSocials,
	parseAliases
} from '$lib/server/registry';
import { fetchRegistryCatalog } from '$lib/server/registry-import';
import { artistDiffersFromRegistry } from '$lib/server/registry-diff';
import { approvedSubmissionGlobalId, artistInCatalog } from '$lib/server/registry-submissions';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import { parseDismissed, addDismissed } from '$lib/server/registry-dismissals';
import type { Actions, PageServerLoad } from './$types';

// site_settings key: JSON array of registry submission ids the contributor has
// dismissed, so an acknowledged rejection stops re-surfacing on every load.
const DISMISSED_KEY = 'registryDismissedSubmissions';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 25;
	// Server-side name search so it matches across the WHOLE set, not just the
	// current page. SQLite LIKE is case-insensitive for ASCII. Also match former
	// (AKA) names the row displays as "formerly …" — the aliases JSON array's
	// displayName fields, not the raw blob (a bare LIKE would false-positive on
	// URLs/keys inside the JSON). Guards, in order, so a bad shape can't throw and
	// 500 the page: json_valid rejects malformed/NULL text; json_type = 'array'
	// keeps json_each off a top-level scalar/object (and drops phantom matches from
	// an object's nested values); je.type = 'object' skips bare-string array
	// elements so json_extract only ever sees an object. parseAliases tolerates all
	// these shapes, so the search must too.
	const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
	const like_ = `%${q}%`;
	const whereClause = q
		? or(
				like(artists.name, like_),
				sql`(json_valid(${artists.aliases}) AND json_type(${artists.aliases}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${artists.aliases}) AS je WHERE je.type = 'object' AND json_extract(je.value, '$.displayName') LIKE ${like_}))`
			)
		: undefined;

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

	// What's each artist's standing with the registry? Match an update by its
	// target global_id, a create by the proposed display name. We surface the most
	// recent pending/rejected submission per artist (with the reviewer's note) so
	// the contributor sees the outcome instead of it vanishing silently.
	const renv = await resolveRegistryEnv(db, platform?.env);
	const registryEnabled = isRegistryEnabled(renv);
	const registryStatus: Record<
		number,
		{ status: 'pending' | 'rejected'; note: string | null; submissionId: number }
	> = {};
	// Linked artists that already match the registry catalog — their "submit" is a
	// no-op and gets disabled. Fails open: an empty/unreachable catalog leaves it {}.
	const upToDate: Record<number, boolean> = {};
	if (registryEnabled) {
		const dismissed = parseDismissed(await getRawSetting(db, DISMISSED_KEY));
		// A dismissed rejection is acknowledged locally — drop it so it stops showing.
		const subs = (await registrySubmissionsMine(renv)).filter((s) => !dismissed.has(s.id));

		// One catalog fetch, reused twice: to stamp registry_version at link time
		// (just below) and to compute per-artist up-to-date state (further down).
		const catalog = await fetchRegistryCatalog(renv);
		const byGlobalId = new Map(catalog.map((r) => [r.globalId, r]));

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
			// Same runtime guard as the submit backstop: a malformed catalog entry
			// (non-numeric version) must not reach the integer column.
			const v = byGlobalId.get(linkedId)?.version;
			await db
				.update(artists)
				.set({
					globalId: linkedId,
					// Stamp the current registry version too — without it the next share
					// goes out as an update with no baseVersion and the registry 400s
					// (#71). If the catalog fetch failed or the entry is missing, still
					// link (submitToRegistry resolves the version as a backstop).
					registryVersion: typeof v === 'number' ? v : null,
					registrySyncedAt: new Date().toISOString()
				})
				.where(eq(artists.id, a.id));
			a.globalId = linkedId; // reflect in this render so the badge + guard update
		}

		for (const a of allArtists) {
			// registrySubmissionsMine is newest-first, so the first match is the latest.
			const sub = subs.find((s) => {
				if (s.targetGlobalId) return !!a.globalId && s.targetGlobalId === a.globalId;
				try {
					return (JSON.parse(s.payload).displayName as string) === a.name;
				} catch {
					return false;
				}
			});
			if (sub && (sub.status === 'pending' || sub.status === 'rejected')) {
				registryStatus[a.id] = { status: sub.status, note: sub.reviewerNote ?? null, submissionId: sub.id };
			}
		}

		// Compare each linked artist against its catalog entry. A linked artist
		// that already matches has nothing to submit; an unlinked artist that's
		// already in the catalog would be a duplicate — disable "submit" for both
		// so an already-shared artist can't be resubmitted.
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
		registryStatus,
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

	submitToRegistry: async ({ request, platform, url }) => {
		const env = platform?.env;
		const db = getDb(env!.DB);
		const renv = await resolveRegistryEnv(db, env);
		if (!isRegistryEnabled(renv)) return fail(400, { error: 'Shared registry is not configured.' });
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Artist ID is required' });

		const a = await db.select().from(artists).where(eq(artists.id, id)).get();
		if (!a) return fail(404, { error: 'Artist not found' });

		// Belt-and-braces for #71: a linked artist with no stored registry version
		// (e.g. linked by the status-poll path before it stamped versions, or an
		// AKA approval the daily sync can't backfill) would go out as an update
		// with no baseVersion — which the registry hard-rejects (400). Resolve the
		// current version now, persist it, and use it; if that fails, refuse the
		// doomed submit with a clear error instead.
		let baseVersion = a.registryVersion ?? undefined;
		if (a.globalId && baseVersion === undefined) {
			const reg = await registryGetArtist(renv, a.globalId);
			if (typeof reg?.version !== 'number') {
				return fail(502, {
					error: "Couldn't resolve the artist's registry version — try again or run the artist sync."
				});
			}
			baseVersion = reg.version;
			await db.update(artists).set({ registryVersion: reg.version }).where(eq(artists.id, a.id));
		}

		// Report this fork's own host so the registry can self-heal a null key label
		// (attribution). Derived the same way the connect-registry flow labels the key:
		// the configured site name, else this site's hostname.
		const siteLabel = (await getRawSetting(db, 'siteName'))?.trim() || url.hostname;

		const result = await registrySubmit(renv, {
			kind: a.globalId ? 'update' : 'create',
			targetGlobalId: a.globalId ?? undefined,
			baseVersion,
			siteLabel,
			payload: {
				displayName: a.name,
				avatarUrl: a.avatarUrl,
				bio: null,
				socials: artistSocials(a)
			}
		});
		if (!result) return fail(502, { error: 'Registry submission failed (registry unreachable?).' });
		// A refusal (e.g. the artist was removed from the registry and can't be
		// resubmitted) — show the registry's own reason, not a generic failure.
		if (result.error) return fail(409, { error: result.error });
		return { success: true, submitted: true };
	},

	// Acknowledge a rejected submission: record its id locally so the rejected badge
	// stops re-appearing. We keep the (immutable) registry record; this is a local
	// dismissal, not a delete.
	dismissRejection: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const submissionId = Number(data.get('submissionId'));
		if (!submissionId) return fail(400, { error: 'Submission ID is required' });
		const dismissed = parseDismissed(await getRawSetting(db, DISMISSED_KEY));
		const capped = addDismissed(dismissed, submissionId);
		await setRawSetting(db, DISMISSED_KEY, JSON.stringify(capped));
		return { success: true, dismissed: true };
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
