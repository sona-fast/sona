import { qrSvg } from '$lib/qr';
import type { PageServerLoad } from './$types';

/**
 * The fullscreen scan target, held up from the operator's phone.
 *
 * Deliberately OUTSIDE the (paths) group and outside /admin. The admin panel
 * validates its session against D1 on every request and fails closed, and the
 * (paths) layout reads settings from D1 as well, so both are the wrong place for
 * the one screen that has to work on convention wifi. This route touches no
 * database at all: the payload comes from the request URL, and the site name
 * comes from the root layout, which already falls back to a default when D1 is
 * unreachable.
 *
 * The encoded target is /connect and never this page. A printed con card lives
 * outside the app and outlives its state, so pointing it at a route that could
 * later be gated would turn every printed card into dead paper.
 */
export const load: PageServerLoad = ({ url }) => {
	const connectUrl = new URL('/connect', url.origin).toString();
	return {
		qr: qrSvg(connectUrl),
		connectUrl,
		// Host and path without the scheme: what a reader would type or say aloud
		// if the scan fails.
		displayUrl: `${url.host}/connect`
	};
};
