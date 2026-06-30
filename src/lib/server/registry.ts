// Client for the shared artist registry (sona-registry). The registry is a
// sync/enrichment source, NEVER a render-time dependency: only admin actions and
// the background sync cron call it, and every call degrades gracefully (returns
// empty/null) when the registry is disabled, slow, or unreachable.

import { REGISTRY_DEFAULT_URL } from '$lib/config';
import { withTimeout } from './timeout';

type Env = App.Platform['env'];

export interface RegistryArtist {
	globalId: string;
	displayName: string;
	avatarUrl: string | null;
	bio: string | null;
	socials: Record<string, string>;
	status: 'active' | 'merged' | 'tombstoned';
	mergedInto: string | null;
	version: number;
	updatedAt: string;
}

const TIMEOUT_MS = 5000;

/** Registry features are opt-in: enabled only when a fork API key is configured. */
export function isRegistryEnabled(env: Env | undefined): boolean {
	return !!env?.REGISTRY_API_KEY;
}

function baseUrl(env: Env): string {
	return (env.REGISTRY_URL || REGISTRY_DEFAULT_URL).replace(/\/+$/, '');
}

async function call<T>(
	env: Env | undefined,
	path: string,
	init: RequestInit & { auth?: boolean },
	fallback: T
): Promise<T> {
	if (!env || !isRegistryEnabled(env)) return fallback;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (init.auth) headers['authorization'] = `Bearer ${env.REGISTRY_API_KEY}`;
	try {
		const res = await withTimeout(
			fetch(`${baseUrl(env)}${path}`, { ...init, headers: { ...headers, ...init.headers } }),
			TIMEOUT_MS,
			null
		);
		if (!res || !res.ok) return fallback;
		return (await res.json()) as T;
	} catch {
		return fallback;
	}
}

export async function registrySearch(
	env: Env | undefined,
	params: { q?: string; handle?: string }
): Promise<RegistryArtist[]> {
	const qs = new URLSearchParams();
	if (params.q) qs.set('q', params.q);
	if (params.handle) qs.set('handle', params.handle);
	const out = await call<{ artists: RegistryArtist[] }>(
		env,
		`/v1/artists/search?${qs.toString()}`,
		{ method: 'GET' },
		{ artists: [] }
	);
	return out.artists ?? [];
}

export async function registryGetArtist(
	env: Env | undefined,
	globalId: string
): Promise<RegistryArtist | null> {
	return call<RegistryArtist | null>(
		env,
		`/v1/artists/${encodeURIComponent(globalId)}`,
		{ method: 'GET' },
		null
	);
}

export async function registryDelta(
	env: Env | undefined,
	params: { updatedSince?: string; cursor?: string; limit?: number }
): Promise<{ artists: RegistryArtist[]; nextCursor: string | null }> {
	const qs = new URLSearchParams();
	if (params.cursor) qs.set('cursor', params.cursor);
	else if (params.updatedSince) qs.set('updated_since', params.updatedSince);
	if (params.limit) qs.set('limit', String(params.limit));
	return call(env, `/v1/artists?${qs.toString()}`, { method: 'GET' }, {
		artists: [],
		nextCursor: null
	});
}

export interface RegistrySubmitResult {
	id: number;
	status: string;
	matchedGlobalId: string | null;
	multipleMatches?: boolean;
}

export async function registrySubmit(
	env: Env | undefined,
	body: {
		kind: 'create' | 'update';
		targetGlobalId?: string;
		baseVersion?: number;
		payload: {
			displayName: string;
			avatarUrl?: string | null;
			bio?: string | null;
			socials: Record<string, string>;
		};
	}
): Promise<RegistrySubmitResult | null> {
	return call<RegistrySubmitResult | null>(
		env,
		`/v1/submissions`,
		{ method: 'POST', auth: true, body: JSON.stringify(body) },
		null
	);
}

/** Build the registry `socials` payload from an artist's *Url fields. */
export function artistSocials(a: {
	twitterUrl?: string | null;
	blueskyUrl?: string | null;
	telegramUrl?: string | null;
	furAffinityUrl?: string | null;
	deviantArtUrl?: string | null;
	patreonUrl?: string | null;
	instagramUrl?: string | null;
}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of [
		'twitterUrl',
		'blueskyUrl',
		'telegramUrl',
		'furAffinityUrl',
		'deviantArtUrl',
		'patreonUrl',
		'instagramUrl'
	] as const) {
		const v = a[k];
		if (typeof v === 'string' && v) out[k] = v;
	}
	return out;
}

/** First non-empty social URL — used to handle-match an artist in the registry. */
export function firstHandle(a: Parameters<typeof artistSocials>[0]): string | null {
	const socials = artistSocials(a);
	for (const v of Object.values(socials)) return v;
	return null;
}
