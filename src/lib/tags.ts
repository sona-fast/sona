// Tag and source-post helpers that both the server and the browser need.
//
// `sanitizeTag` decides what a tag name is allowed to look like, and the tag
// suggestion UI compares its chips against the Tags input with the same rule —
// so a tag the operator already typed is never offered again. `classifySourceUrl`
// decides whether a source post can be looked up at all, and the "Suggest tags"
// pill is enabled by the same answer the endpoint would give.
//
// Both live here rather than in $lib/server because $lib/server is unreachable
// from client code, and a second copy of either rule would drift from the one
// the server enforces. The server modules re-export these names, so existing
// imports of `$lib/server/validate` and `$lib/server/entail` keep working.

/** The most characters a stored tag name keeps. The suggestion chips cap their
 * labels at the same length, so a chip never shows more than would be saved. */
export const TAG_MAX_LENGTH = 50;

/**
 * Sanitize a tag name — lowercase, alphanumeric + hyphens only.
 */
export function sanitizeTag(tag: string): string {
	return tag
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.slice(0, TAG_MAX_LENGTH);
}

/** The X hosts a post URL may arrive on. Named rather than inlined because the
 * backfill list narrows its scan to these hosts in SQL, and a host this
 * function accepts that the query does not know about is an image the page
 * would never offer. */
const X_HOSTS = ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'];

/** Every host `classifySourceUrl` can recognise a post on, `www.` stripped and
 * lowercased as it compares them. The backfill list builds its SQL filter from
 * this, and `classifySourceUrl` stays the final word on any row that survives
 * it: the filter is a net, not a second copy of the rule. */
export const SOURCE_POST_HOSTS = ['bsky.app', ...X_HOSTS];

/** The `x` kind carries the status id so the tweet lookup never re-parses
 * the URL. */
export type SourceKind = { kind: 'bluesky'; url: string } | { kind: 'x'; url: string; id: string };

// Checked after percent-decoding, so a `%` that survives (a double-encoded
// actor) is rejected rather than decoded again downstream.
const BLUESKY_ACTOR = /^[A-Za-z0-9._:-]{1,256}$/;
// The actor pattern admits an actor made only of dots, which names no handle
// or DID. The URL parser collapses "." and ".." before they get here; "..." and
// longer survive it.
const ONLY_DOTS = /^\.+$/;
const BLUESKY_RKEY = /^[A-Za-z0-9._~-]{1,64}$/;
const X_USER = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_ID = /^\d{1,20}$/;

/**
 * Recognise a post URL we know how to get suggestions for, and return it in
 * canonical form (no query string, no trailing slash, no `/photo/1` or
 * `/video/1` suffix).
 * Anything else — including a bare media URL — returns null. Pure.
 */
export function classifySourceUrl(url: string): SourceKind | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	const parts = parsed.pathname.split('/').filter(Boolean);

	if (host === 'bsky.app') {
		// /profile/<handle-or-did>/post/<rkey>
		if (parts.length !== 4 || parts[0] !== 'profile' || parts[2] !== 'post') return null;
		// Decode first, then validate the decoded actor: a malformed percent
		// sequence throws, and an encoded slash would otherwise pass the regex
		// and decode into a path separator in the canonical URL.
		let actor: string;
		try {
			actor = decodeURIComponent(parts[1]);
		} catch {
			return null;
		}
		const rkey = parts[3];
		if (!BLUESKY_ACTOR.test(actor) || ONLY_DOTS.test(actor) || !BLUESKY_RKEY.test(rkey)) return null;
		return { kind: 'bluesky', url: `https://bsky.app/profile/${actor}/post/${rkey}` };
	}

	if (X_HOSTS.includes(host)) {
		// /<user>/status/<id>, /i/status/<id>, /i/web/status/<id>, any with a
		// trailing /photo/N or /video/N. The `/i/web/` permalink is the form X's own share
		// sheet hands out, so it canonicalises to /i/status/<id> like the rest.
		if (parts[0] === 'i' && parts[1] === 'web') parts.splice(1, 1);
		if (parts.length < 3) return null;
		const [user, keyword, id, ...rest] = parts;
		if (keyword !== 'status' && keyword !== 'statuses') return null;
		if (!STATUS_ID.test(id)) return null;
		// Only a media permalink may follow the id — /photo/<n> for stills and
		// /video/<n> for video and GIF posts, both naming the same status.
		// Anything else is a page the contract says nothing about, and reading it
		// as the post would hand the lookup a URL the operator never pointed at.
		if (
			rest.length > 0 &&
			!(
				rest.length === 2 &&
				(rest[0] === 'photo' || rest[0] === 'video') &&
				STATUS_ID.test(rest[1])
			)
		)
			return null;
		// `i` (the /i/status form) is a valid user segment by this pattern too.
		if (!X_USER.test(user)) return null;
		return { kind: 'x', url: `https://x.com/${user}/status/${id}`, id };
	}

	return null;
}
