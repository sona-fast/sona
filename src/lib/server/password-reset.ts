// Admin password recovery ("Forgot password") — single-admin, no migration.
//
// The active reset lives in a single site_settings row (`passwordResetToken`),
// NOT in the client-exposed SiteSettings — same handling as adminPasswordHash /
// adminEmail (see settings.ts). At most one reset is active at a time; a new
// request overwrites the row, a successful reset deletes it. The row stores only
// the token HASH (SHA-256 via hashToken), so a leaked DB never yields a usable
// reset link. Tokens are compared constant-time.
//
// The whole feature is gated on RESEND_API_KEY: with no key we can't send mail,
// so /admin/forgot silently no-ops (and still returns the generic response, so a
// caller can't tell configured from unconfigured — see the route).

import { hashToken, constantTimeEqual } from './admin-auth';
import { getRawSetting, setRawSetting } from './settings';
import { APP_NAME } from '$lib/config';
import type { Database } from './db';

type Env = App.Platform['env'];

export const PASSWORD_RESET_SETTING = 'passwordResetToken';
/** Reset links are valid for 30 minutes. */
export const RESET_TTL_MS = 30 * 60 * 1000;
/** Don't send a second reset email within this window (anti-flood). */
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;
const RESEND_DEFAULT_FROM = 'Sona <onboarding@resend.dev>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 5000;

interface StoredReset {
	tokenHash: string;
	expiresAt: string;
	requestedAt: string;
}

function parseStored(raw: string | null): StoredReset | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		if (typeof v?.tokenHash === 'string' && typeof v?.expiresAt === 'string' && typeof v?.requestedAt === 'string') {
			return v as StoredReset;
		}
	} catch {
		/* malformed row → treat as no active reset */
	}
	return null;
}

/** URL-safe random token (32 bytes, base64url). */
function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Handle a /admin/forgot submission. ALWAYS resolves without signalling whether
 * anything happened — the caller returns one generic message regardless, so a
 * wrong email, an unset adminEmail, and an unset RESEND_API_KEY are
 * indistinguishable (no account enumeration). Work is kept minimal on the
 * non-matching path (we bail before touching the token row or Resend).
 */
export async function requestPasswordReset(
	db: Database,
	env: Env | undefined,
	origin: string,
	submittedEmail: string
): Promise<void> {
	const adminEmail = (await getRawSetting(db, 'adminEmail'))?.trim();
	if (!adminEmail) return;

	// The feature is inert without a Resend key — nothing to send, so don't mint.
	const apiKey = env?.RESEND_API_KEY;
	if (!apiKey) return;

	const submitted = submittedEmail.trim().toLowerCase();
	if (!submitted || !constantTimeEqual(submitted, adminEmail.toLowerCase())) return;

	const now = Date.now();
	const existing = parseStored(await getRawSetting(db, PASSWORD_RESET_SETTING));
	// Cooldown: a still-fresh request means an email just went out — keep the
	// existing (valid) link and skip a resend rather than flooding the inbox and
	// invalidating the link the operator may already be following.
	if (existing && now - Date.parse(existing.requestedAt) < RESEND_COOLDOWN_MS) return;

	const token = generateToken();
	const record: StoredReset = {
		tokenHash: await hashToken(token),
		expiresAt: new Date(now + RESET_TTL_MS).toISOString(),
		requestedAt: new Date(now).toISOString()
	};
	await setRawSetting(db, PASSWORD_RESET_SETTING, JSON.stringify(record));

	const siteName = (await getRawSetting(db, 'siteName'))?.trim() || APP_NAME;
	await sendResetEmail(env, apiKey, origin, adminEmail, token, siteName);
}

/** Build the reset link + transactional copy and POST it to Resend. Best-effort:
 * a send failure (or timeout) is logged and swallowed so the caller's response
 * stays generic. */
async function sendResetEmail(
	env: Env | undefined,
	apiKey: string,
	origin: string,
	to: string,
	token: string,
	siteName: string
): Promise<void> {
	const link = new URL('/admin/reset', origin);
	link.searchParams.set('token', token);
	const from = env?.RESEND_FROM?.trim() || RESEND_DEFAULT_FROM;
	const subject = `Reset your ${siteName} admin password`;
	const text =
		`A password reset was requested for the admin account on ${siteName}.\n\n` +
		`Reset your password: ${link.toString()}\n\n` +
		`This link expires in 30 minutes.\n\n` +
		`If you didn't request this, you can ignore this email — your password is unchanged.`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
	try {
		const resp = await fetch(RESEND_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ from, to, subject, text }),
			signal: controller.signal
		});
		if (!resp.ok) {
			console.error(`Resend password-reset send failed: ${resp.status}`);
		}
	} catch (e) {
		console.error('Resend password-reset send error:', e instanceof Error ? e.message : e);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Validate a token from /admin/reset against the stored row: it must exist, be
 * unexpired, and match constant-time. Read-only — the caller deletes the row on
 * a successful reset.
 */
export async function validateResetToken(db: Database, token: string): Promise<boolean> {
	if (!token) return false;
	const stored = parseStored(await getRawSetting(db, PASSWORD_RESET_SETTING));
	if (!stored) return false;
	if (Date.now() > Date.parse(stored.expiresAt)) return false;
	const providedHash = await hashToken(token);
	return constantTimeEqual(providedHash, stored.tokenHash);
}
