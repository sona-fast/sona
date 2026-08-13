// Worker fixture for the supporter-key timezone integration test (SONA-119).
// It imports the REAL expiry module — the point is to run that exact code under
// workerd's ICU, not a re-implementation of it.
import {
	supporterKeyValidUntil,
	supporterKeyDaysRemaining,
	viewerTimeZone
} from '../../../src/lib/server/supporter-key-expiry';

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const zone = viewerTimeZone(url.searchParams.get('tz') ?? undefined);
		const expiresAtMs = Number(url.searchParams.get('exp'));
		const nowMs = Number(url.searchParams.get('now'));
		return Response.json({
			// What viewerTimeZone actually resolved the cookie to — UTC when the
			// runtime rejects it, which is the failure this test exists to catch.
			zone,
			validUntil: supporterKeyValidUntil(expiresAtMs, zone),
			daysRemaining: supporterKeyDaysRemaining(expiresAtMs, nowMs, zone)
		});
	}
};
