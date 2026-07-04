// Twitter/X avatar resolution — the guest-token flow the X web client itself
// performs (as documented by FxEmbed): activate a guest token against the
// public web bearer, then call the UserByScreenName GraphQL endpoint. Both
// constants are UNDOCUMENTED and can rotate — if resolution goes uniformly
// null, refresh them from FxEmbed's source
// (packages/atmosphere/src/providers/twitter/{constants,graphql/queries}.ts).
//
// Same helper as the registry's src/lib/twitter-avatar.ts core. Used only at
// artist-save time (New Artist dialog / upload flow) — never on page load —
// and fail-soft: any error resolves to null and the save proceeds without an
// avatar. Registry-linked artists get theirs through the registry instead.

// X web client's public bearer (shipped to every browser) — not a secret.
const X_BEARER =
	'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_ACTIVATE = 'https://api.x.com/1.1/guest/activate.json';
const X_USER_BY_SCREEN_NAME = 'https://api.x.com/graphql/IGgvgiOx4QZndDHuD3x9TQ/UserByScreenName';
const FETCH_TIMEOUT_MS = 5000;

/** Extract a bare handle from the stored twitter URL formats
 * ("https://x.com/@SparkyFen/", "twitter.com/sparkyfen", "@sparkyfen"). */
export function twitterHandleFromUrl(twitterUrl: string): string {
	return twitterUrl
		.replace(/^https?:\/\//, '')
		.replace(/^(www\.|mobile\.)?(twitter|x)\.com\//, '')
		.replace(/^@/, '')
		.replace(/[/?].*$/, '')
		.trim()
		.toLowerCase();
}

/** Extract the avatar URL from a UserByScreenName response; prefers the newer
 * avatar shape, falls back to legacy. Pure, so it's testable. */
export function parseUserAvatar(body: unknown): string | null {
	const user = (body as { data?: { user?: { result?: Record<string, unknown> } } })?.data?.user
		?.result;
	if (!user) return null;
	const modern = (user.avatar as { image_url?: unknown } | undefined)?.image_url;
	const legacy = (user.legacy as { profile_image_url_https?: unknown } | undefined)
		?.profile_image_url_https;
	const url = typeof modern === 'string' && modern ? modern : legacy;
	return typeof url === 'string' && url ? url : null;
}

/** pbs.twimg.com serves sized variants; store a decent one instead of _normal (48px). */
export function to400x400(url: string): string {
	return url.replace(/_normal(\.[a-z]+)$/i, '_400x400$1');
}

async function activateGuestToken(): Promise<string | null> {
	try {
		const res = await fetch(X_ACTIVATE, {
			method: 'POST',
			headers: { Authorization: X_BEARER },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { guest_token?: unknown };
		return typeof body.guest_token === 'string' ? body.guest_token : null;
	} catch {
		return null;
	}
}

async function userLookup(handle: string, guestToken: string): Promise<Response> {
	const csrf = [...crypto.getRandomValues(new Uint8Array(16))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const variables = encodeURIComponent(JSON.stringify({ screen_name: handle }));
	return fetch(`${X_USER_BY_SCREEN_NAME}?variables=${variables}`, {
		headers: {
			Authorization: X_BEARER,
			'x-guest-token': guestToken,
			'x-csrf-token': csrf,
			'x-twitter-active-user': 'yes',
			Cookie: `guest_id=v1%3A${guestToken}; ct0=${csrf};`
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}

/** Resolve the current avatar for a stored twitter URL. One guest token, one
 * fresh-token retry if X refuses it (401/429), then null. Never throws. */
export async function fetchTwitterAvatar(twitterUrl: string): Promise<string | null> {
	const handle = twitterHandleFromUrl(twitterUrl);
	if (!handle) return null;
	try {
		let token = await activateGuestToken();
		if (!token) return null;
		let res = await userLookup(handle, token);
		if (res.status === 401 || res.status === 429) {
			token = await activateGuestToken();
			if (!token) return null;
			res = await userLookup(handle, token);
		}
		if (!res.ok) return null;
		const avatar = parseUserAvatar(await res.json());
		return avatar ? to400x400(avatar) : null;
	} catch {
		return null;
	}
}
