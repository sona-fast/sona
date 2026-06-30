// Background sync between the local artists table and the shared registry.
//
// Two jobs, both best-effort and bounded:
//  1. Refresh linked artists (global_id set) from the registry delta feed.
//  2. Backfill: for local-only artists, handle-match against the registry and
//     stamp global_id when found (this is how a fork learns the id of an artist
//     it submitted once the maintainer approves it).
//
// Never runs on a render path — only the /api/cron/sync-artists endpoint (and a
// manual "Sync now" admin action) call this.

import { eq, isNull, and, ne } from 'drizzle-orm';
import { artists } from './db/schema';
import { getRawSetting, setRawSetting } from './settings';
import type { SiteSettings } from './settings';
import {
	isRegistryEnabled,
	registryDelta,
	registrySearch,
	firstHandle,
	type RegistryArtist
} from './registry';
import type { Database } from './db';

type Env = App.Platform['env'];

const LAST_SYNC_KEY = 'registryLastSync';
const MAX_PAGES = 10;
const BACKFILL_CAP = 25;

export interface SyncSummary {
	skipped?: boolean;
	refreshed: number;
	linked: number;
	scanned: number;
}

/** Map a registry record's socials onto the local artist *Url columns. */
function socialsToColumns(socials: Record<string, string>) {
	return {
		twitterUrl: socials.twitterUrl ?? null,
		blueskyUrl: socials.blueskyUrl ?? null,
		telegramUrl: socials.telegramUrl ?? null,
		furAffinityUrl: socials.furAffinityUrl ?? null,
		deviantArtUrl: socials.deviantArtUrl ?? null,
		patreonUrl: socials.patreonUrl ?? null,
		instagramUrl: socials.instagramUrl ?? null
	};
}

export async function syncArtists(
	db: Database,
	env: Env | undefined,
	settings: SiteSettings
): Promise<SyncSummary> {
	if (!isRegistryEnabled(env)) return { skipped: true, refreshed: 0, linked: 0, scanned: 0 };

	let refreshed = 0;
	let linked = 0;
	let scanned = 0;

	// ── 1. Refresh linked artists from the delta feed ──────────────────────────
	const lastSync = (await getRawSetting(db, LAST_SYNC_KEY)) ?? undefined;
	let cursor: string | undefined;
	let maxUpdatedAt = lastSync ?? '';
	for (let page = 0; page < MAX_PAGES; page++) {
		const { artists: batch, nextCursor }: { artists: RegistryArtist[]; nextCursor: string | null } =
			await registryDelta(env, cursor ? { cursor } : { updatedSince: lastSync, limit: 100 });
		if (batch.length === 0) break;

		for (const ra of batch) {
			if (ra.updatedAt > maxUpdatedAt) maxUpdatedAt = ra.updatedAt;
			const local = await db
				.select()
				.from(artists)
				.where(eq(artists.globalId, ra.globalId))
				.get();
			if (!local) continue;

			const base = {
				registryVersion: ra.version,
				registrySyncedAt: new Date().toISOString()
			};
			if (settings.registryOverridesLocal) {
				// Authoritative refresh: registry wins.
				await db
					.update(artists)
					.set({
						name: ra.displayName,
						avatarUrl: ra.avatarUrl,
						...socialsToColumns(ra.socials),
						...base
					})
					.where(eq(artists.id, local.id));
			} else {
				// Respect local edits: only fill an empty avatar; keep name/socials.
				await db
					.update(artists)
					.set({ avatarUrl: local.avatarUrl || ra.avatarUrl, ...base })
					.where(eq(artists.id, local.id));
			}
			refreshed++;
		}

		if (!nextCursor) break;
		cursor = nextCursor;
	}
	if (maxUpdatedAt && maxUpdatedAt !== lastSync) {
		await setRawSetting(db, LAST_SYNC_KEY, maxUpdatedAt);
	}

	// ── 2. Backfill: stamp global_id onto local-only artists by handle match ────
	const unlinked = await db
		.select()
		.from(artists)
		.where(and(isNull(artists.globalId), ne(artists.name, '')))
		.limit(BACKFILL_CAP);

	for (const a of unlinked) {
		const handle = firstHandle(a);
		if (!handle) continue;
		scanned++;
		const matches = await registrySearch(env, { handle });
		const match = matches[0];
		if (!match) continue;
		await db
			.update(artists)
			.set({
				globalId: match.globalId,
				registryVersion: match.version,
				registrySyncedAt: new Date().toISOString()
			})
			.where(eq(artists.id, a.id));
		linked++;
	}

	return { refreshed, linked, scanned };
}
