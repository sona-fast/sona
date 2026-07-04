import { getDb } from '$lib/server/db';
import { conventions } from '$lib/server/db/schema';
import { asc, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const today = new Date().toISOString().slice(0, 10);

	// Show cons that haven't finished yet (use end date when present), soonest first.
	const upcoming = await db
		.select()
		.from(conventions)
		.where(sql`COALESCE(${conventions.endDate}, ${conventions.startDate}) >= ${today}`)
		.orderBy(asc(conventions.startDate));

	return { conventions: upcoming };
};
