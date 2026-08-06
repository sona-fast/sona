import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { conventions } from '$lib/server/db/schema';
import { eq, asc, and, isNull } from 'drizzle-orm';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { fetchConsFyiEvents, findConsFyiEvent, fetchAttendingEvents, blueskyHandle } from '$lib/server/consfyi';
import { getSettings } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

const STATUSES = ['confirmed', 'maybe', 'considering'] as const;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function normStatus(raw: unknown): string {
	return (STATUSES as readonly string[]).includes(raw as string) ? (raw as string) : 'confirmed';
}

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const all = await db.select().from(conventions).orderBy(asc(conventions.startDate));

	// Offer cons.fyi events that are still upcoming and not already on the schedule.
	const today = new Date().toISOString().slice(0, 10);
	const addedSourceIds = new Set(all.map((c) => c.sourceId).filter(Boolean));
	const feed = await fetchConsFyiEvents();
	const available = feed.filter((e) => e.endDate >= today && !addedSourceIds.has(e.id));

	return { conventions: all, available };
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
			url: event.url || null,
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

		await db.insert(conventions).values({
			name,
			location: sanitizeText(data.get('location') as string, 120) || null,
			startDate,
			endDate: isoDate.test(endRaw) ? endRaw : null,
			url: sanitizeUrl(data.get('url') as string) || null,
			status: normStatus(data.get('status'))
		});

		return { success: true };
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
			.select({ sourceId: conventions.sourceId, timezone: conventions.timezone })
			.from(conventions);
		const existing = new Set(rows.map((r) => r.sourceId).filter(Boolean));
		// Rows already on the schedule that have no zone yet: either they were added
		// before the column existed, or the feed had no zone at the time. Filling
		// these in here is what keeps the timezone rollout free of a manual backfill.
		const needsZone = new Set(rows.filter((r) => r.sourceId && !r.timezone).map((r) => r.sourceId));

		let added = 0;
		let backfilled = 0;
		for (const e of events) {
			if (existing.has(e.id)) {
				// Already on the schedule, but with no zone. Never overwrites a zone
				// that is already set.
				if (e.timezone && needsZone.has(e.id)) {
					await db
						.update(conventions)
						.set({ timezone: e.timezone })
						.where(and(eq(conventions.sourceId, e.id), isNull(conventions.timezone)));
					backfilled++;
				}
				continue;
			}
			await db.insert(conventions).values({
				name: e.name,
				location: e.location || null,
				startDate: e.startDate,
				endDate: e.endDate || null,
				url: e.url || null,
				status: 'confirmed',
				sourceId: e.id,
				timezone: e.timezone || null
			});
			added++;
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
