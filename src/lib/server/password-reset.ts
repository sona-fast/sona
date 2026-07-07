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
import * as m from '$lib/paraglide/messages';
import { isLocale, baseLocale } from '$lib/paraglide/runtime';
import type { Locale } from '$lib/paraglide/runtime';
import type { Database } from './db';

type Env = App.Platform['env'];

export const PASSWORD_RESET_SETTING = 'passwordResetToken';
/** Reset links are valid for 30 minutes. */
const RESET_TTL_MS = 30 * 60 * 1000;
/** Don't send a second reset email within this window (anti-flood). */
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;
/** Fallback sender address when RESEND_FROM is unset. The display name is the
 * fork's own siteName so headers identify the fork, not Sona (CAN-SPAM). */
const RESEND_FALLBACK_ADDRESS = 'onboarding@resend.dev';
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

/** Escape a string for safe interpolation into the HTML email body. */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** URL-safe random token (32 bytes, base64url). */
function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Handle a /admin/forgot submission. The CALLER must run this off the response
 * path (e.g. via `platform.ctx.waitUntil`) rather than awaiting it inline — a
 * match does real work (mint a token, write D1, call Resend) while a
 * non-match bails after one read, and awaiting either inline would leak which
 * one happened through response latency (a timing oracle for the recovery
 * address). Never signals which case it hit either way — the caller returns
 * one generic message regardless, so a wrong email, an unset adminEmail, and
 * an unset RESEND_API_KEY are indistinguishable (no account enumeration).
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
	const siteName = (await getRawSetting(db, 'siteName'))?.trim() || APP_NAME;
	// Pin the link to the site's own canonical URL when one is configured,
	// rather than whatever Host the request came in on — an alias/preview
	// domain hitting /admin/forgot would otherwise mail out a link to itself.
	const siteUrl = (await getRawSetting(db, 'siteUrl'))?.trim() || origin;
	const rawLocale = (await getRawSetting(db, 'siteLocale'))?.trim();
	const locale = isLocale(rawLocale) ? rawLocale : baseLocale;

	const sent = await sendResetEmail(env, apiKey, siteUrl, adminEmail, token, siteName, locale);
	// Persist the token hash ONLY once Resend has confirmed the send. Writing it
	// first (the old order) meant a failed/timed-out send invalidated a prior
	// valid link and started the resend cooldown, locking an operator out during
	// exactly the outage they're trying to recover from. On failure we simply
	// leave whatever row (if any) already exists untouched.
	if (!sent) return;
	const record: StoredReset = {
		tokenHash: await hashToken(token),
		expiresAt: new Date(now + RESET_TTL_MS).toISOString(),
		requestedAt: new Date(now).toISOString()
	};
	await setRawSetting(db, PASSWORD_RESET_SETTING, JSON.stringify(record));
}

/** Build the reset link + transactional copy and POST it to Resend. Best-effort:
 * a send failure (or timeout) is logged and swallowed (the caller's response
 * stays generic) — it returns whether the send succeeded so the caller can
 * decide whether the token is safe to persist. */
async function sendResetEmail(
	env: Env | undefined,
	apiKey: string,
	origin: string,
	to: string,
	token: string,
	siteName: string,
	locale: Locale
): Promise<boolean> {
	const link = new URL('/admin/reset', origin);
	link.searchParams.set('token', token);
	// Header fields can't carry CR/LF or other control chars; strip them once for
	// both the From name and subject (both are built from cleanName).
	const cleanName = siteName.replace(/[\x00-\x1f\x7f]+/g, ' ');
	// siteName lands in an RFC-5322 display name, so emit it as a quoted-string
	// (escaping \ and ") — a raw comma/colon/quote would otherwise make Resend 422.
	const displayName = `"${cleanName.replace(/[\\"]/g, '\\$&')}"`;
	const from = env?.RESEND_FROM?.trim() || `${displayName} <${RESEND_FALLBACK_ADDRESS}>`;
	const subject = m.password_reset_email_subject({ siteName: cleanName }, { locale });
	const url = link.toString();
	const text =
		`${m.password_reset_email_intro({ siteName }, { locale })}\n\n` +
		`${m.password_reset_email_cta({}, { locale })}: ${url}\n\n` +
		`${m.password_reset_email_expires({}, { locale })}\n\n` +
		`${m.password_reset_email_ignore({}, { locale })}`;
	// Neutral wrapper: this email speaks AS the fork, not Sona — no Sona wordmark,
	// no product branding, siteName is the identity. Single column, inline styles,
	// no images/external resources (email-client-safe). siteName is escaped since
	// it lands in HTML (fed into the {siteName} slot pre-escaped, below); the
	// link is a URL we minted.
	const safeName = escapeHtml(siteName);
	const safeUrl = escapeHtml(url);
	const html =
		`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="background-color:#f4f4f5;"><tr><td align="center" style="padding:32px 16px;">` +
		`<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">` +
		`<tr><td style="padding:8px 8px 18px 8px;font-size:18px;font-weight:bold;color:#18181b;">${safeName}</td></tr>` +
		`<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">` +
		`<div style="font-size:20px;line-height:1.3;font-weight:bold;color:#18181b;padding-bottom:16px;">${m.password_reset_email_heading({}, { locale })}</div>` +
		`<div style="font-size:15px;line-height:1.6;color:#3f3f46;padding-bottom:20px;">${m.password_reset_email_intro({ siteName: safeName }, { locale })}</div>` +
		`<div style="padding-bottom:20px;"><a href="${safeUrl}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-size:15px;font-weight:500;text-decoration:none;padding:12px 20px;border-radius:8px;">${m.password_reset_email_cta({}, { locale })}</a></div>` +
		`<div style="font-size:14px;line-height:1.6;color:#52525b;padding-bottom:6px;">${m.password_reset_email_or_paste({}, { locale })}</div>` +
		`<div style="font-size:14px;line-height:1.6;padding-bottom:20px;word-break:break-all;"><a href="${safeUrl}" style="color:#3f3f46;">${safeUrl}</a></div>` +
		`<div style="font-size:14px;line-height:1.6;color:#52525b;padding-bottom:8px;">${m.password_reset_email_expires({}, { locale })}</div>` +
		`<div style="font-size:14px;line-height:1.6;color:#52525b;">${m.password_reset_email_ignore({}, { locale })}</div>` +
		`</td></tr></table></td></tr></table></body></html>`;

	try {
		const resp = await fetch(RESEND_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ from, to, subject, html, text }),
			signal: AbortSignal.timeout(RESEND_TIMEOUT_MS)
		});
		if (!resp.ok) {
			// Log the response body, not just the status — Resend's 4xx bodies carry
			// the actual reason (e.g. an unverified domain), which the status alone
			// doesn't tell you.
			console.error(`Resend password-reset send failed: ${resp.status} ${await resp.text()}`);
			return false;
		}
		return true;
	} catch (e) {
		console.error('Resend password-reset send error:', e instanceof Error ? e.message : e);
		return false;
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
