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
	updateCommission
} from '$lib/server/commissions';
import type { Actions, PageServerLoad } from './$types';

// Readable whether or not the gate is open. A closed gate shows the entry
// read-only, with Delete entry still offered.
export const load: PageServerLoad = async ({ params, platform }) => {
	const id = parseId(params.id);
	if (id === null) error(404, 'Entry not found');
	const db = getDb(platform!.env.DB);
	const [entry, choices, gate] = await Promise.all([
		loadCommission(db, id),
		loadCommissionChoices(db),
		commissionGateView(db, platform?.env)
	]);
	if (!entry) error(404, 'Entry not found');
	return { entry, ...choices, gate };
};

export const actions = {
	save: async ({ params, request, platform }) => {
		const id = parseId(params.id);
		if (id === null) return fail(404, { missing: true });
		const db = getDb(platform!.env.DB);
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });

		const data = await request.formData();
		const parsed = parseCommissionForm(data);
		if (!parsed.ok) return fail(400, { errors: parsed.errors });
		const refErrors = await checkCommissionRefs(db, parsed.input);
		if (Object.keys(refErrors).length > 0) return fail(400, { errors: refErrors });

		// A save without the version the form loaded with can't prove it isn't
		// stale, so it's refused the same way.
		const version = data.get('version');
		const result =
			typeof version === 'string' && version
				? await updateCommission(db, id, parsed.input, version)
				: 'stale';
		if (result === 'stale') {
			// Stale, or deleted since the form loaded: both leave nothing to save.
			if (!(await loadCommission(db, id))) return fail(404, { missing: true });
			return fail(409, { stale: true });
		}
		redirect(303, '/admin/commissions');
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
