import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { shareHasContent } from '$lib/server/presence';
import type { PageServerLoad } from './$types';

// Content-presence gate (#42): with neither contact source configured, a fresh
// fork 404s here instead of serving a near-empty page. See shareHasContent for
// what counts as content and why a D1 failure surfaces (→ 500 "retry"
// semantics) instead of decaying into a false 404.
export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	if (!(await shareHasContent(db))) error(404, 'Not found');
	return {};
};
