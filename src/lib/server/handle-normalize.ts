// Handle normalization for matching a registry artist against LOCAL artists when
// pulling. Mirrors the registry's src/lib/normalize.ts so the two agree on what
// counts as "the same handle". Pure — no DB.
//
// The platform table + bare-handle normalizer live in the client-safe
// `$lib/handle-classify` (the New Artist combobox needs them too); re-exported
// here so existing server importers keep their `handle-normalize` import path.

import { sanitizeUrl } from './validate';
import {
	HOST_PREFIXES,
	SOCIAL_KEY_TO_PLATFORM,
	normalizeHandle,
	type Platform
} from '../handle-classify';

export { SOCIAL_KEY_TO_PLATFORM, normalizeHandle, type Platform };

export interface NormalizedHandle {
	platform: Platform;
	handleNorm: string;
}

export function socialsToHandles(socials: Record<string, unknown>): NormalizedHandle[] {
	const out: NormalizedHandle[] = [];
	for (const [key, platform] of Object.entries(SOCIAL_KEY_TO_PLATFORM)) {
		const raw = socials[key];
		if (typeof raw !== 'string') continue;
		const handleNorm = normalizeHandle(platform, raw);
		if (handleNorm) out.push({ platform, handleNorm });
	}
	return out;
}

/** True if two socials objects share at least one normalized (platform, handle). */
export function handlesOverlap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const bh = socialsToHandles(b);
	if (bh.length === 0) return false;
	const set = new Set(bh.map((h) => `${h.platform} ${h.handleNorm}`));
	return socialsToHandles(a).some((h) => set.has(`${h.platform} ${h.handleNorm}`));
}

/**
 * Platforms we can build a canonical profile URL for. Adds `furtrack` to the
 * registry-matching {@link Platform} set (Furtrack plays no part in registry
 * handle-matching, so it stays out of SOCIAL_KEY_TO_PLATFORM / HOST_PREFIXES).
 */
export type SocialPlatform = Platform | 'furtrack';

/** Canonical profile-URL prefix, used to build a URL from a bare handle. */
const PROFILE_URL_PREFIX: Record<SocialPlatform, string> = {
	twitter: 'https://twitter.com/',
	bluesky: 'https://bsky.app/profile/',
	telegram: 'https://t.me/',
	furaffinity: 'https://www.furaffinity.net/user/',
	furtrack: 'https://www.furtrack.com/user/',
	deviantart: 'https://www.deviantart.com/',
	patreon: 'https://www.patreon.com/',
	instagram: 'https://www.instagram.com/'
};

/** Host fragments that mark input as "already a profile URL" for a platform. */
const SOCIAL_HOST_PREFIXES: Record<SocialPlatform, string[]> = {
	...HOST_PREFIXES,
	furtrack: ['furtrack.com/']
};

/**
 * Normalize a social field into a storable URL, so a bare handle no longer becomes a
 * broken `https://<handle>` link (what sanitizeUrl does on its own).
 *
 * - Empty/blank → '' (unchanged).
 * - Already looks like a URL — an `http(s)://` scheme, a path `/`, or the platform's own
 *   domain — → run through sanitizeUrl, preserving behavior for pasted profile links.
 * - Otherwise treat it as a bare handle: strip a leading `@` and build the canonical
 *   profile URL. A handle that isn't a plausible username (whitespace, a `javascript:`
 *   style scheme, other junk) yields '' rather than a bogus URL.
 *
 * A bare Bluesky handle such as `name.bsky.social` has dots but no scheme/slash/known
 * domain, so it is deliberately treated as a handle → https://bsky.app/profile/name.bsky.social.
 */
export function normalizeSocialUrl(
	platform: SocialPlatform,
	input: string | null | undefined
): string {
	if (!input) return '';
	const trimmed = input.trim();
	if (!trimmed) return '';

	const lower = trimmed.toLowerCase();
	if (
		lower.startsWith('javascript:') ||
		lower.startsWith('data:') ||
		lower.startsWith('vbscript:')
	) {
		return '';
	}

	const domains = (SOCIAL_HOST_PREFIXES[platform] ?? []).map((h) => h.replace(/\/.*$/, ''));
	const looksLikeUrl =
		lower.startsWith('http://') ||
		lower.startsWith('https://') ||
		trimmed.includes('/') ||
		domains.some((d) => lower.includes(d));
	if (looksLikeUrl) return sanitizeUrl(trimmed) ?? '';

	// Bare handle: keep letters, digits, and . _ - (Bluesky handles contain dots).
	const handle = trimmed.replace(/^@+/, '');
	if (!handle || !/^[A-Za-z0-9._-]+$/.test(handle)) return '';
	return PROFILE_URL_PREFIX[platform] + handle;
}
