/**
 * One entity-tag, weak or strong. `etagc` is %x21 / %x23-7E / obs-text (RFC 9110
 * §8.8.3) — an etag is NOT a quoted-string with escapes, so a backslash is an
 * ordinary character and there is no quoted-pair alternative to allow. Spelling
 * the class out is what keeps CR, LF and NUL from reaching a response header or
 * an outbound request.
 */
const SINGLE_ETAG = /^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/;

/** Longest entity-tag worth forwarding. Real ones are a hash or a size+mtime
 * pair; a multi-kilobyte tag is a client probing how much it can reflect. */
const MAX_ETAG_LENGTH = 256;

/**
 * The client's If-None-Match when it names exactly one entity, else null —
 * which sends the request down the ordinary unconditional path.
 *
 * A comma-list or `*` is refused rather than parsed. Storage may answer 304 to
 * either without saying which entity it matched, and a 304 must carry the ETag
 * its 200 would have (RFC 9110 §15.4.5); naming the wrong one would let a
 * shared cache extend the life of bytes storage never confirmed. Nor can the
 * members be recovered by splitting on commas — an etag may legally contain
 * one. Browsers and the Cloudflare edge send a single tag, so refusing the
 * other forms costs no real traffic.
 *
 * Forwarding exactly one tag is also what lets a 304 name it without reading
 * the one storage sends back: a 304 confirms the entity we asked about, and
 * adopting a different tag storage named would file the client's existing bytes
 * under a validator describing bytes it does not have — every later
 * revalidation would then succeed while the file changed underneath it.
 */
export function singleValidator(ifNoneMatch: string | null): string | null {
	const value = ifNoneMatch?.trim();
	if (!value || value.length > MAX_ETAG_LENGTH || !SINGLE_ETAG.test(value)) return null;
	return value;
}

/**
 * A validated tag as R2's `etagDoesNotMatch` wants it: the bare opaque value,
 * unquoted. Returns null for anything R2 would refuse or compare wrongly.
 *
 * Two constraints, both from workerd rather than the RFC: it rejects a quoted
 * tag outright ("Conditional ETag should not be wrapped in quotes"), and it
 * compares strongly, so a weak tag would silently never match. Handing back
 * null for the weak form makes that an ordinary unconditional 200 instead of a
 * conditional request that can only ever fail.
 *
 * `"*"` has to go too, and it is the one case where unquoting changes meaning
 * rather than form. RFC 9110 §13.1.2 makes the wildcard the UNQUOTED
 * production, so `"*"` names an entity whose opaque value is literally `*` and
 * singleValidator rightly accepts it — but strip the quotes and R2 reads the
 * wildcard, matching any object at all. A client sending it would be told 304
 * for bytes it has never seen.
 */
export function r2ConditionalTag(ifNoneMatch: string | null): string | null {
	const value = singleValidator(ifNoneMatch);
	if (!value || value.startsWith('W/') || value === '"*"') return null;
	return value.slice(1, -1);
}
