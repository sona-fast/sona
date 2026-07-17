import { fetchTwitterAvatar, twitterHandleFromUrl } from './twitter-avatar';
import { getStorage, isAllowedImageType, extFromContentType, isOwnedUrl } from './storage';
import type { SiteSettings } from './settings';
import { getDb } from './db';
import { artists } from './db/schema';
import { eq, or, isNotNull, sql } from 'drizzle-orm';

type Env = App.Platform['env'];

/** Bound the avatar download so a slow/huge image can't stall the whole save. */
const REHOST_FETCH_TIMEOUT_MS = 8000;

/**
 * What re-hosting needs: the active storage provider (from env + settings) plus
 * the request origin, so an R2 dev URL ('/img/...') is absolutized before it's
 * stored. `keyHint` groups objects under a readable folder (the artist name);
 * a random uuid still makes the key unique.
 */
export interface AvatarRehostContext {
	env: Env | undefined;
	settings: SiteSettings;
	origin: string;
	keyHint: string;
}

/**
 * Download an avatar from its source (twimg / bsky CDN) and store it in OUR
 * image store, returning our own CDN URL. This is what stops the 404→monogram
 * rot: the source URL embeds a media id that changes when the artist updates
 * their picture, so a stored hotlink dies; a re-hosted copy never does.
 *
 * Fail-soft: any problem (non-2xx, disallowed type, storage not configured, put
 * error) logs and returns null so the caller keeps the source URL — a possibly
 * short-lived hotlink still beats no avatar at all.
 */
async function rehostAvatar(
	sourceUrl: string,
	ctx: AvatarRehostContext,
	handle: string
): Promise<string | null> {
	try {
		const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(REHOST_FETCH_TIMEOUT_MS) });
		if (!res.ok) {
			console.warn(`[avatar] rehost download failed: handle=${handle} status=${res.status}`);
			return null;
		}
		const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
		if (!isAllowedImageType(contentType)) {
			console.warn(`[avatar] rehost skipped: handle=${handle} unsupported type=${contentType || 'none'}`);
			return null;
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		const ext = extFromContentType(contentType);
		const uuid = crypto.randomUUID();
		const slug = ctx.keyHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artist';
		const storage = getStorage(ctx.env, ctx.settings);
		const { url } = await storage.put({
			suggestedKey: `avatars/${slug}/${uuid}.${ext}`,
			body: bytes,
			contentType,
			filename: `${uuid}.${ext}`
		});
		// Mirror the sticker/upload flows: a dev '/img/...' URL is absolutized so the
		// stored value is a usable absolute URL.
		return url.startsWith('/') ? new URL(url, ctx.origin).href : url;
	} catch (e) {
		console.warn(`[avatar] rehost error: handle=${handle} stage=store ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/**
 * Try to resolve an artist's avatar from their social media profiles.
 * Priority: Bluesky > Twitter > FurAffinity > Patreon
 *
 * When `rehost` is supplied, a resolved avatar is downloaded and stored in our
 * own image store and OUR URL is returned (falling back to the source URL if
 * re-hosting fails). Without it the raw source URL is returned — used only where
 * storage context isn't available (and by unit tests of the resolvers).
 */
export async function resolveAvatarUrl(
	socials: {
		blueskyUrl?: string | null;
		twitterUrl?: string | null;
		furAffinityUrl?: string | null;
		patreonUrl?: string | null;
	},
	rehost?: AvatarRehostContext
): Promise<string | null> {
	// Try Bluesky first — public API, no auth needed
	if (socials.blueskyUrl) {
		const avatar = await fetchBlueskyAvatar(socials.blueskyUrl);
		if (avatar) return rehost ? (await rehostAvatar(avatar, rehost, socials.blueskyUrl)) ?? avatar : avatar;
	}

	// Twitter next — the guest-token flow (see twitter-avatar.ts). Fail-soft:
	// a null here just means the artist saves without an avatar.
	if (socials.twitterUrl) {
		const avatar = await fetchTwitterAvatar(socials.twitterUrl);
		if (avatar) {
			const handle = twitterHandleFromUrl(socials.twitterUrl);
			return rehost ? (await rehostAvatar(avatar, rehost, handle)) ?? avatar : avatar;
		}
	}

	// Other platforms would need scraping or auth — skip for now
	// TODO: FurAffinity, Patreon avatar fetching

	return null;
}

/**
 * Whether a stored avatarUrl already points at OUR storage — i.e. it is not a
 * rotting hotlink, so it must never be re-selected as "rotted" nor clobbered
 * by one.
 *
 * isOwnedUrl alone is not enough on a no-CDN fork: with r2PublicUrl unset the
 * R2 provider's base is root-relative ('/img'), so rehostAvatar absolutizes
 * the stored URL against the request origin (https://fork.example/img/avatars/…).
 * owns() deliberately refuses to match an ABSOLUTE URL by its path alone (SSRF
 * guard, see r2.ts), so that stored value would look foreign and the 'rotted'
 * filter would re-host the fork's own avatars forever, churning storage. So we
 * additionally accept:
 *  - a root-relative URL ('/img/…' — ours by definition; NOT protocol-relative
 *    '//host/…', which is a different origin), and
 *  - an absolute URL on EXACTLY our origin whose pathname would be owned if
 *    taken root-relative — the no-CDN absolutized case above.
 * A same path on a different origin stays not-ours, preserving the SSRF
 * rationale in owns().
 */
export function isOurAvatarUrl(
	env: Env | undefined,
	settings: SiteSettings,
	origin: string,
	url: string
): boolean {
	if (isOwnedUrl(env, settings, url)) return true;
	if (url.startsWith('/') && !url.startsWith('//')) return true;
	try {
		const parsed = new URL(url);
		return parsed.origin === new URL(origin).origin && isOwnedUrl(env, settings, parsed.pathname);
	} catch {
		return false; // not absolute and not root-relative — can't be ours
	}
}

/**
 * Re-resolve + re-host a bounded batch of artist avatars. Shared by the admin
 * "refresh avatars" action (mode 'rotted' — repair rows that are null or still
 * hotlinked) and the refresh cron (mode 'oldest' — rotate through everyone
 * oldest-first so re-hosted copies track the artist's current picture).
 *
 * Bounded on purpose: it loads only lightweight columns (cheap even for the
 * whole table, so no D1 param-cap concern), then does the expensive fetch/store
 * work for at most `limit` rows, updating one row at a time. `remaining` lets a
 * caller (or the next cron run) see there's more to do.
 *
 * Clobber-safe: a row's avatar is overwritten only when re-resolution succeeds
 * AND the write wouldn't downgrade it — resolveAvatarUrl falls back to the
 * SOURCE hotlink when re-hosting fails, and writing that over a stored/owned
 * avatar would re-rot a good copy. So a non-ours result is written only over a
 * row that has no owned avatar to lose (null or an existing hotlink). Every
 * processed row gets its `avatarResolvedAt` stamped either way, so a
 * permanently unresolvable artist can't starve the rotation.
 */
export async function refreshArtistAvatars(
	db: ReturnType<typeof getDb>,
	opts: {
		env: Env | undefined;
		settings: SiteSettings;
		origin: string;
		limit: number;
		/** 'rotted' = only null/non-owned avatars (backfill); 'oldest' = all, oldest-first (cron). */
		mode: 'rotted' | 'oldest';
	}
): Promise<{ processed: number; refreshed: number; remaining: number }> {
	const { env, settings, origin, limit, mode } = opts;

	// Only Twitter and Bluesky resolve today (FA/Patreon are TODO), so an artist
	// with neither can never be refreshed — leave them out of the queue entirely.
	// NULLs-first ordering: `avatar_resolved_at IS NOT NULL` is 0 for nulls.
	const rows = await db
		.select({
			id: artists.id,
			name: artists.name,
			avatarUrl: artists.avatarUrl,
			twitterUrl: artists.twitterUrl,
			blueskyUrl: artists.blueskyUrl,
			furAffinityUrl: artists.furAffinityUrl,
			patreonUrl: artists.patreonUrl
		})
		.from(artists)
		.where(or(isNotNull(artists.twitterUrl), isNotNull(artists.blueskyUrl)))
		.orderBy(sql`${artists.avatarResolvedAt} IS NOT NULL`, artists.avatarResolvedAt, artists.id);

	const ours = (url: string) => isOurAvatarUrl(env, settings, origin, url);

	// A "rotted" candidate is one whose stored avatar is missing or still points at
	// a host we don't serve (twimg/bsky hotlink) — exactly the rows that can 404.
	// isOurAvatarUrl (not bare isOwnedUrl) so a no-CDN fork's own absolutized
	// avatars aren't misclassified as rotted and re-hosted forever.
	const candidates = mode === 'rotted' ? rows.filter((r) => !r.avatarUrl || !ours(r.avatarUrl)) : rows;

	const batch = candidates.slice(0, limit);
	let refreshed = 0;
	for (const a of batch) {
		let resolved: string | null = null;
		try {
			resolved = await resolveAvatarUrl(
				{
					blueskyUrl: a.blueskyUrl,
					twitterUrl: a.twitterUrl,
					furAffinityUrl: a.furAffinityUrl,
					patreonUrl: a.patreonUrl
				},
				{ env, settings, origin, keyHint: a.name }
			);
		} catch (e) {
			console.warn(`[avatar] refresh resolve threw: id=${a.id} ${e instanceof Error ? e.message : String(e)}`);
		}
		const set: { avatarResolvedAt: string; avatarUrl?: string } = {
			avatarResolvedAt: new Date().toISOString()
		};
		// Downgrade guard: resolveAvatarUrl returns the SOURCE hotlink when
		// re-hosting fails, and writing that over an avatar we host would re-rot
		// a good stored copy. Write a non-ours result only when the row has no
		// ours avatar to lose (a fresh hotlink still beats null or a stale one).
		if (resolved && (ours(resolved) || !a.avatarUrl || !ours(a.avatarUrl))) {
			set.avatarUrl = resolved;
			refreshed++;
		}
		await db.update(artists).set(set).where(eq(artists.id, a.id));
	}

	return { processed: batch.length, refreshed, remaining: candidates.length - batch.length };
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
