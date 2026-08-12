import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { getRawSetting } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

// The /ai disclosure page is a per-fork toggle (SONA-167). Like every other
// visibility rule on this site the gate lives in the server load, not the
// client: a fork that turned the page off 404s the route itself, the same
// plain not-found a nonexistent path gets, and the footer link disappears with
// it.
//
// The gate reads the RAW row rather than trusting the parent's flag, and fails
// CLOSED. getSettings swallows D1 errors and returns DEFAULTS, where
// aiPageEnabled is this module's one default-ON boolean — so on a read failure
// the parent's flag says "on" whether or not the owner ever said so, and this
// page would publish first-person claims ("none of the art is AI-generated")
// for an owner who declined them in the wizard. getRawSetting propagates
// instead of swallowing, so a failure here means not-published, not published.
// The footer link still fails open, matching navGateFlags' documented policy:
// a stray link during a blip is cheap, publishing unaffirmed claims is not.
//
// The override text is returned HERE, not by the (public) layout: the layout
// payload rides every public page, and a disabled page's text must not keep
// shipping to every visitor. Same cached settings read the layout uses, so
// this adds no D1 round-trip on a warm isolate.
export const load: PageServerLoad = async ({ parent, platform }) => {
	const { settings } = await parent();
	if (!settings.aiPageEnabled) error(404, 'Not found');

	const db = getReadDb(platform!.env.DB);
	try {
		const stored = await getRawSetting(db, 'aiPageEnabled');
		// Absent means ON only for installs that pre-date the feature; an
		// explicit 'false' is an owner who opted out, in the wizard or Settings.
		if (stored === 'false') error(404, 'Not found');
		// Raw reads here too: getSettings self-catches D1 errors and returns
		// DEFAULTS, which would render the built-in copy for an owner who
		// overrode it precisely because a default claim is wrong for them.
		const [aiPageText, aiPageUpdatedAt] = await Promise.all([
			getRawSetting(db, 'aiPageText'),
			getRawSetting(db, 'aiPageUpdatedAt')
		]);
		return { aiPageText: aiPageText ?? '', aiPageUpdatedAt: aiPageUpdatedAt ?? '' };
	} catch (e) {
		// Rethrow our own 404 unchanged; any read failure becomes one too, so a
		// blip can neither publish a declined page nor substitute the default
		// copy for an owner who overrode it precisely because it is wrong.
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(404, 'Not found');
	}
};
