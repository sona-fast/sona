import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { commissionGateView, commissionLedgerEnabled } from '$lib/server/commission-gate';
import {
	checkCommissionRefs,
	createCommission,
	loadCommissionChoices,
	parseCommissionForm,
	submittedValues
} from '$lib/server/commissions';
import { localeCurrency } from '$lib/currencies';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, request }) => {
	const db = getDb(platform!.env.DB);
	const [choices, gate] = await Promise.all([loadCommissionChoices(db), commissionGateView(db, platform?.env)]);
	// The browser's languages say where the owner is, for the currency picker.
	return { ...choices, gate, localeCurrency: localeCurrency(request.headers.get('accept-language')) };
};

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		// The gate first: a closed gate refuses before the form is even read.
		if (!(await commissionLedgerEnabled(db, platform?.env))) return fail(403, { gated: true });

		// A refusal sends back what was typed, so a save without JavaScript keeps it.
		const data = await request.formData();
		const parsed = parseCommissionForm(data);
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: submittedValues(data) });
		const refErrors = await checkCommissionRefs(db, parsed.input);
		if (Object.keys(refErrors).length > 0) return fail(400, { errors: refErrors, values: submittedValues(data) });

		await createCommission(db, parsed.input);
		redirect(303, '/admin/commissions');
	}
} satisfies Actions;
