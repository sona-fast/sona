// Social-link label helpers for the /about page chips.
//
// A profile URL's last path segment is the account handle for every platform we
// render (twitter.com/<handle>, instagram.com/<handle>, furaffinity.net/user/
// <handle>, …), so /about shows that segment rather than the platform name.
// When no handle can be derived (pathless URL, unparseable string, unset
// setting) the chip falls back to the platform name — bare, never "@Twitter".
//
// NOTE: /connect's local handle() deliberately behaves differently (it falls
// back to the URL's hostname, not a platform name) and is not merged into this
// module — do not "unify" them.

/**
 * The last non-empty path segment of `url`, or null when none can be derived
 * (undefined/unparseable URL, or a pathless URL like https://twitter.com/).
 *
 * Returning a null sentinel — rather than the fallback string — lets callers
 * distinguish "no handle" from a real handle that happens to equal the
 * platform name (e.g. instagram.com/Instagram).
 */
export function handleSegment(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).pathname.split('/').filter(Boolean).pop() ?? null;
	} catch {
		return null;
	}
}

/** The derived handle, or `fallback` (the platform name) when none exists. */
export function handleFromUrl(url: string | undefined, fallback: string): string {
	return handleSegment(url) ?? fallback;
}

/**
 * The derived handle prefixed with @, or the bare `fallback` when none exists.
 * A real handle always gets the @ — even one equal to the platform name.
 */
export function atHandleFromUrl(url: string | undefined, fallback: string): string {
	const handle = handleSegment(url);
	return handle ? `@${handle}` : fallback;
}
