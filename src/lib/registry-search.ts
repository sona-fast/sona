// Pure helpers for the registry-search combobox in NewArtistDialog. Kept out of
// the component so the query gating and result → form mapping are unit-testable
// (the combobox interaction itself is browser-land / E2E).

/** A shared-registry search hit, as shaped by /api/registry/search. */
export type RegResult = {
	globalId: string;
	name: string;
	avatarUrl: string | null;
	version: number;
	socials: Record<string, string>;
};

/** The registry endpoint ignores queries shorter than this, so the client gates
 *  identically to avoid a pointless round-trip and an empty flash of results. */
export const MIN_QUERY_LENGTH = 2;

/** Whether a typed name is long enough to search the registry for. */
export function shouldSearch(query: string): boolean {
	return query.trim().length >= MIN_QUERY_LENGTH;
}

/** Form prefill derived from a picked registry result: the social fields to fill
 *  and the `pulled` link record the create call sends back to link the artist. */
export function resultToPrefill(r: RegResult): {
	name: string;
	twitter: string;
	bluesky: string;
	telegram: string;
	furaffinity: string;
	deviantart: string;
	patreon: string;
	instagram: string;
	pulled: { globalId: string; version: number; avatarUrl: string | null };
} {
	const s = r.socials ?? {};
	return {
		name: r.name,
		twitter: s.twitterUrl ?? '',
		bluesky: s.blueskyUrl ?? '',
		telegram: s.telegramUrl ?? '',
		furaffinity: s.furAffinityUrl ?? '',
		deviantart: s.deviantArtUrl ?? '',
		patreon: s.patreonUrl ?? '',
		instagram: s.instagramUrl ?? '',
		pulled: { globalId: r.globalId, version: r.version, avatarUrl: r.avatarUrl }
	};
}
