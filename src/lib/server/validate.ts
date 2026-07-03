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
	if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
		return trimmed;
	}

	// Add https:// if no protocol present
	if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
		return 'https://' + trimmed;
	}

	return trimmed;
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
