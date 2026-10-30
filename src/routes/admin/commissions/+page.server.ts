import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { commissionGateView, commissionLedgerEnabled } from '$lib/server/commission-gate';
import { deleteCommission, listCommissions, parseId } from '$lib/server/commissions';
import { loadAddedNotice } from '$lib/server/commission-gallery';
import { linkFailure, linkFormValues, linkPiece } from '$lib/server/commission-link';
import type { Actions, PageServerLoad } from './$types';

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

export const actions = {
	// A row's Delete, the same delete as the entry page's. Never gated: removing
	// their own private data doesn't depend on a key.
	delete: async ({ request, platform }) => {
		const id = parseId((await request.formData()).get('id'));
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await deleteCommission(db, id))) return fail(404, { missing: true });
		return { deleted: true };
	},

	// A Delivered row's Link a piece. It changes the entry, so it's gated like
	// Save. The row holds no form to go out of date, so the link guards on the
	// entry as the server reads it.
	link: async ({ request, platform }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });
		const { imageId, deliveredOn } = linkFormValues(data);
		if (imageId === null) return fail(400, { link: 'none_picked' });
		const result = await linkPiece(db, id, imageId, { version: null, deliveredOn });
		if (!result.ok) return linkFailure(result.reason);
		return { linked: id };
	}
} satisfies Actions;
