import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { getSetupState, hashToken } from '$lib/server/admin-auth';
import { getSettings } from '$lib/server/settings';
import {
	metricUpsert,
	recordError,
	pageViewStatements,
	routeClass,
	isAssetPath,
	deviceClass,
	referrerHost,
	countryCode,
	schedule,
	isObservabilityEnabled
} from '$lib/server/metrics';
import type { BatchItem } from 'drizzle-orm/batch';
import { THEME_MODE_COOKIE, SESSION_COOKIE, VIEWER_TZ_COOKIE } from '$lib/config';
import { eq } from 'drizzle-orm';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getTextDirection } from '$lib/paraglide/runtime';
import { isAdminAuthExempt } from '$lib/admin-routes';
import { viewerTimeZone } from '$lib/server/supporter-key-expiry';

// Resolve the request locale (cookie override → browser Accept-Language → en)
// and expose it to SSR by filling %lang% / %dir% in app.html.
const paraglideHandle: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request: localizedRequest, locale }) => {
		event.request = localizedRequest;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});
	});

// The hardening headers, shared by EVERY response path in authHandle: the
// early-return 400/401/503s and the header block at the bottom. One record so
// a sixth header added later cannot land on one path and miss another.
// (Cache-Control is not in here — each path sets its own.)
const SECURITY_HEADERS = {
	'Strict-Transport-Security': 'max-age=31536000',
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
} as const;
const SECURITY_HEADER_ENTRIES = Object.entries(SECURITY_HEADERS);

// Kit's decode_pathname, mirrored (see the comment in authHandle). Shared with
// handleError so both record the SAME route identity for a 5xx. Exported so a
// test can pin it against Kit's own source and fail if an upgrade diverges.
export const decodePathname = (pathname: string) => pathname.split('%25').map(decodeURI).join('%25');

// Exported for unit testing the auth/setup gate in isolation (driving the
// composed `handle` would also run paraglideMiddleware, which needs a full
// request pipeline).
export const authHandle: Handle = async ({ event, resolve }) => {
	// Every gate below compares the DECODED pathname, because that is what
	// SvelteKit routes on: its respond.js runs decode_pathname over the raw path
	// before matching, so `/%61dmin/images` and `/admin/images` reach the SAME
	// route handler. Gating on the raw `event.url.pathname` let a percent-encoded
	// first character skip the admin session gate, the /api 401 and the setup
	// gate while still resolving to the protected route (SONA-187). Some fork
	// zones normalize incoming URLs at the edge, which masked this — the app must
	// not depend on an edge setting each fork's owner controls.
	//
	// The decoding mirrors Kit's decode_pathname exactly: decodeURI leaves
	// reserved characters (%2F and friends) encoded, and the %25 split keeps a
	// literal %25 from ever double-decoding — so a double-encoded `/%2561dmin`
	// stays `/%2561dmin` here just as it does in the router (where it 404s).
	//
	// Not gate-only: the observability block at the bottom stores the decoded
	// path too (routeClass and the page-view path), so an encoded spelling rolls
	// up under the route it actually served rather than fragmenting the counters.
	let path: string;
	try {
		path = decodePathname(event.url.pathname);
	} catch {
		// Kit's own decode of this pathname throws too, so no route would ever
		// match it. Answer the malformed sequence before any gate logic runs.
		// This returns before the header block at the bottom of the handler, so
		// stamp the shared hardening headers (and an explicit no-store) here.
		// Content-Type is this path's own: a plain-text body needs saying so.
		return new Response('Malformed URI', {
			status: 400,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'private, no-store, no-cache',
				...SECURITY_HEADERS
			}
		});
	}

	// Gates apply to the decoded path; EXEMPTIONS apply only to the canonical
	// spelling. A non-canonical spelling routes to the same handler in Kit, but
	// other systems keyed on the LITERAL path do not recognize it: the zone
	// rate-limit rule (scripts/waf-lib.ts) matches the raw path, and the admin
	// layout reads isAdminAuthExempt($page.url.pathname). Letting `/api/%6Fembed`
	// pick up the /api/oembed exemption would serve it unauthenticated but
	// un-rate-limited, and an encoded /admin/login would render with the wrong
	// chrome. So encoded spellings get the strictest treatment: gates yes,
	// exemptions no — they 401/302 like any other protected path.
	const canonical = event.url.pathname === path;

	// The operator's zone, resolved once here so the admin loads and actions all
	// read the same value rather than each re-deriving it (SONA-119). Only the
	// admin area displays dates in it, and validating costs an Intl construction,
	// so public requests keep the UTC default rather than paying for it.
	event.locals.timeZone = path.startsWith('/admin')
		? viewerTimeZone(event.cookies.get(VIEWER_TZ_COOKIE))
		: 'UTC';

	const token = event.cookies.get(SESSION_COOKIE);

	// Validate session against D1
	if (token && event.platform?.env.DB) {
		try {
			const db = getDb(event.platform.env.DB);
			const session = await db
				.select()
				.from(sessions)
				.where(eq(sessions.token, await hashToken(token)))
				.get();

			if (session && new Date(session.expiresAt) > new Date()) {
				event.locals.admin = true;
			} else {
				event.locals.admin = false;
			}
		} catch {
			// Fail CLOSED: if the session lookup errors (e.g. a D1 outage), treat the
			// request as unauthenticated. The previous fallback to `!!token` granted
			// admin to ANY non-empty cookie during an outage — a privilege-escalation
			// hole. Login creates the session row, so a missing table can't be
			// bootstrapped by trusting the cookie here anyway.
			event.locals.admin = false;
		}
	} else {
		event.locals.admin = false;
	}

	// First-run setup gate, in three cases. Assets and the wizard itself are exempt
	// (so the gate never sees /admin/setup — that route guards itself; see below).
	// getSetupState caches the positive, so this is a no-op (no query) once the
	// site is configured.
	//
	//   complete   → through.
	//   incomplete → the wizard, for everything. A freshly deployed fork must not
	//                be browsable or admin-able before its owner has claimed it.
	//   unknown    → the read FAILED, so we know nothing. Public routes serve;
	//                /admin and /api stay shut.
	//
	// That last case is the one that changed (SONA-186). It used to collapse into
	// 'incomplete', which meant one failed read on a cold isolate showed a setup
	// wizard to every visitor of an established public gallery until a read
	// succeeded. Fail-closed was right about WHERE the risk is and wrong about
	// where the cost lands: an unclaimed fork has no content to leak through its
	// public routes, so serving a degraded page beats redirecting a live site
	// into someone else's setup screen.
	//
	// What actually stops a takeover during a blip is the setup ACTION, which
	// refuses when it cannot read the setup state, plus the mandatory SETUP_TOKEN
	// (see admin/setup/+page.server.ts). The 503 below is not that guard — note
	// that /admin/setup is exempt here, so the wizard renders during an outage
	// exactly as it did before. The 503 keeps the REST of the admin panel shut.
	const isSetupRoute = canonical && (path === '/admin/setup' || path.startsWith('/admin/setup/'));
	const isAsset =
		canonical && (path.startsWith('/_app/') || path === '/favicon.ico' || path === '/favicon.png');
	if (event.platform?.env.DB && !isSetupRoute && !isAsset) {
		const db = getDb(event.platform.env.DB);
		const state = await getSetupState(db, event.platform.env);
		switch (state) {
			case 'complete':
				break;
			case 'incomplete':
				if (path.startsWith('/api')) {
					return new Response('Setup required', {
						status: 503,
						headers: { 'Cache-Control': 'private, no-store, no-cache', ...SECURITY_HEADERS }
					});
				}
				throw redirect(302, '/admin/setup');
			case 'unknown':
				// 'unknown' is also what a fork whose D1 migrations never ran looks
				// like, so name that — otherwise its owner gets a bare 503 with no
				// way forward.
				if (path.startsWith('/admin') || path.startsWith('/api')) {
					// Retry-After says the state is transient rather than terminal. This
					// branch returns early, so it never reaches the header block at the
					// bottom of the handler — hence the explicit no-store.
					return new Response(
						'Setup state unavailable. If this is a new deployment, apply the D1 migrations.',
						{
							status: 503,
							headers: {
								'Retry-After': '30',
								'Cache-Control': 'private, no-store, no-cache',
								...SECURITY_HEADERS
							}
						}
					);
				}
				break;
			default:
				// A new SetupState must not fall through into "serve everything".
				throw new Error(`unhandled setup state: ${state satisfies never}`);
		}
	}

	// Protect admin routes (except login, the first-run setup wizard, and the
	// password-recovery pages). /admin/forgot + /admin/reset are reachable without
	// a session but stay behind the setup gate above, like /admin/login.
	if (path.startsWith('/admin') && !(canonical && isAdminAuthExempt(path))) {
		if (!event.locals.admin) {
			throw redirect(302, '/admin/login');
		}
	}

	// Protect API routes — fail closed for everything under /api EXCEPT the cron
	// namespace. /api/cron/* is machine-to-machine (an external scheduler, no admin
	// session) and enforces its own `Authorization: Bearer <CRON_SECRET>` inside the
	// endpoint, so it's exempted from the admin gate here. Everything else still
	// requires the admin session.
	//
	// /api/metrics/download is the second exemption: it is a beacon fired by anonymous
	// visitors pressing an image's download button, so it cannot require a session. It
	// enforces same-origin itself, accepts no body, and only ever bumps one aggregate
	// counter.
	//
	// /api/oembed is the third: third-party embedders (Discord, Slack, Telegram) fetch
	// it anonymously by definition — behind the gate it 401s and every link preview
	// breaks. It is GET-only, describes only its own host's URLs, and filters on
	// `published`. Keep this list short and each entry justified.
	//
	// Scoped to the two read methods, matching the WAF rule in scripts/waf-lib.ts
	// clause for clause. Today the route exports only GET, so SvelteKit already
	// answers anything else with a 405 before endpoint code runs — but that safety
	// lives in another file. Spelling the exemption as a path alone would silently
	// open this route to writes the day someone adds a POST handler there; spelling
	// it as a path AND a method cannot.
	const isOembedRead =
		canonical &&
		path === '/api/oembed' &&
		(event.request?.method === 'GET' || event.request?.method === 'HEAD');
	if (
		path.startsWith('/api') &&
		!(canonical && path.startsWith('/api/cron/')) &&
		!(canonical && path === '/api/metrics/download') &&
		!isOembedRead &&
		!event.locals.admin
	) {
		return new Response('Unauthorized', {
			status: 401,
			headers: { 'Cache-Control': 'private, no-store, no-cache', ...SECURITY_HEADERS }
		});
	}

	// Apply the active theme + the visitor's dark/light mode at SSR so the first
	// paint is correct (no flash). themeId comes from cached settings; mode from a
	// cookie the client toggle sets. Both fill placeholders in app.html. Skip the
	// settings read for assets/api (not HTML).
	// Explicit cookie wins; otherwise emit 'auto' and let a tiny head script resolve
	// it to the visitor's OS preference before first paint (see app.html).
	const modeCookie = event.cookies.get(THEME_MODE_COOKIE);
	const mode = modeCookie === 'light' || modeCookie === 'dark' ? modeCookie : 'auto';
	let themeId = 'default';
	if (event.platform?.env.DB && !isAsset && !path.startsWith('/api')) {
		try {
			themeId = (await getSettings(getDb(event.platform.env.DB))).themeId || 'default';
		} catch {
			themeId = 'default';
		}
	}
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%theme%', themeId).replace('%mode%', mode)
	});

	// Observability (issue #6): count one in-app request per non-asset path, keyed
	// by coarse route class only (never the raw path). Fire-and-forget via
	// waitUntil so it adds no latency and a metrics failure can't break the
	// response. Writes to THIS fork's own DB — tenant-isolated by construction.
	// Note: this counts app/SSR requests that reach the Function; edge-cached hits
	// and static assets are invisible here (the "app requests" label reflects that,
	// and the optional Cloudflare edge panel fills the gap).
	//
	// EVERY 5xx is also counted toward the error rate here — including DELIBERATE
	// error(5xx) responses (e.g. sticker downloads) that never reach handleError.
	// Counting 5xx only in handleError undercounted the rate, so the dashboard could
	// read "All clear" while a whole error class was broken. The rollup is recorded
	// exactly once per 5xx (here), keeping the error numerator and request
	// denominator consistent. handleError (which runs during resolve, before this
	// code) records the richer message for genuine exceptions and sets
	// locals.errorSampled; we skip the generic fallback sample for those so a thrown
	// error yields one detailed row, not a duplicate — but its rollup still lands
	// here, so it is never double-counted in the rate.
	if (event.platform?.env.DB && !isAssetPath(path) && isObservabilityEnabled(event.platform?.env)) {
		const db = getDb(event.platform.env.DB);
		// All rolled-up counters for this request go into ONE db.batch — the request
		// counter, the 5xx error rollup, and (below) the Tier-A page-view counters —
		// so a single request never fans out into five separate D1 writes.
		const counters: BatchItem<'sqlite'>[] = [metricUpsert(db, 'request', routeClass(path))];
		if (response.status >= 500) {
			counters.push(metricUpsert(db, 'error', String(response.status)));
		}

		// Tier-A visitor aggregate (issue #149). Count ONE page view for a successful
		// PUBLIC HTML response only: admin/api paths, non-HTML responses (feeds,
		// sitemaps, robots), non-200s and known bots are all excluded. Everything is
		// reduced to a PII-free label before storage — country from the edge header,
		// referrer to its bare host, the UA to a coarse device class then discarded.
		// No cookie, no IP, no per-visitor row.
		const isHtmlResp = response.headers.get('content-type')?.includes('text/html') ?? false;
		if (routeClass(path) === 'public' && response.status === 200 && isHtmlResp) {
			const device = deviceClass(event.request.headers.get('user-agent'));
			if (device) {
				counters.push(
					// The pageview key is deliberately the DECODED path: if a non-canonical
					// public URL ever ships (a non-ASCII slug), its counter splits at this
					// deploy boundary — intended, decoded is the canonical identity.
					...pageViewStatements(db, {
						path,
						device,
						referrerHost: referrerHost(event.request.headers.get('referer'), event.url.hostname),
						country: countryCode(event.request.headers.get('cf-ipcountry'))
					})
				);
			}
		}

		// The capped-ring error sample (a delete + insert with its own prune) stays
		// separate from the counter batch. Fire-and-forget so visitors never wait.
		const work: Promise<unknown>[] = [
			db.batch(counters as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
		];
		if (response.status >= 500 && !event.locals.errorSampled) {
			work.push(recordError(db, { route: path, status: response.status, message: `HTTP ${response.status}` }));
		}
		schedule(event.platform, Promise.all(work));
	}

	// Security headers. Content-Security-Policy is set separately by SvelteKit's
	// native CSP (kit.csp in svelte.config.js), which hashes its own inline scripts
	// — do not also set it here. HSTS is a plain header (no framework machinery):
	// force HTTPS for a year on THIS host only.
	//
	// Deliberately neither `includeSubDomains` nor `preload`. A fork runs on its
	// operator's own domain, often a personal apex with unrelated subdomains we
	// know nothing about — `includeSubDomains` would force HTTPS across all of
	// them for a year, browser-cached with no server-side undo, breaking any
	// plain-HTTP service the operator runs alongside their Sona site. The header
	// protects the Sona host, which is the host it is served from; widening it to
	// an operator's whole domain is their call to make at the edge, not ours to
	// make for them from inside the app.
	for (const [name, value] of SECURITY_HEADER_ENTRIES) {
		response.headers.set(name, value);
	}

	// Cache control. Page HTML is locale-dependent (chosen per-request from the
	// PARAGLIDE_LOCALE cookie / Accept-Language). Cloudflare's edge cache key is the
	// URL and does NOT vary on cookie/header, so HTML must not be shared-cached or a
	// visitor could be served another locale's cached page (and the language toggle,
	// which sets the cookie + reloads, must always get fresh HTML). Hence private +
	// no-cache for HTML. The Vary header reflects the locale inputs for any
	// intermediary that does honor it. Non-HTML public responses still edge-cache.
	// To recover edge caching for HTML, add a Cloudflare Cache Rule with a custom
	// cache key that includes the PARAGLIDE_LOCALE cookie (infra, not code).
	// Decoded for the same reason as the gates: an encoded /api or /admin path
	// must not pick up the public shared-cache default.
	const isPublic = !path.startsWith('/admin') && !path.startsWith('/api');
	const isHtml = response.headers.get('content-type')?.includes('text/html') ?? false;
	if (isPublic && (response.status === 200 || response.status === 304 || response.status === 206) && !isHtml) {
		// Honor a handler's explicit Cache-Control; only stamp the shared default
		// when the handler set nothing. Two intentional opt-outs exist today: the
		// sticker download fallback's no-store (a transient transform failure must
		// not be edge-cached under its ?format URL) and /img/[...key]'s
		// max-age=31536000+immutable (UUID-keyed R2 objects never change).
		// 304 rides this branch too: a conditional revalidation carries the
		// handler's Cache-Control and must not be clobbered with no-store below.
		if (!response.headers.has('Cache-Control')) {
			response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
		}
	} else if (isPublic && response.status === 200 && isHtml) {
		response.headers.set('Cache-Control', 'private, no-cache');
		response.headers.set('Vary', 'Cookie, Accept-Language');
	} else {
		response.headers.set('Cache-Control', 'private, no-store, no-cache');
	}

	return response;
};

export const handle: Handle = sequence(paraglideHandle, authHandle);

// Root-cause-first error segments. ORM wrappers (drizzle's DrizzleQueryError)
// put the SQL echo in .message and the actual platform failure ("D1_ERROR: …")
// on .cause — reading only .message stored 300 chars of column list and dropped
// the one string that mattered. Deepest cause leads so the storage clamp spends
// its budget there; wrapper text follows for query context. Cycle-safe via a
// Set of visited Errors. Returned as an ARRAY so recordError's redaction knows
// the real segment boundaries — it never trusts a ' ← ' inside a segment.
function causeChainMessage(error: unknown, fallback: string): string[] {
	// Segments go out RAW: a literal '←' inside one is neutralized by
	// recordError's per-segment cleaner, which every storage path shares.
	const parts: string[] = [];
	const seen = new Set<Error>();
	let cur: unknown = error;
	while (cur instanceof Error && !seen.has(cur)) {
		seen.add(cur);
		if (cur.message) parts.push(cur.message);
		cur = cur.cause;
	}
	// A walked chain can END on a non-Error STRING cause (`cause: 'socket
	// closed'`) — often the true root, so keep it. A BARE non-Error throw
	// (nothing walked) stays on the fallback: SvelteKit's own `message`
	// describes it better than an arbitrary stringification.
	if (seen.size > 0 && typeof cur === 'string' && cur) {
		parts.push(cur);
	}
	if (parts.length === 0) return [fallback];
	// parts is wrapper→root order: flip to root-first.
	return parts.reverse();
}

// Observability (issue #6): add the RICH error sample for genuine exceptions.
// handleError fires only for real thrown errors (not deliberate `error(4xx/5xx, …)`
// HttpErrors), and it's the one place the real message ("D1_ERROR: …") is
// available. It records ONLY the detailed capped-ring sample — the error-RATE
// rollup and the request counter are both incremented once per 5xx in authHandle
// above (which also samples the deliberate error(5xx) responses that never reach
// here). Setting locals.errorSampled tells that code to skip its generic fallback
// sample for this same 5xx, so a thrown error yields one detailed row, not a
// duplicate. Fire-and-forget so error handling never depends on the metrics write;
// returns undefined to keep SvelteKit's default error response unchanged.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (event.platform?.env.DB && status >= 500 && isObservabilityEnabled(event.platform?.env)) {
		event.locals.errorSampled = true;
		const db = getDb(event.platform.env.DB);
		const detail = causeChainMessage(error, message);
		// Same decoded route identity as authHandle's fallback sampler, so one 5xx
		// class never lands under two route strings. A malformed pathname (which
		// authHandle 400s before resolve, so it can't normally reach here) stays raw.
		let route: string;
		try {
			route = decodePathname(event.url.pathname);
		} catch {
			route = event.url.pathname;
		}
		schedule(event.platform, recordError(db, { route, status, message: detail }));
	}
};
