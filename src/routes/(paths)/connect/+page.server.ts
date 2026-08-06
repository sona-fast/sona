import { getDb } from '$lib/server/db';
import { conventions } from '$lib/server/db/schema';
import { asc, sql } from 'drizzle-orm';
import { isLiveNow, hasEnded, upcomingCutoff } from '$lib/convention-window';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const now = new Date();

	// A day of slack on the SQL filter: this compares a UTC date against bare
	// calendar dates, so a convention whose closing day is still running in a
	// western zone would otherwise be dropped before anything could notice it is
	// live. hasEnded() below does the real, zone-aware filtering.
	const rows = await db
		.select()
		.from(conventions)
		.where(sql`COALESCE(${conventions.endDate}, ${conventions.startDate}) >= ${upcomingCutoff(now)}`)
		.orderBy(asc(conventions.startDate));

	// The convention the operator is at right now: confirmed, and inside its own
	// dates in its own zone. A "considering" row never qualifies, however well the
	// dates line up.
	const liveConvention = rows.find((c) => isLiveNow(c, now)) ?? null;

	// Everything still ahead, minus the live one so it never appears twice.
	const upcoming = rows.filter((c) => c.id !== liveConvention?.id && !hasEnded(c, now));

	return { conventions: upcoming, liveConvention };
};
