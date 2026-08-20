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
 * The payload stays a bare /connect URL: no per-card token, no per-scan
 * parameter. A card is printed, so there is no way to give notice at the point
 * of collection, and anything unique per recipient would turn a scan into
 * collection of the scanner's data. A single shared source marker would be fine
 * if attribution is ever wanted; a minted one never is.
 *
 * The encoded target is /connect and never this page. A printed con card lives
 * outside the app and outlives its state, so pointing it at a route that could
 * later be gated would turn every printed card into dead paper.
 *
 * It also encodes url.origin, where the printed card prefers settings.siteUrl.
 * That divergence is on purpose: reading siteUrl means the D1 round trip this
 * route exists to avoid, and a screen QR is transient in a way a printed card is
 * not, so a wrong host here is re-scannable rather than permanent. The one
 * consequence is that an operator who opened admin on a preview alias hands out
 * that host for as long as the screen is up.
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
