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
import { THEME_MODE_COOKIE, SESSION_COOKIE } from '$lib/config';
import { eq } from 'drizzle-orm';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getTextDirection } from '$lib/paraglide/runtime';

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

// Exported for unit testing the auth/setup gate in isolation (driving the
// composed `handle` would also run paraglideMiddleware, which needs a full
// request pipeline).
export const authHandle: Handle = async ({ event, resolve }) => {
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
	// (so the gate never sees /admin/setup — its own load is that route's guard).
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
	// where the cost lands: keeping /admin shut is what stops anyone reaching the
	// setup flow during a blip, while an unclaimed fork has no content to leak
	// through its public routes anyway. Serving a degraded page beats redirecting
	// a live site into someone else's setup screen.
	const path = event.url.pathname;
	const isSetupRoute = path === '/admin/setup' || path.startsWith('/admin/setup/');
	const isAsset = path.startsWith('/_app/') || path === '/favicon.ico' || path === '/favicon.png';
	if (event.platform?.env.DB && !isSetupRoute && !isAsset) {
		const db = getDb(event.platform.env.DB);
		const state = await getSetupState(db, event.platform.env);
		if (state === 'incomplete') {
			if (path.startsWith('/api')) return new Response('Setup required', { status: 503 });
			throw redirect(302, '/admin/setup');
		}
		if (state === 'unknown' && (path.startsWith('/admin') || path.startsWith('/api'))) {
			return new Response('Setup state unavailable', { status: 503 });
		}
	}

	// Protect admin routes (except login, the first-run setup wizard, and the
	// password-recovery pages). /admin/forgot + /admin/reset are reachable without
	// a session but stay behind the setup gate above, like /admin/login.
	if (
		event.url.pathname.startsWith('/admin') &&
		!event.url.pathname.startsWith('/admin/login') &&
		!event.url.pathname.startsWith('/admin/setup') &&
		!event.url.pathname.startsWith('/admin/forgot') &&
		!event.url.pathname.startsWith('/admin/reset')
	) {
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
	// counter. Keep this list short and each entry justified.
	if (
		event.url.pathname.startsWith('/api') &&
		!event.url.pathname.startsWith('/api/cron/') &&
		event.url.pathname !== '/api/metrics/download' &&
		!event.locals.admin
	) {
		return new Response('Unauthorized', { status: 401 });
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
	response.headers.set('Strict-Transport-Security', 'max-age=31536000');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	// Cache control. Page HTML is locale-dependent (chosen per-request from the
	// PARAGLIDE_LOCALE cookie / Accept-Language). Cloudflare's edge cache key is the
	// URL and does NOT vary on cookie/header, so HTML must not be shared-cached or a
	// visitor could be served another locale's cached page (and the language toggle,
	// which sets the cookie + reloads, must always get fresh HTML). Hence private +
	// no-cache for HTML. The Vary header reflects the locale inputs for any
	// intermediary that does honor it. Non-HTML public responses still edge-cache.
	// To recover edge caching for HTML, add a Cloudflare Cache Rule with a custom
	// cache key that includes the PARAGLIDE_LOCALE cookie (infra, not code).
	const isPublic = !event.url.pathname.startsWith('/admin') && !event.url.pathname.startsWith('/api');
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
		const detail = error instanceof Error ? error.message : message;
		schedule(
			event.platform,
			recordError(db, { route: event.url.pathname, status, message: detail })
		);
	}
};
