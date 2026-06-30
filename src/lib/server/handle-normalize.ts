// Handle normalization for matching a registry artist against LOCAL artists when
// pulling. Mirrors the registry's src/lib/normalize.ts so the two agree on what
// counts as "the same handle". Pure — no DB.

export type Platform =
	| 'twitter'
	| 'bluesky'
	| 'telegram'
	| 'furaffinity'
	| 'deviantart'
	| 'patreon'
	| 'instagram';

const HOST_PREFIXES: Record<Platform, string[]> = {
	twitter: ['twitter.com/', 'x.com/', 'mobile.twitter.com/'],
	bluesky: ['bsky.app/profile/', 'staging.bsky.app/profile/'],
	telegram: ['t.me/', 'telegram.me/'],
	furaffinity: ['furaffinity.net/user/'],
	deviantart: ['deviantart.com/'],
	patreon: ['patreon.com/'],
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
