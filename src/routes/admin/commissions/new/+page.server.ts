import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { commissionGateView, commissionLedgerEnabled } from '$lib/server/commission-gate';
import {
	checkCommissionRefs,
	createCommission,
	loadCommissionChoices,
	parseCommissionForm
} from '$lib/server/commissions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const [choices, gate] = await Promise.all([loadCommissionChoices(db), commissionGateView(db, platform?.env)]);
	return { ...choices, gate };
};

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		// The gate first: a closed gate refuses before the form is even read.
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });

		const parsed = parseCommissionForm(await request.formData());
		if (!parsed.ok) return fail(400, { errors: parsed.errors });
		const refErrors = await checkCommissionRefs(db, parsed.input);
		if (Object.keys(refErrors).length > 0) return fail(400, { errors: refErrors });

		await createCommission(db, parsed.input);
		redirect(303, '/admin/commissions');
	}
} satisfies Actions;
