import { fetchTwitterAvatar } from './twitter-avatar';

/**
 * Try to resolve an artist's avatar from their social media profiles.
 * Priority: Bluesky > Twitter > FurAffinity > Patreon
 */
export async function resolveAvatarUrl(socials: {
	blueskyUrl?: string | null;
	twitterUrl?: string | null;
	furAffinityUrl?: string | null;
	patreonUrl?: string | null;
}): Promise<string | null> {
	// Try Bluesky first — public API, no auth needed
	if (socials.blueskyUrl) {
		const avatar = await fetchBlueskyAvatar(socials.blueskyUrl);
		if (avatar) return avatar;
	}

	// Twitter next — the guest-token flow (see twitter-avatar.ts). Fail-soft:
	// a null here just means the artist saves without an avatar.
	if (socials.twitterUrl) {
		const avatar = await fetchTwitterAvatar(socials.twitterUrl);
		if (avatar) return avatar;
	}

	// Other platforms would need scraping or auth — skip for now
	// TODO: FurAffinity, Patreon avatar fetching

	return null;
}

/**
 * Resolve a character's icon. Prefer the favicon of their profile URL
 * (e.g. toyhouse, sheezy, personal site) since that's what a visitor
 * would recognize. Fall back to the Bluesky avatar like we do for
 * artists if no profile URL is set.
 */
export async function resolveCharacterIcon(socials: {
	url?: string | null;
	blueskyUrl?: string | null;
}): Promise<string | null> {
	if (socials.url) {
		try {
			const host = new URL(socials.url).hostname;
			if (host) return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
		} catch {
			// invalid URL — fall through to Bluesky
		}
	}

	if (socials.blueskyUrl) {
		const avatar = await fetchBlueskyAvatar(socials.blueskyUrl);
		if (avatar) return avatar;
	}

	return null;
}

async function fetchBlueskyAvatar(blueskyUrl: string): Promise<string | null> {
	try {
		// Extract handle from various formats:
		// "bsky.app/profile/handle.bsky.social"
		// "handle.bsky.social"
		// "@handle.bsky.social"
		let handle = blueskyUrl
			.replace(/^https?:\/\//, '')
			.replace(/^bsky\.app\/profile\//, '')
			.replace(/^@/, '')
			.replace(/\/$/, '')
			.trim();

		if (!handle) return null;

		// Bound the request: a non-existent/odd handle (or a slow Bluesky API) must not
		// hang the whole save until the Worker hits its request limit and 5XXes. On
		// timeout the fetch throws AbortError → caught below → save proceeds with no avatar.
		const res = await fetch(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
			{ signal: AbortSignal.timeout(5000) }
		);

		if (!res.ok) return null;

		const profile = await res.json() as { avatar?: string };
		return profile.avatar || null;
	} catch {
		return null;
	}
}
