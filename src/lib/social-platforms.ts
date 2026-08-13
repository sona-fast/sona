// Where each platform's profile path starts, and the one algorithm that walks
// it to the handle. Display ($lib/social-label) and registry matching
// (handle-classify's normalizeHandle) both read from here, so they cannot
// disagree about where a handle begins.
//
// Its own module rather than part of handle-classify: the public pages bundle
// these tables through $lib/social-label and have no use for the search
// classifier, which would otherwise ride along into their chunk.
//
// Pure and client-safe: no $lib/server imports.

export type Platform =
	| 'twitter'
	| 'bluesky'
	| 'telegram'
	| 'furaffinity'
	| 'deviantart'
	| 'patreon'
	| 'instagram';

export const HOST_PREFIXES: Record<Platform, string[]> = {
	twitter: ['twitter.com/', 'x.com/', 'mobile.twitter.com/'],
	bluesky: ['bsky.app/profile/', 'staging.bsky.app/profile/'],
	// 't.me/s/<channel>' (Telegram's public channel preview) must be tried before
	// the bare 't.me/' prefix, else every previewed channel collapses to 's'.
	telegram: ['t.me/s/', 't.me/', 'telegram.me/'],
	furaffinity: ['furaffinity.net/user/'],
	deviantart: ['deviantart.com/'],
	// 'patreon.com/c/<user>' (newer creator pages) must be tried before the bare
	// 'patreon.com/' prefix, else the username collapses to 'c'.
	patreon: ['patreon.com/c/', 'patreon.com/'],
	instagram: ['instagram.com/']
};

/**
 * Platforms we render or build profile URLs for. Adds `furtrack` to the
 * registry-matching {@link Platform} set (FurTrack plays no part in registry
 * handle-matching, so it stays out of SOCIAL_KEY_TO_PLATFORM / HOST_PREFIXES).
 */
export type SocialPlatform = Platform | 'furtrack';

/** {@link HOST_PREFIXES} widened to every platform we display a handle for. */
export const SOCIAL_HOST_PREFIXES: Record<SocialPlatform, string[]> = {
	...HOST_PREFIXES,
	furtrack: ['furtrack.com/user/']
};

/** The bare (www-less) hosts a platform's profile URLs live on, read off its
 *  prefix list: 'bsky.app/profile/' → 'bsky.app'. */
export function platformDomains(platform: SocialPlatform): string[] {
	return (SOCIAL_HOST_PREFIXES[platform] ?? []).map((p) => p.replace(/\/.*$/, ''));
}

/**
 * The handle in `raw`, with the owner's casing kept, or '' when there is none.
 *
 * Accepts a profile URL, a scheme-less one, or a bare handle: strip the scheme
 * and www., consume the platform's profile prefix (listed longest-first, so
 * patreon.com/c/ wins over patreon.com/), then take everything up to the next
 * delimiter. That first-segment-after-the-prefix rule is what makes
 * furaffinity.net/user/taro/gallery read as `taro` rather than `gallery`.
 */
export function extractHandle(platform: SocialPlatform, raw: string | null | undefined): string {
	if (!raw) return '';
	let s = raw.trim();
	s = s.replace(/^https?:\/\//i, '');
	s = s.replace(/^www\./i, '');
	const lower = s.toLowerCase();
	for (const prefix of SOCIAL_HOST_PREFIXES[platform] ?? []) {
		if (lower.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	s = s.replace(/^@+/, '');
	s = s.replace(/[/?#].*$/, '');
	return s;
}
