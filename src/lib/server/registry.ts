// Client for the shared artist registry (sona-registry). The registry is a
// sync/enrichment source, NEVER a render-time dependency: only admin actions and
// the background sync cron call it, and every call degrades gracefully (returns
// empty/null) when the registry is disabled, slow, or unreachable.

import { REGISTRY_DEFAULT_URL } from '$lib/config';
import { withTimeout } from './timeout';
import { getRawSetting } from './settings';
import type { Database } from './db';

type Env = App.Platform['env'];

/** site_settings keys for an in-app (D1-stored) registry connection. Kept out of
 * the SiteSettings interface so the fork key never serializes to the browser. */
export const REGISTRY_API_KEY_SETTING = 'registryApiKey';
export const REGISTRY_URL_SETTING = 'registryUrl';

/** A former identity of an artist — an old display name plus its social links. */
export interface ArtistAlias {
	displayName: string;
	socials: Record<string, string>;
}

export interface RegistryArtist {
	globalId: string;
	displayName: string;
	avatarUrl: string | null;
	bio: string | null;
	socials: Record<string, string>;
	aliases?: ArtistAlias[];
	status: 'active' | 'merged' | 'tombstoned';
	mergedInto: string | null;
	version: number;
	updatedAt: string;
}

/** Parse the local `artists.aliases` JSON column; tolerates NULL/malformed data. */
export function parseAliases(json: string | null | undefined): ArtistAlias[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(a): a is ArtistAlias => !!a && typeof a.displayName === 'string' && a.displayName !== ''
		);
	} catch {
		return [];
	}
}

/**
 * True when a local row's name matches one of its linked registry artist's
 * ALIASES (not its display name) — i.e. the row is an AKA link (#71). Sharing
 * such a row as an update would propose renaming the registry artist back to
 * the alias, so callers disable/refuse the share. Deliberately NOT "local name
 * != registry displayName": a direct-linked artist renamed locally is a
 * legitimate rename proposal and must stay shareable.
 */
export function isLocalNameAliasOf(
	localName: string,
	reg: Pick<RegistryArtist, 'displayName' | 'aliases'>
): boolean {
	// Registry data is untrusted: fail open on a malformed/drifted entry.
	if (typeof reg?.displayName !== 'string') return false;
	const fold = (s: string) => s.normalize('NFC').toLowerCase();
	const n = fold(localName);
	if (fold(reg.displayName) === n) return false;
	// Registry data is untrusted: tolerate malformed alias entries.
	return (reg.aliases ?? []).some(
		(al) => typeof al?.displayName === 'string' && fold(al.displayName) === n
	);
}

const TIMEOUT_MS = 5000;

/** Registry features are opt-in: enabled only when a fork API key is configured. */
export function isRegistryEnabled(env: Env | undefined): boolean {
	return !!env?.REGISTRY_API_KEY;
}

/**
 * Overlay a D1-stored fork key / registry URL onto the platform env, so a fork
 * can be connected from the admin UI (key in site_settings) without a deploy-time
 * secret. A `REGISTRY_API_KEY` env secret always wins and short-circuits the DB
 * read. Callers pass the result to the registry functions / isRegistryEnabled.
 */
export async function resolveRegistryEnv(
	db: Database,
	env: Env | undefined
): Promise<Env | undefined> {
	if (!env || env.REGISTRY_API_KEY) return env; // secret wins; no DB read needed
	const apiKey = (await getRawSetting(db, REGISTRY_API_KEY_SETTING)) || undefined;
	if (!apiKey) return env;
	const url = (await getRawSetting(db, REGISTRY_URL_SETTING)) || undefined;
	return { ...env, REGISTRY_API_KEY: apiKey, REGISTRY_URL: url || env.REGISTRY_URL };
}

/**
 * Register this fork with the registry (`POST /v1/forks`) using a maintainer
 * invite token, returning the one-time fork key to store. Used by the in-app
 * "Connect to registry" flow. No existing key needed (this is how you get one).
 */
export async function registryRegisterFork(opts: {
	url?: string;
	signupToken?: string;
	label?: string;
}): Promise<{ forkId: string; key: string } | { error: string }> {
	const base = (opts.url || REGISTRY_DEFAULT_URL).replace(/\/+$/, '');
	try {
		const res = await withTimeout(
			fetch(`${base}/v1/forks`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ signupToken: opts.signupToken, label: opts.label })
			}),
			TIMEOUT_MS,
			null
		);
		if (!res) return { error: 'the registry did not respond — check the URL and try again' };
		const data = (await res.json().catch(() => null)) as
			| { forkId?: string; key?: string; error?: string }
			| null;
		if (!res.ok || !data?.key || !data?.forkId) {
			return { error: data?.error || `registry returned HTTP ${res.status}` };
		}
		return { forkId: data.forkId, key: data.key };
	} catch {
		return { error: 'could not reach the registry' };
	}
}

function baseUrl(env: Env): string {
	return (env.REGISTRY_URL || REGISTRY_DEFAULT_URL).replace(/\/+$/, '');
}

/** A registry refusal: a 4xx whose body carries the registry's own reason. Distinct
 *  from a fail-soft fallback (5xx/network) so callers can surface the message and map
 *  the status (409 conflict, 429 rate-limit, 400 validation) rather than a generic
 *  code. Only the `errorBody` call path can produce one (R defaults to `never`). */
export interface RegistryRefusal {
	error: string;
	httpStatus: number;
}

/** Narrow a registry result to a refusal. The body is untrusted wire data, so this
 *  checks the field TYPES (not just their presence) and rejects anything carrying a
 *  success payload — a 200 body that happens to include `error`/`httpStatus` must not
 *  make every caller treat a real catalogue page as a refusal. */
export function isRegistryRefusal(value: unknown): value is RegistryRefusal {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.error === 'string' && typeof v.httpStatus === 'number' && !('artists' in v);
}

/**
 * Which refusal statuses are fatal — i.e. worth failing a whole sync/import run for.
 * Only 401/403: the fork key is wrong, missing, or revoked, so every later call in the
 * run fails the same way and no amount of retrying helps; that must be surfaced.
 * Every other 4xx (429 rate-limited, 408 timeout, 400) is transient or narrow and
 * self-corrects, so it degrades to a no-op exactly like a 5xx/outage always has.
 * Shared by artist-sync and registry-import so sync and import agree.
 */
export function isFatalRefusal(status: number): boolean {
	return status === 401 || status === 403;
}

/** Base for the errors syncArtists throws on purpose. Callers (the cron endpoint,
 *  the admin "Sync now" action) catch THIS type to hand the reason back as data and
 *  let any other exception (a D1 error, say) keep propagating as a real 500. */
export class RegistrySyncError extends Error {
	readonly reason: string;
	constructor(message: string, reason: string) {
		super(message);
		this.name = 'RegistrySyncError';
		this.reason = reason;
	}
}

/** A fatal registry refusal, thrown by syncArtists so callers can tell it apart from
 *  an unrelated exception (e.g. a D1 error) and show the registry's own reason. */
export class RegistryRefusalError extends RegistrySyncError {
	readonly httpStatus: number;
	constructor(httpStatus: number, reason: string) {
		super(`registry delta refused: HTTP ${httpStatus} — ${reason}`, reason);
		this.name = 'RegistryRefusalError';
		this.httpStatus = httpStatus;
	}
}

/** Every backfill search in a run failed. Each search fails soft on its own (an
 *  outage must not abort a run that was doing useful work), but a run in which NONE
 *  of them got through did no backfill at all, and reporting that as "ok, linked 0"
 *  is the silent empty result this whole family of checks exists to prevent. */
export class RegistrySearchError extends RegistrySyncError {
	constructor(failed: number, lastReason: string) {
		super(`all ${failed} backfill searches failed: ${lastReason}`, lastReason);
		this.name = 'RegistrySearchError';
	}
}

/** Optional hook for the fail-soft paths in `call`: invoked with a one-line reason
 *  whenever a request produced NO usable result (timeout, network error, 5xx, or a
 *  4xx the caller didn't opt to receive as a refusal). Lets a caller count how much
 *  of a run silently degraded without changing the fallback contract.
 *
 *  `httpStatus` is the response's status when the failure came from a response, and
 *  undefined when nothing answered (timeout or network error) — a caller that treats
 *  a rate limit or a gateway timeout differently from a real outage needs to tell
 *  those apart. */
export interface CallOptions {
	onFail?: (reason: string, info: { httpStatus?: number }) => void;
}

/** Name what answered a 4xx that carried no registry error message. A challenge or
 *  block from the zone in front of the registry marks itself with `cf-mitigated`
 *  (its value is the mitigation kind, e.g. "challenge"), and every Cloudflare
 *  response carries a `cf-ray` id the security event log can be searched by. Naming
 *  those turns "HTTP 403" — which reads as a registry key problem — into "blocked by
 *  a Cloudflare challenge", which is a zone setting, and points at the log entry.
 *
 *  Both headers come from whatever answered, which on this path is by definition NOT
 *  the registry — so each is used only if it matches its documented shape, and an
 *  off-shape value is dropped rather than pasted into a job log and an operator toast.
 *  The ray is split into id and colo because job_run.detail redacts any 20-character
 *  token-like run, and the joined "<16 hex>-SEA" form is exactly 20. */
function describeOpaqueRefusal(res: Response): string {
	const mitigated = res.headers.get('cf-mitigated');
	const ray = res.headers.get('cf-ray');
	const kind = mitigated && /^[a-z_-]{1,32}$/.test(mitigated) ? mitigated : '';
	const rayMatch = ray?.match(/^([0-9a-f]{16})-([A-Z]{3})$/);
	const where = rayMatch ? ` (cf-ray ${rayMatch[1]} ${rayMatch[2]})` : '';
	if (kind)
		return `HTTP ${res.status}: blocked by a Cloudflare ${kind} in front of the registry${where}`;
	return `HTTP ${res.status}${where}`;
}

async function call<T, R = never>(
	env: Env | undefined,
	path: string,
	init: RequestInit & { auth?: boolean; errorBody?: boolean } & CallOptions,
	fallback: T
): Promise<T | R> {
	if (!env || !isRegistryEnabled(env)) return fallback;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (init.auth) headers['authorization'] = `Bearer ${env.REGISTRY_API_KEY}`;
	const { onFail, ...rest } = init;
	try {
		// withTimeout folds a rejection into the same null as a timeout; keep the
		// network error's own message so the two are told apart in the job log.
		let rejected: string | undefined;
		const res = await withTimeout(
			fetch(`${baseUrl(env)}${path}`, { ...rest, headers: { ...headers, ...rest.headers } }).catch(
				(e: unknown) => {
					rejected = e instanceof Error ? e.message : 'request failed';
					return null;
				}
			),
			TIMEOUT_MS,
			null
		);
		if (!res) {
			// Nothing answered, so there is no status to report.
			onFail?.(rejected ?? `timed out after ${TIMEOUT_MS}ms`, {});
			return fallback;
		}
		if (!res.ok) {
			// Opt-in: surface a 4xx refusal's body (it carries the registry's reason,
			// e.g. "artist was removed from the registry") as a typed RegistryRefusal
			// instead of collapsing it into the fail-soft fallback. The status rides
			// along so the caller can distinguish a conflict from a rate-limit/validation
			// error. 5xx/network errors still fail soft.
			if (init.errorBody && res.status >= 400 && res.status < 500) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				// An unparseable/message-less 4xx body (an HTML error page from a WAF in
				// front of the registry, say) is still a refusal — falling through to the
				// fallback here would restore the silent empty-catalogue this guards against.
				// Blank counts as absent: `{"error":""}` would otherwise reach the operator
				// as a refusal with nothing in it, which reads as a bug in our own UI.
				const reason = typeof body?.error === 'string' ? body.error.trim() : '';
				const error = reason || describeOpaqueRefusal(res);
				return { error, httpStatus: res.status } as R;
			}
			onFail?.(describeOpaqueRefusal(res), { httpStatus: res.status });
			return fallback;
		}
		return (await res.json()) as T;
	} catch (e) {
		onFail?.(e instanceof Error ? e.message : 'request failed', {});
		return fallback;
	}
}

export async function registrySearch(
	env: Env | undefined,
	params: { q?: string; handle?: string },
	opts: CallOptions = {}
): Promise<RegistryArtist[]> {
	const qs = new URLSearchParams();
	if (params.q) qs.set('q', params.q);
	if (params.handle) qs.set('handle', params.handle);
	const out = await call<{ artists: RegistryArtist[] }>(
		env,
		`/v1/artists/search?${qs.toString()}`,
		{ method: 'GET', ...opts },
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
	params: { updatedSince?: string; cursor?: string; limit?: number },
	opts: CallOptions = {}
): Promise<{ artists: RegistryArtist[]; nextCursor: string | null } | RegistryRefusal> {
	const qs = new URLSearchParams();
	if (params.cursor) qs.set('cursor', params.cursor);
	else if (params.updatedSince) qs.set('updated_since', params.updatedSince);
	if (params.limit) qs.set('limit', String(params.limit));
	return call<{ artists: RegistryArtist[]; nextCursor: string | null }, RegistryRefusal>(
		env,
		`/v1/artists?${qs.toString()}`,
		// auth: the delta feed is not public — paging it reveals the whole catalogue
		// (and what was removed, and when), so the registry requires a fork key.
		// errorBody: a 4xx here (e.g. 401 from a bad/missing key) must NOT collapse
		// into an empty page — that's indistinguishable from "no new artists" and
		// would silently stop imports forever. 5xx/network still fail soft.
		{ method: 'GET', auth: true, errorBody: true, ...opts },
		{ artists: [], nextCursor: null }
	);
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
		// This fork's own host (siteName setting || site hostname). The registry uses
		// it to self-heal a null fork-key label so submissions attribute back to the
		// fork; it's a display hint only — the forkId (from the key) is the auth anchor.
		siteLabel?: string;
		payload: {
			displayName: string;
			avatarUrl?: string | null;
			bio?: string | null;
			socials: Record<string, string>;
		};
	}
): Promise<RegistrySubmitResult | RegistryRefusal | null> {
	return call<RegistrySubmitResult | null, RegistryRefusal>(
		env,
		`/v1/submissions`,
		// errorBody: a 4xx here is a meaningful refusal (e.g. "artist was removed
		// from the registry") that the admin UI must show — not an outage.
		{ method: 'POST', auth: true, body: JSON.stringify(body), errorBody: true },
		null
	);
}

/** The artist social-link columns, shared by every place that maps socials. */
export const SOCIAL_URL_KEYS = [
	'twitterUrl',
	'blueskyUrl',
	'telegramUrl',
	'furAffinityUrl',
	'deviantArtUrl',
	'patreonUrl',
	'instagramUrl'
] as const;

export type SocialUrls = Partial<Record<(typeof SOCIAL_URL_KEYS)[number], string | null>>;

export interface RegistrySubmission {
	id: number;
	kind: 'create' | 'update';
	targetGlobalId: string | null;
	payload: string; // JSON string
	matchedGlobalId: string | null;
	status: 'pending' | 'approved' | 'rejected' | 'superseded';
	reviewerNote: string | null;
	createdAt: string;
	decidedAt: string | null;
}

/** This fork's submissions + their fate (for showing per-artist status). */
export async function registrySubmissionsMine(env: Env | undefined): Promise<RegistrySubmission[]> {
	const out = await call<{ submissions: RegistrySubmission[] }>(
		env,
		`/v1/submissions/mine`,
		{ method: 'GET', auth: true },
		{ submissions: [] }
	);
	return out.submissions ?? [];
}

/** Build the registry `socials` payload from an artist's *Url fields. */
export function artistSocials(a: SocialUrls): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of SOCIAL_URL_KEYS) {
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
