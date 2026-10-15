import { getDb } from '$lib/server/db';
import { commissionGateView } from '$lib/server/commission-gate';
import { listCommissions } from '$lib/server/commissions';
import { loadAddedNotice } from '$lib/server/commission-gallery';
import type { PageServerLoad } from './$types';

// Always readable: the gate covers adding and changing entries, never reading
// the owner's own data. After an upload from an entry, `added` (the entry) and
// `variants` (new variant ids) build the notice from the saved rows.
export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);
	const [entries, gate, added] = await Promise.all([
		listCommissions(db),
		commissionGateView(db, platform?.env),
		loadAddedNotice(db, url.searchParams.get('added'), url.searchParams.get('variants'))
	]);
	return { entries, gate, added };
};
