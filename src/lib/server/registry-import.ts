// Import artists from the shared registry catalog into the local artists table.
//
// Complements artist-sync, which is enrichment-only: sync refreshes/links artists
// the fork already has but can never CREATE one. This module fetches the full
// active catalog from the delta endpoint (fork-key authenticated) and creates local rows for the
// registry artists this site doesn't have yet.
//
// Hard invariants (relied on by the admin "Import all" flow and its copy):
//  - a registry artist whose global_id is already linked locally is skipped;
//  - a registry artist that handle-matches an UNLINKED local artist is skipped
//    (prefer linking over duplicating — the artist-sync backfill links it on the
//    next sync pass; import never modifies the local row itself);
//  - existing local artists are NEVER modified or overwritten here — imports
//    only ever INSERT;
//  - idempotent: created artists are linked (global_id stamped), so a re-run
//    skips them and creates nothing new.
//
// Like the rest of the registry surface, this never runs on a render path —
// only the admin import endpoint calls it, and it degrades to a no-op when the
// registry is disabled or unreachable.

import { artists } from './db/schema';
import { sanitizeText, sanitizeUrl } from './validate';
import { handlesOverlap } from './handle-normalize';
import {
	isRegistryEnabled,
	isRegistryRefusal,
	registryDelta,
	type RegistryArtist,
	type RegistryRefusal
} from './registry';
import { socialsToColumns, aliasesToColumn } from './artist-sync';
import type { Database } from './db';

type Env = App.Platform['env'];

// Same paging bound as artist-sync: 10 pages × 100 = 1000 artists, far above the
// current catalog size, while keeping a misbehaving registry from looping us.
const MAX_PAGES = 10;

/**
 * The full ACTIVE registry catalog, paged from the delta endpoint (no
 * `updated_since`, so it walks the catalog from the beginning). Deduped by
 * global_id in case a record moves between pages mid-walk. Returns [] when the
 * registry is disabled or unreachable, and a RegistryRefusal when the registry
 * turned us away (4xx) — callers must show that rather than an empty catalog.
 */
export async function fetchRegistryCatalog(
	env: Env | undefined
): Promise<RegistryArtist[] | RegistryRefusal> {
	if (!isRegistryEnabled(env)) return [];
	const byId = new Map<string, RegistryArtist>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await registryDelta(env, cursor ? { cursor } : { limit: 100 });
		// A 4xx refusal (e.g. 401 from a bad/missing fork key) must not read as an
		// empty catalog — "0 artists to import" would hide a broken connection.
		if (isRegistryRefusal(result)) return result;
		const { artists: batch, nextCursor } = result;
		// A 200 with a malformed body (schema drift, an error page served as 200)
		// must degrade like an unreachable registry — not throw and 500 the caller.
		if (!Array.isArray(batch) || batch.length === 0) break;
		for (const ra of batch) {
			if (ra && ra.status === 'active' && ra.globalId) byId.set(ra.globalId, ra);
		}
		if (!nextCursor) break;
		cursor = nextCursor;
	}
	return [...byId.values()];
}

/** The subset of a local artist row the planner needs (socials via *Url keys). */
export type LocalArtistLike = { globalId: string | null } & Record<string, unknown>;

export interface ImportPlan {
	/** Active artists in the registry catalog. */
	total: number;
	toCreate: RegistryArtist[];
	/** Skipped: global_id already linked to a local artist. */
	skippedLinked: number;
	/** Skipped: an unlinked local artist shares a handle (backfill sync links it). */
	skippedHandleMatched: number;
}

/**
 * Partition the catalog against the local artists table. Pure — no DB, no
 * network — so the skip invariants are unit-testable in isolation.
 */
export function planImport(catalog: RegistryArtist[], locals: LocalArtistLike[]): ImportPlan {
	const linkedIds = new Set(locals.map((l) => l.globalId).filter(Boolean));
	const unlinked = locals.filter((l) => !l.globalId);

	const toCreate: RegistryArtist[] = [];
	let skippedLinked = 0;
	let skippedHandleMatched = 0;

	for (const ra of catalog) {
		if (linkedIds.has(ra.globalId)) {
			skippedLinked++;
			continue;
		}
		// Sanitized column shape on both sides so normalization sees the same keys
		// the /api/artists single-import path compares.
		const socials = socialsToColumns(ra.socials ?? {});
		if (unlinked.some((l) => handlesOverlap(l, socials))) {
			skippedHandleMatched++;
			continue;
		}
		toCreate.push(ra);
	}

	return { total: catalog.length, toCreate, skippedLinked, skippedHandleMatched };
}

export interface ImportResult extends Omit<ImportPlan, 'toCreate'> {
	created: number;
	/** Records that could not be inserted (empty name after sanitization, or an
	 * insert race on the unique global_id index). Never counts modified rows —
	 * import doesn't modify rows. */
	failed: number;
}

/**
 * Fetch the catalog and create every registry artist this site doesn't have
 * yet, stamping global_id/registry_version so artist-sync enriches them from
 * then on. INSERT-only — see the module invariants. Returns null when the
 * registry is disabled, or the RegistryRefusal when the registry turned us away
 * (importing nothing and reporting success would hide that).
 */
export async function importRegistryCatalog(
	db: Database,
	env: Env | undefined
): Promise<ImportResult | RegistryRefusal | null> {
	if (!isRegistryEnabled(env)) return null;

	const catalog = await fetchRegistryCatalog(env);
	if (isRegistryRefusal(catalog)) return catalog;
	const locals = await db.select().from(artists);
	const plan = planImport(catalog, locals);

	let created = 0;
	let failed = 0;
	const now = new Date().toISOString();

	for (const ra of plan.toCreate) {
		// Registry data is untrusted cross-tenant input: text length-capped, every
		// URL sanitized (same posture as artist-sync).
		const name = sanitizeText(ra.displayName ?? '', 200);
		if (!name) {
			failed++;
			continue;
		}
		try {
			await db.insert(artists).values({
				name,
				avatarUrl: sanitizeUrl(ra.avatarUrl),
				...socialsToColumns(ra.socials ?? {}),
				aliases: aliasesToColumn(ra.aliases),
				globalId: ra.globalId,
				registryVersion: ra.version,
				registrySyncedAt: now
			});
			created++;
		} catch {
			// Most likely a concurrent insert hit the unique global_id index. Never
			// fall back to updating the existing row — imports must not modify.
			failed++;
		}
	}

	return {
		total: plan.total,
		created,
		failed,
		skippedLinked: plan.skippedLinked,
		skippedHandleMatched: plan.skippedHandleMatched
	};
}
