import { getDb } from '$lib/server/db';
import { commissionGateView } from '$lib/server/commission-gate';
import { listCommissions } from '$lib/server/commissions';
import type { PageServerLoad } from './$types';

// Always readable: the gate covers adding and changing entries, never reading
// the owner's own data.
export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const [entries, gate] = await Promise.all([listCommissions(db), commissionGateView(db, platform?.env)]);
	return { entries, gate };
};
