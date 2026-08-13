// Pure, dependency-free handle classification/normalization shared by the client
// (the New Artist combobox, to decide name-search vs handle-search and to gate
// create) and the server (handle-normalize.ts re-exports these). No $lib/server
// imports so it is safe to bundle into a Svelte component. Mirrors the registry's
// normalize rules so the two agree on what counts as "the same handle".

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
	telegram: ['t.me/', 'telegram.me/'],
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

/** Maps the artist *Url column / payload keys to platforms. */
export const SOCIAL_KEY_TO_PLATFORM: Record<string, Platform> = {
	twitterUrl: 'twitter',
	blueskyUrl: 'bluesky',
	telegramUrl: 'telegram',
	furAffinityUrl: 'furaffinity',
	deviantArtUrl: 'deviantart',
	patreonUrl: 'patreon',
	instagramUrl: 'instagram'
};

export function normalizeHandle(platform: Platform, raw: string | null | undefined): string {
	if (!raw) return '';
	let s = raw.trim().toLowerCase();
	s = s.replace(/^https?:\/\//, '');
	s = s.replace(/^www\./, '');
	for (const prefix of HOST_PREFIXES[platform] ?? []) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	s = s.replace(/^@+/, '');
	s = s.replace(/[/?#].*$/, '');
	s = s.replace(/\/+$/, '');
	return s;
}

export type QueryKind = 'name' | 'handle';

export interface QueryClassification {
	/** 'handle' when the typed text is a social URL or @handle; else 'name'. */
	kind: QueryKind;
	/** Value to send as the registry `handle=` param (handle kind only; '' for name). */
	handleParam: string;
	/** Detected platform when the input carried a recognizable social domain.
	 *  Undefined for a bare "@handle" or a generic non-social URL. */
	platform?: Platform;
	/** Normalized bare handle, for display (handle kind only; '' for name). */
	handle: string;
}

const NAME: QueryClassification = { kind: 'name', handleParam: '', handle: '' };

/**
 * Classify what the user typed into the merged name/search field:
 *   - "@kuttoya"                        → handle (platform unknown, match by bare handle)
 *   - "twitter.com/kuttoya", full URLs  → handle (platform detected from the domain)
 *   - any other "http(s)://…" URL       → handle (platform unknown; a pasted link must
 *                                          not silently become the artist's name)
 *   - plain text                        → name
 */
export function classifyQuery(input: string): QueryClassification {
	const t = (input ?? '').trim();
	if (!t) return NAME;

	if (t.startsWith('@')) {
		const bare = t.replace(/^@+/, '').replace(/[/?#].*$/, '').replace(/\/+$/, '');
		return bare ? { kind: 'handle', handleParam: bare, handle: bare } : NAME;
	}

	// Strip the scheme / protocol-relative slashes / www., then require an EXACT
	// prefix match (mirroring normalizeHandle) and take the platform from the
	// matching prefix. Substring matching would misread ordinary names that merely
	// contain a domain fragment — "cat.meow" (t.me), "wolfx.community" (x.com),
	// "Sweet.Melody" (t.me) — as handles, and the create-block would make those
	// names impossible to enter.
	const lower = t.toLowerCase();
	const s = lower.replace(/^https?:\/\//, '').replace(/^\/\//, '').replace(/^www\./, '');
	for (const platform of Object.keys(HOST_PREFIXES) as Platform[]) {
		for (const prefix of HOST_PREFIXES[platform]) {
			if (s.startsWith(prefix)) {
				return { kind: 'handle', handleParam: t, platform, handle: normalizeHandle(platform, t) };
			}
		}
	}

	if (/^(https?:\/\/|\/\/)/.test(lower)) {
		// A pasted link with no recognized social domain — still must not silently
		// become the artist's name.
		return { kind: 'handle', handleParam: t, handle: t };
	}

	return NAME;
}
