import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { conventions, fursuitPhotos } from '$lib/server/db/schema';
import { eq, asc, and, isNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { fetchConsFyiEvents, findConsFyiEvent, fetchAttendingEvents, blueskyHandle } from '$lib/server/consfyi';
import { getSettings } from '$lib/server/settings';
import { isLiveNow } from '$lib/convention-window';
import { taggedFursuitPhoto } from '$lib/server/passport';
import type { Actions, PageServerLoad } from './$types';

const STATUSES = ['confirmed', 'maybe', 'considering'] as const;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function normStatus(raw: unknown): string {
	return (STATUSES as readonly string[]).includes(raw as string) ? (raw as string) : 'confirmed';
}

type Db = ReturnType<typeof getDb>;

/**
 * The FurTrack event a convention form submitted, as the value to store: null
 * for "none", else a tag some fursuit photo carries that no other convention is
 * linked to. `self` is the row being edited (null on create); its current tag
 * stays valid even once no photo carries it, so saving an unrelated change never
 * fails on a link the operator did not touch.
 */
async function eventTagFrom(
	db: Db,
	raw: FormDataEntryValue | null,
	self: { id: number; furtrackEvent: string | null } | null
): Promise<{ tag: string | null } | { error: string }> {
	if (typeof raw !== 'string' || !raw.trim()) return { tag: null };
	if (raw !== self?.furtrackEvent) {
		const onPhoto = await db
			.select({ id: fursuitPhotos.id })
			.from(fursuitPhotos)
			.where(and(eq(fursuitPhotos.event, raw), taggedFursuitPhoto))
			.limit(1)
			.get();
		if (!onPhoto) return { error: 'No fursuit photo has that FurTrack event. Pick one from the list.' };
	}
	const other = await db
		.select({ id: conventions.id, name: conventions.name })
		.from(conventions)
		.where(eq(conventions.furtrackEvent, raw))
		.get();
	if (other && other.id !== self?.id) {
		return { error: `That FurTrack event is already linked to ${other.name}. Set ${other.name} to None first.` };
	}
	return { tag: raw };
}

// The unique index on furtrack_event is the last word when two saves race past
// eventTagFrom's check; this turns its error into a form error. Drizzle wraps
// the driver's error ("UNIQUE constraint failed: conventions.furtrack_event"),
// so the cause chain is searched, not only the top message.
const TAG_RACE_ERROR = 'Another convention just took that FurTrack event. Reload the page to see which one.';

function isTagConflict(err: unknown): boolean {
	for (let e = err as { message?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
		if (String(e.message ?? '').includes('conventions.furtrack_event')) return true;
	}
	return false;
}

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const now = new Date();
	const all = await db.select().from(conventions).orderBy(asc(conventions.startDate));

	// The row the operator is standing at right now, resolved here rather than in
	// the component: the answer depends on the wall clock, and deciding it during
	// render would disagree between the server pass and hydration.
	const liveId = all.find((c) => isLiveNow(c, now))?.id ?? null;

	// Offer cons.fyi events that are still upcoming and not already on the schedule.
	const today = now.toISOString().slice(0, 10);
	const addedSourceIds = new Set(all.map((c) => c.sourceId).filter(Boolean));
	const feed = await fetchConsFyiEvents();
	const available = feed.filter((e) => e.endDate >= today && !addedSourceIds.has(e.id));

	// The tags the convention forms offer: every distinct event on the photos.
	const eventTags = (
		await db
			.selectDistinct({ event: fursuitPhotos.event })
			.from(fursuitPhotos)
			.where(taggedFursuitPhoto)
			.orderBy(asc(fursuitPhotos.event))
	).map((r) => r.event as string);

	return { conventions: all, available, liveId, eventTags };
};

export const actions = {
	// Add a convention picked from the cons.fyi feed.
	addFromSource: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const sourceId = (data.get('sourceId') as string) || '';
		if (!sourceId) return fail(400, { error: 'Pick a convention from the list' });

		const event = await findConsFyiEvent(sourceId);
		if (!event) return fail(400, { error: 'That convention is no longer in the cons.fyi feed' });

		const existing = await db.select().from(conventions).where(eq(conventions.sourceId, sourceId)).get();
		if (existing) return fail(400, { error: 'That convention is already on your schedule' });

		await db.insert(conventions).values({
			name: event.name,
			location: event.location || null,
			startDate: event.startDate,
			endDate: event.endDate || null,
			// Through the same gate as a hand-typed url. The feed is a third party,
			// and this value is rendered as an href on the public schedule.
			url: sanitizeUrl(event.url) || null,
			status: normStatus(data.get('status')),
			sourceId,
			timezone: event.timezone || null
		});
		return { success: true };
	},

	// Manual entry for cons not in the feed.
	create: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const name = sanitizeText(data.get('name') as string, 120);
		const startDate = ((data.get('startDate') as string) || '').slice(0, 10);

		if (!name) return fail(400, { error: 'Convention name is required' });
		if (!isoDate.test(startDate)) return fail(400, { error: 'A valid start date is required' });

		const endRaw = ((data.get('endDate') as string) || '').slice(0, 10);

		const event = await eventTagFrom(db, data.get('furtrackEvent'), null);
		if ('error' in event) return fail(400, { error: event.error });

		try {
			await db.insert(conventions).values({
				name,
				location: sanitizeText(data.get('location') as string, 120) || null,
				startDate,
				endDate: isoDate.test(endRaw) ? endRaw : null,
				url: sanitizeUrl(data.get('url') as string) || null,
				status: normStatus(data.get('status')),
				furtrackEvent: event.tag
			});
		} catch (err) {
			if (isTagConflict(err)) return fail(400, { error: TAG_RACE_ERROR });
			throw err;
		}

		return { success: true };
	},

	// Link a convention to its FurTrack event, change the link, or clear it.
	// A failure carries the row's id, so the page can tie the error to that
	// row's select.
	setEvent: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Convention ID is required' });

		const con = await db
			.select({ id: conventions.id, name: conventions.name, furtrackEvent: conventions.furtrackEvent })
			.from(conventions)
			.where(eq(conventions.id, id))
			.get();
		if (!con) return fail(400, { error: 'That convention is no longer on your schedule.' });

		const event = await eventTagFrom(db, data.get('furtrackEvent'), con);
		if ('error' in event) return fail(400, { error: event.error, eventId: id });

		try {
			await db.update(conventions).set({ furtrackEvent: event.tag }).where(eq(conventions.id, id));
		} catch (err) {
			if (isTagConflict(err)) return fail(400, { error: TAG_RACE_ERROR, eventId: id });
			throw err;
		}
		return {
			success: true,
			message: event.tag
				? `Linked ${con.name} to the FurTrack event “${event.tag}”.`
				: `${con.name} is no longer linked to a FurTrack event.`
		};
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Convention ID is required' });
		await db.delete(conventions).where(eq(conventions.id, id));
		return { success: true };
	},

	// Pull the cons marked "going" on cons.fyi (via your Bluesky labels) and add
	// any not already on the schedule.
	sync: async ({ platform }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const handle = blueskyHandle(settings.blueskyUrl);
		if (!handle) {
			return fail(400, { error: 'Add your Bluesky profile URL in Settings before syncing.' });
		}

		const events = await fetchAttendingEvents(handle);
		if (events.length === 0) {
			return {
				success: true,
				message: `Nothing to sync — no cons are marked “going” for @${handle} on cons.fyi (or the Bluesky URL in Settings is wrong).`
			};
		}

		const rows = await db
			.select({
				id: conventions.id,
				sourceId: conventions.sourceId,
				timezone: conventions.timezone,
				url: conventions.url
			})
			.from(conventions);
		const existing = new Set(rows.map((r) => r.sourceId).filter(Boolean));
		// Rows already on the schedule that have no zone yet: either they were added
		// before the column existed, or the feed had no zone at the time. Filling
		// these in here is what keeps the timezone rollout free of a manual backfill.
		const needsZone = new Set(rows.filter((r) => r.sourceId && !r.timezone).map((r) => r.sourceId));

		let added = 0;
		let backfilled = 0;
		// Collected rather than awaited one at a time: a sync can touch a dozen rows,
		// and D1 charges a subrequest per statement (the SONA-124 db.batch precedent).
		// The inserts ride the same batch as the backfills, so the whole sync is one
		// round trip and lands all-or-nothing rather than half-applied.
		const writes: BatchItem<'sqlite'>[] = [];
		// Rows the feed put here before the url gate existed still carry whatever
		// cons.fyi said at the time, and they are rendered as hrefs on the public
		// schedule. The rows are already read and the batch is already going, so
		// re-run the same gate over them: a javascript: url that got in earlier is
		// cleared on the next sync rather than waiting to be noticed. Feed rows
		// only: a hand-typed url passed the gate on its way in.
		for (const row of rows) {
			if (!row.sourceId || !row.url || sanitizeUrl(row.url)) continue;
			writes.push(db.update(conventions).set({ url: null }).where(eq(conventions.id, row.id)));
		}
		for (const e of events) {
			if (existing.has(e.id)) {
				// Already on the schedule, but with no zone. Never overwrites a zone
				// that is already set.
				if (e.timezone && needsZone.has(e.id)) {
					writes.push(
						db
							.update(conventions)
							.set({ timezone: e.timezone })
							.where(and(eq(conventions.sourceId, e.id), isNull(conventions.timezone)))
					);
					backfilled++;
				}
				continue;
			}
			writes.push(
				db.insert(conventions).values({
					name: e.name,
					location: e.location || null,
					startDate: e.startDate,
					endDate: e.endDate || null,
					// Same gate as the manual path: the feed is a third party and this
					// value becomes an href on the public schedule.
					url: sanitizeUrl(e.url) || null,
					status: 'confirmed',
					sourceId: e.id,
					timezone: e.timezone || null
				})
			);
			added++;
		}
		if (writes.length > 0) {
			await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
		}

		const parts: string[] = [];
		if (added > 0) parts.push(`Synced ${added} convention${added === 1 ? '' : 's'} from cons.fyi.`);
		if (backfilled > 0)
			parts.push(
				`Filled in the timezone for ${backfilled} convention${backfilled === 1 ? '' : 's'} already on your schedule.`
			);
		return {
			success: true,
			message:
				parts.length > 0
					? parts.join(' ')
					: `Already in sync — all ${events.length} con(s) you're going to are on your schedule.`
		};
	}
} satisfies Actions;
