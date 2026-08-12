import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { getRawSettings } from '$lib/server/settings';
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
// shipping to every visitor.
//
// These reads deliberately bypass the settings cache, so this route costs one
// D1 round-trip that a cached read would not. That is the price of failing
// closed: the cache is populated by getSettings, which swallows read errors
// and hands back DEFAULTS.
export const load: PageServerLoad = async ({ parent, platform }) => {
	const { settings } = await parent();
	if (!settings.aiPageEnabled) error(404, 'Not found');

	const db = getReadDb(platform!.env.DB);
	try {
		const raw = await getRawSettings(db, ['aiPageEnabled', 'aiPageText', 'aiPageUpdatedAt']);
		// Absent means ON only for installs that pre-date the feature; an
		// explicit 'false' is an owner who opted out, in the wizard or Settings.
		if (raw.aiPageEnabled === 'false') error(404, 'Not found');
		return {
			aiPageText: raw.aiPageText ?? '',
			aiPageUpdatedAt: raw.aiPageUpdatedAt ?? ''
		};
	} catch (e) {
		// Rethrow our own 404 unchanged; any read failure becomes one too, so a
		// blip can neither publish a declined page nor substitute the default
		// copy for an owner who overrode it precisely because it is wrong.
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(404, 'Not found');
	}
};
