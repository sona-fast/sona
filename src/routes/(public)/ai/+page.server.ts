import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The /ai disclosure page is a per-fork toggle, DEFAULT ON (SONA-167). Like
// every visibility rule on this site the gate lives in the server load, not
// the client: a fork that turned the page off 404s the route itself, the same
// plain not-found a nonexistent path gets — the footer link disappears with it
// (Footer renders it conditionally from the same setting).
export const load: PageServerLoad = async ({ parent }) => {
	const { settings } = await parent();
	if (!settings.aiPageEnabled) throw error(404, 'Not found');
	return {};
};
