import { fetchTwitterAvatar, twitterHandleFromUrl } from './twitter-avatar';
import { getStorage, isAllowedImageType, extFromContentType, isOwnedUrl } from './storage';
import { isPrivateHost } from './image-proxy';
import { bufferStream, MaxBytesExceededError } from './storage/buffer';
import type { SiteSettings } from './settings';
import { getRawSettings, saveSettings } from './settings';
import { getDb } from './db';
import { artists } from './db/schema';
import { eq, or, isNotNull, sql } from 'drizzle-orm';

type Env = App.Platform['env'];

/** Bound the avatar download so a slow/huge image can't stall the whole save. */
const REHOST_FETCH_TIMEOUT_MS = 8000;

/**
 * 2 MiB: the ceiling on the avatar body itself. The timeout above bounds this in
 * practice but not in principle — a fast upstream can hand over a great deal
 * inside 8 seconds, and Workers have a hard memory ceiling, so an unbounded
 * arrayBuffer() of whatever a third-party CDN chooses to send is an OOM waiting
 * for a bad day. That day is likelier now than it was: this download used to
 * happen only when an operator saved a form, and now runs unattended on every
 * fork, daily.
 *
 * 2 MiB is generous for what this is. Bluesky serves avatars at 1000px max and
 * twimg's `_400x400` is smaller still, so a few hundred KB is the real shape.
 * Deliberately far below MAX_REMOTE_BUFFER_BYTES (10 MiB), which is sized for
 * imported artwork; nothing on this path is artwork.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * A source URL we REFUSED, as distinct from one we tried and failed to copy.
 * The difference decides what the caller does with the source: a failed copy
 * falls back to it (a hotlink beats nothing), but falling back to a refused
 * private address would store an internal URL and serve it in a public
 * <img src> — the very fetch the refusal prevented, made from the visitor's
 * browser instead of ours.
 */
const REFUSED = Symbol('refused');

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
	/**
	 * Written by the re-host, never read by it: set when a download was abandoned
	 * because the source answered a 3xx (see the redirect posture below). It is an
	 * out-param rather than a return value because the only thing that needs to
	 * know is the OWNER heal, three frames up, and resolveAvatarUrl's contract
	 * (`string | null`, used by four other call sites) is not worth widening to
	 * carry it. Callers that don't care simply never look.
	 */
	redirected?: boolean;
}

/**
 * Download an avatar from its source (twimg / bsky CDN) and store it in OUR
 * image store, returning our own CDN URL. This is what stops the 404→monogram
 * rot: the source URL embeds a media id that changes when the artist updates
 * their picture, so a stored hotlink dies; a re-hosted copy never does.
 *
 * Fail-soft: any problem (non-2xx, disallowed type, a body past
 * MAX_AVATAR_BYTES, storage not configured, put error) logs and returns null so
 * the caller keeps the source URL — a possibly short-lived hotlink still beats
 * no avatar at all. The one exception is a refused private host, which returns
 * REFUSED so the caller drops the source rather than keeping it.
 *
 * Same outbound posture as the byte proxy (image-proxy.ts), which fetches the
 * same class of stored URL: private/link-local hosts are refused, and redirects
 * are NOT followed — a CDN answering a 3xx is unexpected enough to treat as an
 * upstream error rather than chase to an arbitrary location. It matters more
 * here than it used to, because the refresh cron now drives this unattended on
 * a daily schedule rather than only from an operator's save.
 */
async function rehostAvatar(
	sourceUrl: string,
	ctx: AvatarRehostContext,
	handle: string
): Promise<string | typeof REFUSED | null> {
	try {
		// Root-relative URLs have no hostname (already ours); absolute ones must
		// not point the server-side fetch at an internal host.
		let host = '';
		try {
			host = new URL(sourceUrl).hostname;
		} catch {
			// Defensive and untestable from here: source URLs always come from a
			// profile response, so a non-absolute one has no path into this function.
			// Left in because the alternative is a throw for a value we can treat as
			// "nothing to resolve outward".
		}
		if (isPrivateHost(host)) {
			console.warn(`[avatar] rehost refused: handle=${handle} private host`);
			return REFUSED;
		}
		const res = await fetch(sourceUrl, {
			signal: AbortSignal.timeout(REHOST_FETCH_TIMEOUT_MS),
			redirect: 'manual'
		});
		if (!res.ok) {
			// A 3xx gets its own line and its own flag. Not following it is correct
			// and stays, but it is not the same event as a 500 or a 404: those are one
			// artist having a bad morning, while a CDN moving avatars behind a
			// redirect stops re-hosting on every fork at once, on the same day,
			// silently — rows still get stamped, so nothing looks unprocessed. The
			// flag is what carries that as far as the owner clause of the cron's
			// heartbeat, which is the only part of this an operator ever sees.
			if (res.status >= 300 && res.status < 400) {
				ctx.redirected = true;
				console.warn(`[avatar] rehost download redirected: handle=${handle} status=${res.status} (not followed)`);
				return null;
			}
			console.warn(`[avatar] rehost download failed: handle=${handle} status=${res.status}`);
			return null;
		}
		const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
		if (!isAllowedImageType(contentType)) {
			console.warn(`[avatar] rehost skipped: handle=${handle} unsupported type=${contentType || 'none'}`);
			return null;
		}
		// Oversize is a plain failure, not a REFUSED: the source is a public CDN URL
		// and hotlinking it is safe, because the body we declined to hold in the
		// isolate is one a visitor's browser streams into an <img> without trouble.
		// The refusal above is the other case — there, falling back would make the
		// visitor's browser attempt the very request we prevented.
		//
		// Content-Length first, so an honest upstream costs nothing to refuse; the
		// length-limited read is what covers a missing or lying one. An absent
		// header reads as 0 here and falls through to the read, which is the point.
		const declared = Number(res.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
			console.warn(`[avatar] rehost skipped: handle=${handle} oversize content-length=${declared}`);
			return null;
		}
		if (!res.body) {
			console.warn(`[avatar] rehost skipped: handle=${handle} empty body`);
			return null;
		}
		let bytes: Uint8Array;
		try {
			bytes = await bufferStream(res.body, MAX_AVATAR_BYTES);
		} catch (e) {
			// Caught here rather than left to the outer catch so the log says what
			// actually happened; that one reports stage=store, which this is not.
			if (!(e instanceof MaxBytesExceededError)) throw e;
			console.warn(`[avatar] rehost skipped: handle=${handle} body over ${MAX_AVATAR_BYTES} bytes`);
			return null;
		}
		// An empty 200 is a failed copy, not a copy of nothing. It slips past both
		// size guards — `content-length: 0` is not over the ceiling, and `res.body`
		// is non-null for an empty 200 (the spec only nulls it for 204/205/304 and
		// HEAD) — so without this it would be stored and returned as a success.
		// That is the worst outcome available here: the URL is then one of ours, so
		// the owner heal's "already serving our own copy" skip short-circuits every
		// future run and pins the operator on a permanently blank avatar the daily
		// cron will never repair, while the panel reports it healed. Falling back
		// leaves the old URL in place and lets the next run try again.
		if (bytes.length === 0) {
			console.warn(`[avatar] rehost skipped: handle=${handle} empty body`);
			return null;
		}
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
 * re-hosting fails, or to null if the source was refused). Without it the raw
 * source URL is returned — used only where storage context isn't available (and
 * by unit tests of the resolvers).
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
	// `redirected` reports on THIS resolve, so clear it on the way in. Every
	// caller happens to build its context inline today, which is the only reason
	// a set-only flag reads correctly; a caller that reused one — sticker-import
	// already passes a context it owns — would otherwise attribute one subject's
	// redirect to every later one.
	if (rehost) rehost.redirected = false;

	// Store the copy where we can, keep the source hotlink where the copy failed,
	// and drop the URL entirely where it was refused (see REFUSED).
	const store = async (avatar: string, handle: string): Promise<string | null> => {
		if (!rehost) return avatar;
		const stored = await rehostAvatar(avatar, rehost, handle);
		if (stored === REFUSED) return null;
		return stored ?? avatar;
	};

	// Try Bluesky first — public API, no auth needed
	if (socials.blueskyUrl) {
		const avatar = await fetchBlueskyAvatar(socials.blueskyUrl);
		if (avatar) return store(avatar, socials.blueskyUrl);
	}

	// Twitter next — the guest-token flow (see twitter-avatar.ts). Fail-soft:
	// a null here just means the artist saves without an avatar.
	if (socials.twitterUrl) {
		const avatar = await fetchTwitterAvatar(socials.twitterUrl);
		if (avatar) return store(avatar, twitterHandleFromUrl(socials.twitterUrl));
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
 *  - an absolute URL on EXACTLY one of our known-self origins whose pathname
 *    would be owned if taken root-relative — the no-CDN absolutized case above.
 *    Known-self origins are the current request origin PLUS the configured
 *    Site URL (settings.siteUrl) when one is set, so an avatar absolutized
 *    under the canonical host is still ours when a later request arrives on
 *    another of our hosts (preview deploy, apex vs www).
 * A same path on ANY other origin stays not-ours, preserving the SSRF
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
		const selfOrigins = [new URL(origin).origin];
		if (settings.siteUrl) {
			try {
				selfOrigins.push(new URL(settings.siteUrl).origin);
			} catch {
				// a malformed configured Site URL must not widen (or break) the check
			}
		}
		return selfOrigins.includes(parsed.origin) && isOwnedUrl(env, settings, parsed.pathname);
	} catch {
		return false; // not absolute and not root-relative — can't be ours
	}
}

/**
 * The single write-gate for avatar updates, shared by the refresh loop, the
 * admin artists update action, and settings saveSite. Rationale (written once,
 * here): resolveAvatarUrl falls back to the SOURCE hotlink when re-hosting
 * fails, and returns null when resolution fails entirely — writing either over
 * an avatar we host would re-rot (or wipe) a good stored copy on a transient
 * failure. So a resolved URL is written only when it's ours, or when the row
 * has no owned avatar to lose (a fresh hotlink still beats null or a stale
 * hotlink). What a refused write means per call site ('' vs null vs omit,
 * stamping) stays local to that site.
 */
export function shouldWriteAvatar(
	env: Env | undefined,
	settings: SiteSettings,
	origin: string,
	currentUrl: string | null | undefined,
	resolved: string | null
): boolean {
	const ours = (u: string) => isOurAvatarUrl(env, settings, origin, u);
	return !!resolved && (ours(resolved) || !currentUrl || !ours(currentUrl));
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
 * Clobber-safe: a row's avatar is overwritten only when shouldWriteAvatar
 * allows it (downgrade-guard rationale lives on that predicate). Every
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

	// No limit, nothing to say: the cron calls this with 0 on every site that
	// never opted into artist refreshing, and counting a `remaining` it will never
	// work through would report a permanent backlog to sites that chose not to
	// have one. It also saves the full artist SELECT on the daily no-op run.
	if (limit <= 0) return { processed: 0, refreshed: 0, remaining: 0 };

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
		// Downgrade guard: see shouldWriteAvatar. (`resolved &&` repeats its null
		// check only so TypeScript narrows the assignment below.)
		if (resolved && shouldWriteAvatar(env, settings, origin, a.avatarUrl, resolved)) {
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

/**
 * What one heal attempt did. Four outcomes, one value: 'skipped' is "nothing to
 * heal, or nothing to heal FROM" (no handle, or the stored avatar is already
 * ours), 'healed' is "a copy we serve is now stored", 'unresolved' is "we tried
 * and the owner is still on someone else's host".
 *
 * 'redirected' is that same failure with its cause named: the source answered a
 * 3xx, which the download refuses to follow. It earns its own outcome because it
 * is the one failure here that isn't about this fork — if a CDN ever fronts
 * avatars behind a redirect, every fork reports it on the same morning, and
 * without the distinction each operator sees a permanent 'unresolved' that no
 * amount of re-running or reconfiguring will clear.
 */
export type OwnerAvatarHeal = 'skipped' | 'healed' | 'unresolved' | 'redirected';

/**
 * Heal the OWNER avatar if a previous re-host left a hotlink behind.
 *
 * resolveAvatarUrl falls back to the source hotlink when re-hosting fails, and
 * settings saveSite writes that fallback rather than losing the picture
 * entirely. Until this existed nothing ever retried, because the avatar refresh
 * cron covered artists only, so one transient R2 or network failure pinned the
 * owner on a third-party URL indefinitely — a URL that can rot to a 404, and
 * that serves the operator's face from a host we do not control. (Readability
 * is no longer part of the argument: /api/admin/avatar proxies those bytes
 * same-origin for the con card, see docs/reading-image-bytes.md.)
 *
 * Heal-only on purpose. An owner avatar we already serve is left alone rather
 * than re-fetched daily, matching the skip saveSite already makes, so a healthy
 * fork pays one settings read and no network call.
 *
 * A fork that is NOT healthy pays a profile lookup every run until it heals,
 * which is usually once. The exception is an operator with a Bluesky handle and
 * no picture on it: that resolves to nothing every night indefinitely, and the
 * panel carries a "not re-hosted this run" line for a fork nobody needs to fix.
 * Left as-is rather than remembered, because a stored "gave up" flag is a second
 * piece of state to invalidate when they finally set a picture.
 */
export async function healOwnerAvatar(
	db: ReturnType<typeof getDb>,
	opts: { env: Env | undefined; settings: SiteSettings; origin: string }
): Promise<OwnerAvatarHeal> {
	const { env, settings } = opts;

	// The trust anchor for "ours" is the CONFIGURED site origin where there is
	// one, and only the request origin as a fallback. This runs unattended behind
	// a shared secret and the value it writes is site-wide, so which of the
	// hostnames this fork answers on the caller happened to use must not decide
	// what counts as our own storage — a machine endpoint should not take its
	// canonical identity from a request header. A malformed configured value
	// falls back rather than breaking the check (same posture as isOurAvatarUrl).
	//
	// Scoped to the heal on purpose. refreshArtistAvatars, called from the same
	// handler, still anchors on the request origin; hoisting this there would
	// change which host a no-CDN fork's ARTIST avatars are absolutized under, so
	// it needs its own change and its own tests rather than a blind sync.
	let origin = opts.origin;
	if (settings.siteUrl) {
		try {
			origin = new URL(settings.siteUrl).origin;
		} catch {
			// keep the request origin
		}
	}

	// The two OWNER fields come from D1, never from the caller's settings
	// snapshot. The cron reads settings once and then spends minutes in the
	// artist batch, and the operator can save the site tab during it (the
	// workflow has a workflow_dispatch, so a hand-fired run right after noticing
	// a broken avatar is the likely case, not a theoretical one). Deciding from
	// the stale snapshot would resolve the OLD handle and overwrite a just-saved
	// adminAvatarUrl with the previous account's face — exactly what saveSite's
	// handleChanged branch exists to prevent — and since that value is then one
	// of ours, the "already serving our own copy" skip below would short-circuit
	// every future run and make the corruption permanent. The same read is what
	// stops an avatar the operator deliberately cleared from being resurrected.
	// `settings` still supplies the STORAGE config (provider, CDN base, site
	// URL). siteUrl is a site-tab field too, so it can go stale in the same
	// window, but the consequence there is self-correcting rather than corrupting:
	// a stale siteUrl absolutizes the copy under the old host, and the next run
	// reads that value as not-ours and heals it again.
	const before = await getRawSettings(db, ['blueskyUrl', 'adminAvatarUrl']);
	const blueskyUrl = before.blueskyUrl ?? '';
	const current = before.adminAvatarUrl ?? '';
	// Only Bluesky resolves for the owner today, same as saveSite.
	if (!blueskyUrl) return 'skipped';

	const ours = (u: string) => isOurAvatarUrl(env, settings, origin, u);
	// Already serving our own copy: nothing to heal.
	if (current && ours(current)) return 'skipped';

	// Unguarded on purpose: resolveAvatarUrl is fail-soft end to end (the profile
	// fetch and the re-host each swallow their own failures), so a try here would
	// be a catch nothing can reach. The throws that ARE reachable in this function
	// are the settings reads and the write, and the cron's catch reports those.
	// The context is held rather than passed inline so its `redirected` out-param
	// can be read back below.
	const ctx: AvatarRehostContext = { env, settings, origin, keyHint: 'owner' };
	const resolved = await resolveAvatarUrl({ blueskyUrl }, ctx);

	// The one and only write gate here. resolveAvatarUrl falls back to the SOURCE
	// hotlink when re-hosting fails, so only a copy we serve counts as healed —
	// writing another hotlink over the one already stored would churn the row and
	// change nothing. The shared shouldWriteAvatar predicate is deliberately NOT
	// also consulted: past this line `resolved` is non-null and ours, which
	// satisfies its first disjunct unconditionally, so calling it would advertise
	// a gate that can never refuse. The null check stays because `ours(null)`
	// throws, and a TypeError surfaced as a failed heal is a worse account of a
	// 404ing profile than this line's honest 'unresolved'.
	if (!resolved || !ours(resolved)) return ctx.redirected ? 'redirected' : 'unresolved';

	// Re-read immediately before the write. The resolve above spends seconds on
	// the network, and the handle it ran against is the entire justification for
	// the value it produced: if the operator changed or cleared their Bluesky
	// field in the meantime, this copy is of an account that is no longer theirs.
	//
	// Reading blueskyUrl ALONE is safe only because of a key order elsewhere:
	// saveSite hands saveSettings one object whose blueskyUrl key comes before
	// adminAvatarUrl, and saveSettings writes the keys one at a time with no
	// transaction. So a concurrent save that has already written its avatar has
	// necessarily written its handle first, and this read sees it. Swap those two
	// keys in that object literal and a save caught mid-flight would slip past
	// this guard and lose its just-written avatar to the line below.
	const now = await getRawSettings(db, ['blueskyUrl']);
	if ((now.blueskyUrl ?? '') !== blueskyUrl) return 'unresolved';

	// saveSettings, not a raw upsert: it is the helper every other settings write
	// uses (saveSite writes this same key through it) and it clears the settings
	// cache itself, so the isolate that just repaired the row stops serving the
	// hotlink it replaced instead of holding it for the rest of SETTINGS_TTL_MS.
	await saveSettings(db, { adminAvatarUrl: resolved });
	return 'healed';
}
