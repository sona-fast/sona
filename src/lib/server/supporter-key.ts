import { formatDate } from '$lib/index';

// Ed25519 SPKI (DER) public key, base64, that the sona.fast issuer signs
// supporter keys with. Baked in so verification needs no network and no config.
// The matching private key never leaves sona.fast; forks only ever verify.
const PRODUCTION_PUBLIC_KEY_SPKI_B64 =
	'MCowBQYDK2VwAyEAdp+EN2BNJtE39Atre285kSmqFJZRNu//j7brdS1hwNc=';

/** Decoded supporter-key payload (v1). `exp` is unix seconds (end-of-day UTC). */
interface SupporterKeyPayload {
	v: 1;
	login: string;
	tier: number;
	exp: number;
}

/**
 * Result of verifying a pasted supporter key. `expired` still carries the
 * decoded payload so the UI can show "expired YYYY.MM.DD"; the other invalid
 * reasons carry nothing (there's no trustworthy payload to show).
 */
export type SupporterKeyResult =
	| { valid: true; login: string; tier: number; expiresAt: Date }
	| { valid: false; reason: 'expired'; login: string; tier: number; expiresAt: Date }
	| { valid: false; reason: 'malformed' | 'bad-signature' };

/** Decode a standard base64 string to bytes. Returns null on bad input.
 * Cross-runtime: uses atob (present in Workers and Node). */
function base64ToBytes(b64: string): Uint8Array | null {
	try {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** Decode a base64url token segment (no padding) to bytes. Returns null if it
 * isn't valid base64url — a segment carrying standard-base64 chars is malformed. */
function base64urlToBytes(segment: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
	const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
	const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
	return base64ToBytes(b64 + pad);
}

function isPayload(v: unknown): v is SupporterKeyPayload {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	return p.v === 1 && typeof p.login === 'string' && typeof p.tier === 'number' && typeof p.exp === 'number';
}

/**
 * Verify a supporter key. Format (pinned to the sona.fast issuer):
 * `base64url(payloadJson) + "." + base64url(signature)`, where the signature is
 * Ed25519 over the UTF-8 bytes of the base64url payload segment.
 *
 * All whitespace is stripped first — the settings UI wraps the stored key, and a
 * copy-paste round-trip through that display injects newlines/spaces.
 *
 * @param publicKeySpkiB64 test-only override of the verifying key; production
 * callers omit it and the baked-in issuer key is used.
 */
export async function verifySupporterKey(
	token: string,
	now: Date,
	publicKeySpkiB64: string = PRODUCTION_PUBLIC_KEY_SPKI_B64
): Promise<SupporterKeyResult> {
	const stripped = token.replace(/\s+/g, '');
	const dot = stripped.indexOf('.');
	if (dot <= 0 || dot !== stripped.lastIndexOf('.')) return { valid: false, reason: 'malformed' };
	const payloadSeg = stripped.slice(0, dot);
	const sigSeg = stripped.slice(dot + 1);

	const sigBytes = base64urlToBytes(sigSeg);
	const payloadBytes = base64urlToBytes(payloadSeg);
	if (!sigBytes || !payloadBytes) return { valid: false, reason: 'malformed' };

	const spki = base64ToBytes(publicKeySpkiB64);
	if (!spki) return { valid: false, reason: 'malformed' };

	let ok = false;
	try {
		const key = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'Ed25519' }, false, ['verify']);
		ok = await crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			sigBytes as BufferSource,
			new TextEncoder().encode(payloadSeg) as BufferSource
		);
	} catch {
		return { valid: false, reason: 'bad-signature' };
	}
	if (!ok) return { valid: false, reason: 'bad-signature' };

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return { valid: false, reason: 'malformed' };
	}
	if (!isPayload(payload)) return { valid: false, reason: 'malformed' };

	const { login, tier, exp } = payload;
	const expiresAt = new Date(exp * 1000);
	if (now.getTime() >= expiresAt.getTime()) {
		return { valid: false, reason: 'expired', login, tier, expiresAt };
	}
	return { valid: true, login, tier, expiresAt };
}

/**
 * The "valid until" / "expired" display date (dotted YYYY.MM.DD, the repo
 * standard). `exp` is end-of-day UTC, so the last covered calendar day is
 * `exp - 1 second` read in UTC — that's the date the key actually covers.
 */
export function supporterKeyDisplayDate(expiresAt: Date): string {
	const d = new Date(expiresAt.getTime() - 1000);
	const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
	const da = String(d.getUTCDate()).padStart(2, '0');
	return formatDate(`${d.getUTCFullYear()}-${mo}-${da}`);
}

/** A valid key within this many days of expiry gets the "expiring soon"
 * treatment (SONA-114): countdown on the settings card plus the admin-wide
 * re-mint notice. Fixed rather than scaled — at the issuer's 45-day window,
 * 7 days is a comfortable re-mint margin. */
export const EXPIRY_WARN_DAYS = 7;

/** Within this many days of expiry the warning enters its 'final' phase: an
 * early-phase dismissal stops matching and the admin-wide notice re-shows for
 * a last-chance warning (see the admin layout load's dismissal cookie). */
export const EXPIRY_FINAL_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * Whole days until the key stops working, rounded up. `exp` is end-of-day UTC,
 * so 1 means the key expires today (its last covered day) and 0 or less means
 * it has already expired.
 */
export function supporterKeyDaysRemaining(expiresAt: Date, now: Date): number {
	return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

/** Client-facing supporter-key status shared by the settings page and the
 * admin layout. Never contains the decoded payload beyond what the UI shows,
 * and never the token itself — the settings load (which alone needs it for the
 * truncated key record) attaches it separately, so a spread of this status in
 * the layout payload structurally cannot leak the key. */
export interface SupporterKeyStatus {
	state: 'valid' | 'expired';
	validUntil: string;
	/** Days until expiry (1 = expires today); 0 for the expired state. */
	daysRemaining: number;
	/** True when valid and within EXPIRY_WARN_DAYS of expiry. */
	expiringSoon: boolean;
}

/**
 * Shape a verification result for display. Null for a token that no longer
 * verifies at all (issuer key rotated, corruption) — callers fall through to
 * their empty state. Pure, so tests can drive it with a synthetic result.
 */
export function supporterKeyStatusFromResult(
	res: SupporterKeyResult,
	now: Date
): SupporterKeyStatus | null {
	if (res.valid) {
		const daysRemaining = supporterKeyDaysRemaining(res.expiresAt, now);
		return {
			state: 'valid',
			validUntil: supporterKeyDisplayDate(res.expiresAt),
			daysRemaining,
			expiringSoon: daysRemaining <= EXPIRY_WARN_DAYS
		};
	}
	if (res.reason === 'expired') {
		return {
			state: 'expired',
			validUntil: supporterKeyDisplayDate(res.expiresAt),
			daysRemaining: 0,
			expiringSoon: false
		};
	}
	return null;
}

/** Verify a stored token and shape the result for display (empty token → null). */
export async function resolveSupporterKeyStatus(token: string, now: Date): Promise<SupporterKeyStatus | null> {
	if (!token) return null;
	return supporterKeyStatusFromResult(await verifySupporterKey(token, now), now);
}
