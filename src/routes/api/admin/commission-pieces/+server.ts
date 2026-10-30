import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseId } from '$lib/server/commissions';
import { listLinkablePieces, pickerScope } from '$lib/server/commission-link';
import type { RequestHandler } from './$types';

// GET /api/admin/commission-pieces?entry=ID&scope=artist|all&q=TEXT (admin-only
// via hooks: everything under /api except /api/cron/ requires the admin session).
//
// Link a piece (SONA-236): the pieces the picker dialog offers for an entry.
// Reading, so never gated; the link itself is.
export const GET: RequestHandler = async ({ url, platform }) => {
	const entryId = parseId(url.searchParams.get('entry'));
	if (entryId === null) error(404, 'Entry not found');
	const list = await listLinkablePieces(getDb(platform!.env.DB), entryId, {
		scope: pickerScope(url.searchParams.get('scope')),
		query: url.searchParams.get('q') ?? ''
	});
	if (!list) error(404, 'Entry not found');
	return json(list);
};
