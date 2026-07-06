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

	const lower = t.toLowerCase();
	for (const platform of Object.keys(HOST_PREFIXES) as Platform[]) {
		for (const prefix of HOST_PREFIXES[platform]) {
			const domain = prefix.split('/')[0];
			if (lower.includes(domain)) {
				return { kind: 'handle', handleParam: t, platform, handle: normalizeHandle(platform, t) };
			}
		}
	}

	if (lower.startsWith('http://') || lower.startsWith('https://')) {
		return { kind: 'handle', handleParam: t, handle: t };
	}

	return NAME;
}
