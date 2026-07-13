// Cloudflare Turnstile server-side verification for the admin login.
//
// Enforcement is the CALLER's decision: it is gated on whether a fork has
// configured a TURNSTILE_SECRET (see the login action). This helper is only
// reached once a secret is present, and it FAILS CLOSED — a missing token, a
// forged/expired token, or an unreachable siteverify all return false so the
// login is rejected. (This is deliberately the opposite of sona-site's waitlist
// helper, which returns true when unconfigured; here the "unconfigured → skip"
// choice is made by the caller, never by treating an unverifiable token as a pass.)
//
// siteverify enforces single-use tokens natively — a token can be redeemed once —
// so the caller must pass a fresh token each attempt and never cache/reuse one.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token against Cloudflare siteverify. Returns true ONLY on a
 * genuine `success: true` response; false for an empty token or any failure.
 * @param secret  the fork's TURNSTILE_SECRET (caller has already confirmed it is set)
 * @param token   the `cf-turnstile-response` value from the posted form
 * @param ip      optional CF-Connecting-IP, passed to siteverify as remoteip
 */
export async function verifyTurnstile(secret: string, token: string, ip?: string): Promise<boolean> {
	if (!token) return false;
	try {
		const body: Record<string, string> = { secret, response: token };
		if (ip) body.remoteip = ip;
		const r = await fetch(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const d = (await r.json().catch(() => ({}))) as { success?: boolean } | null;
		return !!(d && d.success);
	} catch {
		return false;
	}
}
