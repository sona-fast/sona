import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getSessionToken } from '$lib/server/auth';
import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { isSetupComplete } from '$lib/server/admin-auth';
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

const authHandle: Handle = async ({ event, resolve }) => {
	const token = getSessionToken(event.request.headers.get('cookie'));

	// Validate session against D1
	if (token && event.platform?.env.DB) {
		try {
			const db = getDb(event.platform.env.DB);
			const session = await db
				.select()
				.from(sessions)
				.where(eq(sessions.token, token))
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

	// First-run setup gate. Until an admin credential exists, force every request
	// to the setup wizard — a freshly deployed fork must not be browsable or
	// admin-able before its owner has claimed it. Assets and the wizard itself are
	// exempt. isSetupComplete caches the positive result, so this is a no-op (no
	// query) once the site is configured. Fails toward setup, never toward an open
	// admin (see admin-auth.ts).
	const path = event.url.pathname;
	const isSetupRoute = path === '/admin/setup' || path.startsWith('/admin/setup/');
	const isAsset = path.startsWith('/_app/') || path === '/favicon.ico' || path === '/favicon.png';
	if (event.platform?.env.DB && !isSetupRoute && !isAsset) {
		const db = getDb(event.platform.env.DB);
		if (!(await isSetupComplete(db, event.platform.env))) {
			if (path.startsWith('/api')) return new Response('Setup required', { status: 503 });
			throw redirect(302, '/admin/setup');
		}
	}

	// Protect admin routes (except login and the first-run setup wizard)
	if (
		event.url.pathname.startsWith('/admin') &&
		!event.url.pathname.startsWith('/admin/login') &&
		!event.url.pathname.startsWith('/admin/setup')
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
	if (
		event.url.pathname.startsWith('/api') &&
		!event.url.pathname.startsWith('/api/cron/') &&
		!event.locals.admin
	) {
		return new Response('Unauthorized', { status: 401 });
	}

	const response = await resolve(event);

	// Security headers
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
	if (isPublic && response.status === 200 && !isHtml) {
		response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
	} else if (isPublic && response.status === 200 && isHtml) {
		response.headers.set('Cache-Control', 'private, no-cache');
		response.headers.set('Vary', 'Cookie, Accept-Language');
	} else {
		response.headers.set('Cache-Control', 'private, no-store, no-cache');
	}

	return response;
};

export const handle: Handle = sequence(paraglideHandle, authHandle);
