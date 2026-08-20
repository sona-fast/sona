// The bearer token that unlocks the adult variant of /feed.xml (SONA-172).
//
// Separate from the serializer because it is a credential, not a formatting
// concern: minting and comparing it are the two operations that decide whether
// an anonymous request sees NSFW work, and both belong somewhere a reviewer can
// read in one screen.

/** Bytes of entropy in a feed key. 16 = 128 bits, the floor for a token that is
 * only ever guessed at, never rate-limited per-account (there is no account). */
const KEY_BYTES = 16;

/**
 * A fresh key: 32 lowercase hex characters from the platform CSPRNG.
 *
 * `crypto.getRandomValues` rather than `randomUUID` — a UUIDv4 spends 6 of its
 * 128 bits on the version and variant markers, so it carries 122 bits of
 * entropy and a dash layout no one needs in a query string. This is the same
 * number of characters with all 128 bits live.
 *
 * Hex, not base64url: the key is pasted into a URL by hand from the admin page,
 * and a case-insensitive alphabet is one fewer way to mistype it.
 */
export function mintFeedKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `presented` is the stored `expected` key.
 *
 * Compares in time independent of WHERE the two differ, so the response latency
 * cannot be walked character by character to recover the key. The LENGTH still
 * leaks, which is fine: every key this code mints is the same length, so length
 * carries no information about a particular key's contents.
 *
 * An empty `expected` — no key minted yet — never matches, including against an
 * empty `presented`. That is what stops `?key=` (or a bare `/feed.xml?key`) from
 * unlocking the adult feed on a fork that has not opted in.
 *
 * Case-insensitive, which is the point of choosing hex above: an owner who
 * retypes the key from a screenshot in capitals would otherwise get the plain
 * SFW document, indistinguishable from a key that had been revoked. Folding
 * case widens nothing — the same 128 bits are still required — and happens
 * after the length check, so the timing property is unchanged.
 */
export function feedKeyMatches(presented: string | null, expected: string): boolean {
	if (!expected || !presented || presented.length !== expected.length) return false;
	const lowered = presented.toLowerCase();
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= lowered.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return diff === 0;
}
