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
import { sanitizeUrl } from './validate';
import {
	isRegistryEnabled,
	registryDelta,
	registrySearch,
	firstHandle,
	SOCIAL_URL_KEYS,
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

// Map a registry record's socials onto the local artist *Url columns. The
// registry is untrusted cross-tenant input, so every URL is run through
// sanitizeUrl (dropping javascript:/data:/vbscript:) before it can be stored and
// later rendered into href/src on public pages.
function socialsToColumns(socials: Record<string, string>): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	// The registry payload is untrusted — `socials` may be null / not an object.
	// Guard so a malformed record can't throw and wedge the whole sync batch.
	const s = socials && typeof socials === 'object' ? socials : {};
	for (const k of SOCIAL_URL_KEYS) out[k] = sanitizeUrl(s[k]);
	return out;
}

// Serialize a registry record's former identities for the local `aliases` column.
// Like socials, alias URLs are untrusted cross-tenant input, so every one is run
// through sanitizeUrl before it can be stored and later rendered into href on
// public pages. Empty/absent → null (the "no aliases" state).
function aliasesToColumn(aliases: RegistryArtist['aliases']): string | null {
	if (!aliases || aliases.length === 0) return null;
	const clean = aliases
		.filter((a) => a && typeof a.displayName === 'string' && a.displayName)
		.map((a) => {
			const socials: Record<string, string> = {};
			for (const [k, v] of Object.entries(a.socials ?? {})) {
				const url = sanitizeUrl(v);
				if (url) socials[k] = url;
			}
			return { displayName: a.displayName, socials };
		});
	return clean.length ? JSON.stringify(clean) : null;
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

			const now = new Date().toISOString();

			// Merged: re-point the local link to the surviving artist so the fork
			// doesn't stay bound to a dead id. Clear the version so the survivor
			// (whose updatedAt the registry bumps on merge) refreshes on a later pass.
			if (ra.status === 'merged' && ra.mergedInto) {
				await db
					.update(artists)
					.set({ globalId: ra.mergedInto, registryVersion: null, registrySyncedAt: now })
					.where(eq(artists.id, local.id));
				refreshed++;
				continue;
			}
			// Tombstoned (takedown) records: don't copy their data over local rows.
			if (ra.status !== 'active') continue;

			const avatar = sanitizeUrl(ra.avatarUrl);
			const base = { registryVersion: ra.version, registrySyncedAt: now };
			if (settings.registryOverridesLocal) {
				// Authoritative refresh: registry wins (URLs sanitized).
				await db
					.update(artists)
					.set({
						name: ra.displayName,
						avatarUrl: avatar,
						...socialsToColumns(ra.socials),
						aliases: aliasesToColumn(ra.aliases),
						...base
					})
					.where(eq(artists.id, local.id));
			} else {
				// Respect local edits: only fill an empty avatar; keep name/socials.
				await db
					.update(artists)
					.set({ avatarUrl: local.avatarUrl || avatar, aliases: aliasesToColumn(ra.aliases), ...base })
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
		// Don't link two local rows to the same registry artist (only one would
		// ever refresh). The unique index on global_id also enforces this.
		const already = await db
			.select({ id: artists.id })
			.from(artists)
			.where(eq(artists.globalId, match.globalId))
			.get();
		if (already) continue;
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
