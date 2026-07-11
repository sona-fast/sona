/**
 * Sanitize a URL — reject javascript: and data: protocols, enforce max length.
 * Returns the URL if valid, null if not.
 */
export function sanitizeUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const trimmed = url.trim();
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
 */
export function sanitizeText(text: string | null | undefined, maxLength = 500): string {
	if (!text) return '';
	return text.trim().slice(0, maxLength);
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
