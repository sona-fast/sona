/**
 * Remove C0 controls and DEL. Shared by every guard that runs a protocol
 * denylist against a user-supplied URL, so the guards cannot strip different
 * character sets and disagree about what they are inspecting.
 */
export function stripControlChars(s: string): string {
	return s.replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * Sanitize a URL — reject javascript: and data: protocols, enforce max length.
 * Returns the URL if valid, null if not.
 */
export function sanitizeUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	// Strip C0 controls and DEL before any check below. Browsers remove tab, LF
	// and CR from a URL at parse time, so every guard here has to run on the
	// string the browser will end up with, not the one we were handed: `/\t/host`
	// passes the protocol-relative check as root-relative and is then read as
	// `//host`, pointing at an external origin. That was the live bypass; the same
	// split against `javascript:` only ever produced a value the URL parser
	// rejects, so it is covered here as hardening rather than as a fix.
	//
	// Strip BEFORE the trim, not after: most C0 characters are not whitespace, so
	// a leading one survives trim() and leaves the spaces behind it in place —
	// enough to walk '<NUL>   javascript:alert(1)' past the protocol check too.
	// These characters are never legal unescaped in a URL, so removing them
	// cannot damage a legitimate value.
	const trimmed = stripControlChars(url).trim();
	if (!trimmed) return null;
	if (trimmed.length > 2048) return null;

	// Block dangerous protocols
	const lower = trimmed.toLowerCase();
	if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
		return null;
	}

	// Root-relative path — the /img/<key> form storage falls back to when no
	// public CDN URL is configured. Same-origin by construction; prefixing
	// https:// would corrupt it into an external-looking URL.
	// ('//host' and '/\\host' are protocol-relative in browsers — not root-relative.)
	if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
		return trimmed;
	}

	// Add https:// if no protocol present
	if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
		return 'https://' + trimmed;
	}

	return trimmed;
}

/**
 * Normalize a site URL used to build links in outgoing email (e.g. the password
 * reset): require an absolute https URL and strip any trailing slash. Returns
 * null for empty input or anything that isn't a valid absolute https URL — so a
 * value `new URL()` would later throw on never gets stored, then swallowed at
 * send time. Shared by the admin Settings save and the setup-CLI seed so both
 * accept/reject identically.
 */
export function normalizeHttpsUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		if (new URL(trimmed).protocol !== 'https:') return null;
	} catch {
		return null;
	}
	return trimmed.replace(/\/+$/, '');
}

/**
 * Minimal email shape check (not full RFC 5322) — just enough to catch a typo
 * before it silently breaks password-recovery delivery at send time.
 */
export function isValidEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Sanitize a text input — trim, enforce max length.
 *
 * slice() counts UTF-16 code units, so a cap landing inside an astral character
 * (an emoji, most of them two units) would leave a lone high surrogate at the
 * end. That string is not well-formed UTF-8, and encodeURIComponent throws on
 * it — which is how a stray emoji in a 100-character field takes out the con
 * card's PNG save. Drop the half character instead — anywhere in the string, and
 * either half, matching what the card's own renderer strips. Whole pairs match
 * first so that real emoji survive.
 */
export function sanitizeText(text: string | null | undefined, maxLength = 500): string {
	if (!text) return '';
	return text
		.trim()
		.slice(0, maxLength)
		.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ''));
}

/**
 * Sanitize a tag name — lowercase, alphanumeric + hyphens only.
 */
export function sanitizeTag(tag: string): string {
	return tag
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.slice(0, 50);
}
