import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { resolveOrCreateArtist } from '$lib/server/sticker-import';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { normalizeSocialUrl, socialsToHandles } from '$lib/server/handle-normalize';
import type { RequestHandler } from './$types';

// POST /api/artists  (admin-only via hooks)
// Creates an artist and returns { id, name, status } so the sticker import review
// and other admin UIs can add an artist on the fly. When the artist was pulled
// from the shared registry (globalId present), this first tries to reuse/link an
// existing LOCAL artist instead of creating a duplicate:
//   - status 'reused'  → a local artist is already linked to this global_id
//   - status 'linked'  → an unlinked local artist matched by handle, now linked
//   - status 'created' → a new local artist was created
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = getDb(platform!.env.DB);
	const body = (await request.json().catch(() => null)) as Record<string, string> | null;
	if (!body) error(400, 'Invalid request body');

	const name = sanitizeText(body.name ?? '', 200);
	if (!name) error(400, 'Artist name is required');

	const socials = {
		twitterUrl: normalizeSocialUrl('twitter', body.twitter ?? '') || null,
		blueskyUrl: normalizeSocialUrl('bluesky', body.bluesky ?? '') || null,
		telegramUrl: normalizeSocialUrl('telegram', body.telegram ?? '') || null,
		furAffinityUrl: normalizeSocialUrl('furaffinity', body.furaffinity ?? '') || null,
		deviantArtUrl: normalizeSocialUrl('deviantart', body.deviantart ?? '') || null,
		patreonUrl: normalizeSocialUrl('patreon', body.patreon ?? '') || null,
		instagramUrl: normalizeSocialUrl('instagram', body.instagram ?? '') || null
	};

	// Optional shared-registry link (when the artist was pulled from the registry).
	const globalId = typeof body.globalId === 'string' && body.globalId ? body.globalId : null;
	const rv = globalId ? Number(body.registryVersion) : NaN;
	const registryVersion = Number.isFinite(rv) ? rv : null;

	if (globalId) {
		// 1. Already linked locally → reuse it.
		const byGid = await db
			.select({ id: artists.id, name: artists.name })
			.from(artists)
			.where(eq(artists.globalId, globalId))
			.get();
		if (byGid) return json({ id: byGid.id, name: byGid.name, status: 'reused' });

		// 2. An UNLINKED local artist that matches by handle → link it (no duplicate).
		const incoming = socialsToHandles(socials);
		if (incoming.length > 0) {
			const want = new Set(incoming.map((h) => `${h.platform} ${h.handleNorm}`));
			const locals = await db.select().from(artists);
			for (const a of locals) {
				if (a.globalId) continue;
				if (socialsToHandles(a).some((h) => want.has(`${h.platform} ${h.handleNorm}`))) {
					await db
						.update(artists)
						.set({ globalId, registryVersion, registrySyncedAt: new Date().toISOString() })
						.where(eq(artists.id, a.id));
					return json({ id: a.id, name: a.name, status: 'linked' });
				}
			}
		}
	}

	// 3. No existing match → create.
	const id = await resolveOrCreateArtist(db, {
		artistId: null,
		artistName: name,
		...socials,
		globalId,
		registryVersion,
		avatarUrl: globalId ? sanitizeUrl(body.avatarUrl ?? '') || null : null
	});
	if (!id) error(400, 'Could not create artist');

	return json({ id, name, status: 'created' });
};
