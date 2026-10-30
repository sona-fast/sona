import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { commissionGateView, commissionLedgerEnabled } from '$lib/server/commission-gate';
import {
	checkCommissionRefs,
	deleteCommission,
	loadCommission,
	loadCommissionChoices,
	parseCommissionForm,
	parseId,
	submittedValues,
	updateCommission
} from '$lib/server/commissions';
import { linkFailure, linkFormValues, linkPiece, listLinkablePieces, pickerScope, unlinkPiece } from '$lib/server/commission-link';
import { canAddToGallery } from '$lib/commissions';
import { localeCurrency } from '$lib/currencies';
import type { Actions, PageServerLoad } from './$types';

// Readable whether or not the gate is open. A closed gate shows the entry
// read-only, with Delete entry still offered.
export const load: PageServerLoad = async ({ params, platform, request, url }) => {
	const id = parseId(params.id);
	if (id === null) error(404, 'Entry not found');
	const db = getDb(platform!.env.DB);
	const [entry, choices, gate] = await Promise.all([
		loadCommission(db, id),
		loadCommissionChoices(db),
		commissionGateView(db, platform?.env)
	]);
	if (!entry) {
		// After a save without JavaScript, the page renders the action's answer:
		// an entry deleted elsewhere keeps the form, with the alert and what was
		// typed, rather than a 404 page. A delete of it is done either way.
		if (request.method === 'POST' && url.searchParams.has('/delete')) redirect(303, '/admin/commissions');
		if (request.method !== 'POST' || !gate.open) error(404, 'Entry not found');
		return { entry: null, ...choices, gate, picker: null, localeCurrency: localeCurrency(request.headers.get('accept-language')) };
	}
	// Without the page's script, Link a piece opens this page with ?link=pick,
	// which lists the pieces in the page.
	const picking =
		gate.open &&
		entry.piece === null &&
		canAddToGallery(entry.status) &&
		url.searchParams.get('link') === 'pick';
	const picker = picking
		? await listLinkablePieces(db, id, {
				scope: pickerScope(url.searchParams.get('scope')),
				query: url.searchParams.get('q') ?? ''
			})
		: null;
	return { entry, ...choices, gate, picker, localeCurrency: localeCurrency(request.headers.get('accept-language')) };
};

export const actions = {
	save: async ({ params, request, platform }) => {
		const id = parseId(params.id);
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });

		const data = await request.formData();
		const version = data.get('version');
		// A refusal sends back what was typed, so a save without JavaScript keeps
		// it, and the version it was sent with: the reloaded entry's own would let
		// the next Save overwrite a change made since the form loaded.
		const sent = () => ({ values: submittedValues(data), version: typeof version === 'string' ? version : '' });
		const parsed = parseCommissionForm(data);
		if (!parsed.ok) return fail(400, { errors: parsed.errors, ...sent() });
		const refErrors = await checkCommissionRefs(db, parsed.input);
		if (Object.keys(refErrors).length > 0) return fail(400, { errors: refErrors, ...sent() });

		// A save without the version the form loaded with can't prove it isn't
		// stale, so it's refused the same way.
		const result =
			typeof version === 'string' && version
				? await updateCommission(db, id, parsed.input, version)
				: 'stale';
		if (result === 'stale') {
			// Stale, or deleted since the form loaded: both leave nothing to save.
			if (!(await loadCommission(db, id))) return fail(404, { missing: true, ...sent() });
			return fail(409, { stale: true, ...sent() });
		}
		redirect(303, '/admin/commissions');
	},

	// Link a piece and Unlink change the entry, so they're gated like Save and
	// carry the version the form loaded with, as a save does.
	link: async ({ params, request, platform }) => {
		const id = parseId(params.id);
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });
		const data = await request.formData();
		const version = data.get('version');
		if (typeof version !== 'string' || !version) return fail(409, { stale: true });
		const { imageId, deliveredOn } = linkFormValues(data);
		if (imageId === null) return fail(400, { link: 'none_picked' });
		const result = await linkPiece(db, id, imageId, { version, deliveredOn });
		if (!result.ok) return linkFailure(result.reason);
		return { linked: true, version: result.version };
	},

	unlink: async ({ params, request, platform }) => {
		const id = parseId(params.id);
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });
		const version = (await request.formData()).get('version');
		if (typeof version !== 'string' || !version) return fail(409, { stale: true });
		const result = await unlinkPiece(db, id, version);
		if (!result.ok) return linkFailure(result.reason);
		return { unlinked: true, version: result.version };
	},

	// Never gated: removing their own private data doesn't depend on a key.
	delete: async ({ params, platform }) => {
		const id = parseId(params.id);
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await deleteCommission(db, id))) return fail(404, { missing: true });
		redirect(303, '/admin/commissions');
	}
} satisfies Actions;
