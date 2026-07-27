import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { resolveOrCreateArtist } from '$lib/server/sticker-import';
import { getSettings } from '$lib/server/settings';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { normalizeSocialUrl, socialsToHandles } from '$lib/server/handle-normalize';
import type { RequestHandler } from './$types';

// POST /api/artists  (admin-only via hooks)
// Creates an artist and returns { id, name, status } so the sticker import review
// and other admin UIs can add an artist on the fly. When the artist was pulled
// from the shared registry (globalId present), this first tries to reuse/link an
// existing LOCAL artist instead of creating a duplicate — and because importing
// from the registry is an explicit "give me the registry's copy", the registry
// fields OVERRIDE the local ones (unlike the background sync, where local wins):
//   - status 'reused'  → a local artist was already linked to this global_id;
//                        its fields were refreshed from the registry copy
//   - status 'linked'  → an unlinked local artist matched by handle — linked,
//                        and refreshed the same way
//   - status 'created' → a new local artist was created
export const POST: RequestHandler = async ({ request, platform, url }) => {
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
		// The registry copy as sent by the import dialog. An explicit import means
		// "take the registry's version", so registry values override local ones —
		// but a field the registry does NOT have never blanks a local value (only
		// present fields are applied; same never-overwrite-with-nothing rule the
		// avatar refreshes follow).
		const registryAvatar = sanitizeUrl(body.avatarUrl ?? '') || null;
		// `name` is the dialog's field, but for a registry-linked create it always
		// equals the registry's canonical displayName: NewArtistDialog drops the
		// globalId link the moment the operator edits the name (onNameInput), so a
		// globalId-bearing request can't carry a name that has diverged from
		// displayName. The pull payload intentionally doesn't send displayName
		// separately — name follows the dialog by design.
		const registryFields: Record<string, string | number | null> = {
			name,
			registrySyncedAt: new Date().toISOString()
		};
		for (const [k, v] of Object.entries(socials)) if (v) registryFields[k] = v;
		if (registryAvatar) registryFields.avatarUrl = registryAvatar;
		// Guard registryVersion like socials/avatar: a missing/non-finite version must
		// not blank an existing local registry_version (the block's never-blank rule).
		if (registryVersion !== null) registryFields.registryVersion = registryVersion;

		// 1. Already linked locally → refresh it from the registry copy.
		const byGid = await db
			.select({ id: artists.id })
			.from(artists)
			.where(eq(artists.globalId, globalId))
			.get();
		if (byGid) {
			await db.update(artists).set(registryFields).where(eq(artists.id, byGid.id));
			return json({ id: byGid.id, name, status: 'reused' });
		}

		// 2. An UNLINKED local artist that matches by handle → link it (no duplicate)
		//    and refresh it the same way.
		const incoming = socialsToHandles(socials);
		if (incoming.length > 0) {
			const want = new Set(incoming.map((h) => `${h.platform} ${h.handleNorm}`));
			const locals = await db.select().from(artists);
			for (const a of locals) {
				if (a.globalId) continue;
				if (socialsToHandles(a).some((h) => want.has(`${h.platform} ${h.handleNorm}`))) {
					await db
						.update(artists)
						.set({ ...registryFields, globalId })
						.where(eq(artists.id, a.id));
					return json({ id: a.id, name, status: 'linked' });
				}
			}
		}
	}

	// 3. No existing match → create. Re-host a socially-resolved avatar to our CDN
	// (a registry-provided avatarUrl is used as-is and isn't re-resolved).
	const settings = await getSettings(db);
	const id = await resolveOrCreateArtist(db, {
		artistId: null,
		artistName: name,
		...socials,
		globalId,
		registryVersion,
		avatarUrl: globalId ? sanitizeUrl(body.avatarUrl ?? '') || null : null,
		rehost: { env: platform?.env, settings, origin: url.origin, keyHint: name }
	});
	if (!id) error(400, 'Could not create artist');

	return json({ id, name, status: 'created' });
};
