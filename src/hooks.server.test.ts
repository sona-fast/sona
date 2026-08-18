import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { isRedirect } from '@sveltejs/kit';
import { DrizzleQueryError } from 'drizzle-orm/errors';

// Control the setup gate without touching D1. The spread keeps the rest of the
// module real — hashToken in particular, which the hook AND the authenticated
// cache test below both need to agree on.
vi.mock('$lib/server/admin-auth', async (orig) => ({
	...(await orig<typeof import('$lib/server/admin-auth')>()),
	getSetupState: vi.fn()
}));

import { getSetupState, hashToken } from '$lib/server/admin-auth';
import { authHandle, handleError } from './hooks.server';

import { makeD1 } from '$lib/server/test/d1';
import { ADMIN_AUTH_EXEMPT, isAdminAuthExempt } from '$lib/admin-routes';
import { SESSION_COOKIE, VIEWER_TZ_COOKIE } from '$lib/config';

function makeDb(): D1Database {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	return makeD1(sqlite);
}

// No session cookie — cookies.get returns undefined for every key, so the request
// is unauthenticated (locals.admin = false).
function makeEvent(pathname: string, db: D1Database, method = 'GET') {
	const url = new URL(`https://taro.surf${pathname}`);
	return {
		cookies: { get: () => undefined },
		url,
		// The gate reads the method for the /api/oembed exemption, so events carry a
		// real Request. Defaults to GET, which is what every other case here implies.
		request: new Request(url, { method }),
		locals: {} as App.Locals,
		platform: { env: { DB: db } } as unknown as App.Platform
	} as never;
}

const resolve = async () =>
	new Response('ok', { headers: { 'content-type': 'text/html' } });

async function redirectFor(pathname: string, db: D1Database): Promise<{ status: number; location: string } | null> {
	try {
		await authHandle({ event: makeEvent(pathname, db), resolve } as never);
		return null;
	} catch (e) {
		if (isRedirect(e)) return { status: e.status, location: e.location };
		throw e;
	}
}

describe('authHandle — password-recovery route exemption', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockReset();
		// mockReset leaves it resolving undefined, which the gate's exhaustive
		// default turns into a thrown "unhandled setup state". Default to a
		// configured site so a test that forgets to set the state fails on its own
		// assertion instead. Cases that want 'incomplete' still override.
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	it('lets /admin/forgot and /admin/reset through without a login redirect', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
		const db = makeDb();

		expect(await redirectFor('/admin/forgot', db)).toBeNull();
		expect(await redirectFor('/admin/reset', db)).toBeNull();
	});

	it('still redirects other admin routes to /admin/login without a session', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
		const db = makeDb();

		expect(await redirectFor('/admin/images', db)).toEqual({ status: 302, location: '/admin/login' });
		expect(await redirectFor('/admin/settings', db)).toEqual({ status: 302, location: '/admin/login' });
		// Observability (issue #6) is a normal admin route — no session, no access.
		expect(await redirectFor('/admin/observability', db)).toEqual({ status: 302, location: '/admin/login' });
	});

	it('sends /admin/forgot to /admin/setup when setup is incomplete (setup gate wins)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		const db = makeDb();

		expect(await redirectFor('/admin/forgot', db)).toEqual({ status: 302, location: '/admin/setup' });
	});

	// The exempt list is one shared array now (SONA-119) — hooks.server.ts gates
	// on it and the admin layout decides bare chrome and operator cookies from it.
	// Drive every entry so a deletion can't slip through: dropping '/admin/setup'
	// in particular would make first-run install redirect /admin/setup →
	// /admin/login → /admin/setup forever, and nothing else in the suite notices.
	it('lets every exempt route through with setup complete', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
		const db = makeDb();

		for (const route of ADMIN_AUTH_EXEMPT) {
			expect(await redirectFor(route, db)).toBeNull();
		}
	});

	it('leaves /admin/setup reachable while setup is incomplete (no redirect loop)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		const db = makeDb();

		expect(await redirectFor('/admin/setup', db)).toBeNull();
	});
});

// SONA-119: the operator's zone is resolved once here so the admin loads and
// actions all read one value. The cookie is attacker-suppliable and an unknown
// zone makes Intl throw, so an unguarded value would 500 every admin page.
describe('authHandle — viewer timezone on locals', () => {
	function tzEvent(pathname: string, tz?: string) {
		return {
			cookies: { get: (name: string) => (name === VIEWER_TZ_COOKIE ? tz : undefined) },
			url: new URL(`https://taro.surf${pathname}`),
			locals: {} as App.Locals,
			platform: { env: {} }
		};
	}
	const resolveTz = async (pathname: string, tz?: string) => {
		const event = tzEvent(pathname, tz);
		// The zone is set before the session check, so an unauthenticated admin
		// path still resolves it and then throws its redirect — swallow that.
		try {
			await authHandle({ event, resolve: async () => new Response('ok') } as never);
		} catch {
			// The redirect; the zone is already on locals.
		}
		return event.locals.timeZone;
	};

	it('resolves a real zone from the cookie on admin requests', async () => {
		expect(await resolveTz('/admin/settings', 'Asia/Tokyo')).toBe('Asia/Tokyo');
	});

	it('falls back to UTC with no cookie', async () => {
		expect(await resolveTz('/admin/settings')).toBe('UTC');
	});

	it('falls back to UTC on a hostile cookie rather than throwing', async () => {
		expect(await resolveTz('/admin/settings', 'Not/AZone')).toBe('UTC');
		expect(await resolveTz('/admin/settings', '../../etc/passwd')).toBe('UTC');
	});

	it('does not pay for zone validation on public requests', async () => {
		// Only the admin area displays dates in the operator's zone; a public hit
		// should not spend an Intl construction per request.
		expect(await resolveTz('/gallery', 'Asia/Tokyo')).toBe('UTC');
	});
});

describe('isAdminAuthExempt — segment matching', () => {
	it('exempts an exempt route and its children', () => {
		expect(isAdminAuthExempt('/admin/reset')).toBe(true);
		// A recovery link carrying its token stays with its parent.
		expect(isAdminAuthExempt('/admin/reset/abc123')).toBe(true);
	});

	it('does not exempt a sibling that merely shares the prefix', () => {
		// A bare startsWith would hand these to anonymous visitors.
		expect(isAdminAuthExempt('/admin/login-history')).toBe(false);
		expect(isAdminAuthExempt('/admin/setup-audit')).toBe(false);
		expect(isAdminAuthExempt('/admin/resets')).toBe(false);
	});

	it('does not exempt ordinary admin routes', () => {
		expect(isAdminAuthExempt('/admin/settings')).toBe(false);
		expect(isAdminAuthExempt('/admin/logout')).toBe(false);
	});
});

describe('authHandle — /api/admin/ref-image stays behind the admin gate', () => {
	it('returns 401 without a session (not in the /api/cron/ exempt namespace)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
		const db = makeDb();

		const res = (await authHandle({
			event: makeEvent('/api/admin/ref-image?id=1', db),
			resolve
		} as never)) as Response;

		expect(res.status).toBe(401);
	});
});

describe('authHandle — /api/metrics/download is public', () => {
	it('reaches the endpoint without a session (an anonymous visitor pressed download)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		const res = (await authHandle({
			event: makeEvent('/api/metrics/download', makeDb()),
			resolve
		} as never)) as Response;

		// Not 401: the gate let it through to the endpoint, which does its own
		// same-origin check. Anything but 401 proves the exemption is wired.
		expect(res.status).not.toBe(401);
	});

	it('does not exempt sibling paths — a prefix match would open the whole namespace', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		for (const path of ['/api/metrics', '/api/metrics/download/extra', '/api/metrics/other']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must stay behind the admin gate`).toBe(401);
		}
	});
});

describe('authHandle — /api/oembed is public (third-party embedders have no session)', () => {
	it('reaches the endpoint without a session (a link preview is fetched anonymously)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		// HEAD as well as GET: SvelteKit runs the GET handler for HEAD when no HEAD is
		// exported, so a HEAD does the same work and must be exempt for the same reason.
		for (const method of ['GET', 'HEAD']) {
			const res = (await authHandle({
				event: makeEvent('/api/oembed', makeDb(), method),
				resolve
			} as never)) as Response;

			// Not 401: the gate let it through to the endpoint, which validates the url
			// param and filters on `published` itself.
			expect(res.status, method).not.toBe(401);
		}
	});

	it('does not exempt write methods — a POST handler added later must not be public', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		// The route exports only GET today, so SvelteKit answers these with a 405
		// before endpoint code runs. That safety lives in another file, though: this
		// asserts the GATE itself refuses them, so adding a POST handler to the
		// endpoint cannot silently make it anonymously writable.
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const res = (await authHandle({
				event: makeEvent('/api/oembed', makeDb(), method),
				resolve
			} as never)) as Response;

			expect(res.status, `${method} /api/oembed must stay behind the admin gate`).toBe(401);
		}
	});

	it('does not exempt sibling paths — a prefix match would open the whole namespace', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		for (const path of ['/api/oembed/extra', '/api/oembedx']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must stay behind the admin gate`).toBe(401);
		}
	});

	it('does not exempt a non-canonical spelling — exemptions are canonical-only (SONA-187)', async () => {
		vi.mocked(getSetupState).mockResolvedValue('complete');

		// '/api/%6Fembed' routes to /api/oembed in Kit, but the exemption must NOT
		// follow it there: other systems keyed on the LITERAL path (the zone
		// rate-limit rule in scripts/waf-lib.ts, the admin layout's
		// isAdminAuthExempt($page.url.pathname) read) do not recognize the encoded
		// spelling, so exempting it would serve it unauthenticated but
		// un-rate-limited. Encoded spellings get gates, never exemptions — the
		// /api/cron/ namespace included.
		for (const path of ['/api/%6Fembed', '/api/metrics/downloa%64', '/api/cro%6E/purge']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must stay behind the admin gate`).toBe(401);
		}

		// Same for the admin-side exemptions: an encoded spelling of /admin/login
		// is an ordinary admin path to the gate and redirects like one.
		const db = makeDb();
		expect(await redirectFor('/admin/lo%67in', db)).toEqual({ status: 302, location: '/admin/login' });
		expect(await redirectFor('/%61dmin/login', db)).toEqual({ status: 302, location: '/admin/login' });
	});
});

// SONA-187: SvelteKit matches routes on the DECODED pathname, so every gate
// must too — a percent-encoded first character ('/%61dmin' = '/admin') used to
// skip the admin session gate, the /api 401 and the setup gate while still
// resolving to the protected route.
describe('authHandle — percent-encoded paths cannot bypass the gates (SONA-187)', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockReset();
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	it('redirects an encoded admin path to /admin/login like its decoded twin', async () => {
		const db = makeDb();
		expect(await redirectFor('/%61dmin/images', db)).toEqual({ status: 302, location: '/admin/login' });
		expect(await redirectFor('/admin/%69mages', db)).toEqual({ status: 302, location: '/admin/login' });
	});

	it('returns 401 for an encoded /api path without a session', async () => {
		for (const path of ['/%61pi/artists', '/api/%61rtists']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must stay behind the admin gate`).toBe(401);
		}
	});

	it('keeps the setup gate closed for encoded paths while setup is incomplete', async () => {
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		const db = makeDb();

		// An encoded /api path takes the API branch (503), not the page redirect.
		const res = (await authHandle({
			event: makeEvent('/%61pi/artists', db),
			resolve
		} as never)) as Response;
		expect(res.status).toBe(503);

		expect(await redirectFor('/%61dmin/images', db)).toEqual({ status: 302, location: '/admin/setup' });
	});

	it('keeps admin and api shut for encoded paths while the setup state is unknown', async () => {
		vi.mocked(getSetupState).mockResolvedValue('unknown');

		for (const path of ['/%61dmin/images', '/%61pi/artists']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must 503 while the setup state is unknown`).toBe(503);
		}
	});

	it('answers a malformed percent-sequence with a 400 before any gate runs', async () => {
		// decodeURI throws on this, and so does Kit's own decode_pathname — no
		// route could ever match it, so the hook refuses it outright.
		const res = (await authHandle({
			event: makeEvent('/%E0%A4%A', makeDb()),
			resolve
		} as never)) as Response;
		expect(res.status).toBe(400);
		// The 400 returns before the header block at the bottom of the handler, so
		// it must carry its own hardening headers and an explicit no-store.
		expect(res.headers.get('Cache-Control')).toBe('private, no-store, no-cache');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		// The plain-text body declares itself; nothing invites content sniffing.
		expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
	});

	it('does not double-decode: a %25-escaped spelling stays literal, like in the router', async () => {
		// '/%2561dmin' stays '/%2561dmin' (the %25 split blocks the second decode),
		// in Kit's router too, so no /admin route matches it.
		// The gate must neither 400 it nor treat it as /admin.
		const db = makeDb();
		expect(await redirectFor('/%2561dmin/images', db)).toBeNull();
	});

	it('still serves legitimately encoded public routes', async () => {
		const db = makeDb();
		for (const path of ['/tags/foo%20bar', '/img/2024%2Fkey.png']) {
			const res = (await authHandle({
				event: makeEvent(path, db),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must resolve normally`).toBe(200);
		}
	});

	it('stamps the private no-store default on an authenticated encoded /api response, never the public one', async () => {
		// The cache branch reads the DECODED path too (isPublic in hooks.server.ts).
		// An admin with a valid session passes the /api gate, so their encoded /api
		// spelling DOES reach resolve — and the non-HTML 200 coming back must get
		// the private default. The encoding sits in the FIRST segment ('/%61pi'),
		// so the raw pathname does not start with '/api': an isPublic that read the
		// raw pathname would stamp the public s-maxage default on this private
		// JSON, which is exactly the regression this test discriminates.
		const sqlite = new Database(':memory:');
		sqlite.exec(`
			CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
		`);
		sqlite
			.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
			.run(await hashToken('some-token'), new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());
		const url = new URL('https://taro.surf/%61pi/artists');
		const res = (await authHandle({
			event: {
				cookies: { get: (name: string) => (name === SESSION_COOKIE ? 'some-token' : undefined) },
				url,
				request: new Request(url),
				locals: {} as App.Locals,
				platform: { env: { DB: makeD1(sqlite) } } as unknown as App.Platform
			} as never,
			resolve: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
		} as never)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('private, no-store, no-cache');
	});

	it('keeps an encoded-slash /api path behind the gate', async () => {
		// '/api%2Foembed' survives decodeURI unchanged (reserved chars stay
		// encoded), so it is canonical but NOT '/api/oembed' — no exemption, 401.
		// (This does not discriminate the decodeURI/decodeURIComponent choice —
		// it 401s under either; the asset test below is what pins the decoder.)
		const res = (await authHandle({
			event: makeEvent('/api%2Foembed', makeDb()),
			resolve
		} as never)) as Response;
		expect(res.status).toBe(401);
	});

	it('an encoded-slash asset path stays canonical under decodeURI and exempt from the setup gate', async () => {
		// '/_app/immutable/chunk%2Fx.js' survives decodeURI unchanged, so it is
		// canonical and isAsset exempts it from the setup gate — it must resolve.
		// Under a decodeURIComponent swap the %2F becomes a slash, canonicity
		// breaks, isAsset goes false and the incomplete-setup redirect fires: THIS
		// is the observable difference between the two decoders.
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		expect(await redirectFor('/_app/immutable/chunk%2Fx.js', makeDb())).toBeNull();
	});

	it('does not exempt a non-canonical asset spelling from the setup gate', async () => {
		// isAsset is canonical-only like every other exemption: '/_a%70p/…' routes
		// to the asset path in Kit but must still hit the setup gate here.
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		expect(await redirectFor('/_a%70p/immutable/x.js', makeDb())).toEqual({ status: 302, location: '/admin/setup' });
	});

	it('treats an encoded /admin/setup spelling as an ordinary admin path in the setup gate', async () => {
		// The setup-route exemption is canonical-only too: while setup is
		// incomplete, an encoded spelling of the wizard redirects into the real one
		// instead of rendering under the encoded URL.
		vi.mocked(getSetupState).mockResolvedValue('incomplete');
		const db = makeDb();
		expect(await redirectFor('/admin/setu%70', db)).toEqual({ status: 302, location: '/admin/setup' });
	});
});

// Observability 5xx accounting (issue #6). A metrics-capable DB plus a waitUntil
// that captures the fire-and-forget writes so a test can await them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMetricsDb(): { db: D1Database; sqlite: any } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sqlite = new Database(':memory:') as any;
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE metric_rollup (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim));
		CREATE TABLE error_sample (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, message TEXT NOT NULL);
		CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);
	`);
	return { db: makeD1(sqlite), sqlite };
}

// envExtra defaults to the enabled flag so the existing 5xx-accounting tests
// exercise the write path; the off-flag test passes {} to leave it disabled.
function metricsEvent(
	pathname: string,
	db: D1Database,
	waits: Promise<unknown>[],
	locals: App.Locals = { timeZone: 'UTC' },
	envExtra: Record<string, string> = { OBSERVABILITY_ENABLED: 'true' }
) {
	return {
		cookies: { get: () => undefined },
		url: new URL(`https://taro.surf${pathname}`),
		locals,
		platform: { env: { DB: db, ...envExtra }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
	} as never;
}

describe('handleError — rich 5xx sample (issue #6)', () => {
	it('records ONE detailed error sample (no rollup) and flags the event for a 5xx', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const locals = {} as App.Locals;
		const event = metricsEvent('/admin/images', db, waits, locals);

		handleError({ error: new Error('D1_ERROR: boom'), event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		// The detailed row carries the real message; the RATE rollup is authHandle's job.
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: '/admin/images', status: 500, message: 'D1_ERROR: boom' }]);
		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='error'").get().c).toBe(0);
		// The flag tells authHandle to skip its generic fallback sample for this 5xx.
		expect(locals.errorSampled).toBe(true);
	});

	it('stores the root cause FIRST when the thrown error wraps one (drizzle-style)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		// DrizzleQueryError shape: SQL echo in .message, the real failure on .cause.
		// The cause must lead so the 300-char storage clamp can't truncate it away
		// behind a long column list (the 2026-08-12 sticker 500s stored only SQL).
		const wrapper = new Error('Failed query: select "id", "pack_id" from "stickers" where …', {
			cause: new Error('D1_ERROR: Network connection lost.')
		});
		handleError({ error: wrapper, event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toMatch(/^D1_ERROR: Network connection lost\./);
		expect(row.message).toContain('Failed query');
	});

	it('terminates on a CYCLIC cause chain and stores no repeated segments', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		// a.cause = b; b.cause = a — the walk must stop at the first revisit, not spin.
		const a = new Error('outer failure');
		const b = new Error('inner failure');
		a.cause = b;
		b.cause = a;
		handleError({ error: a, event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('inner failure ← outer failure');
	});

	it('keeps the ROOT cause when the chain is deeper than the message bound', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		// A 9-deep chain: root wrapped by wrappers 1..8 (wrapper 8 outermost).
		// Root-first ordering means the storage clamp can only ever cut the
		// shallow wrapper end — the root always leads.
		let err = new Error('root cause');
		for (let i = 1; i <= 8; i++) err = new Error(`wrapper ${i}`, { cause: err });
		handleError({ error: err, event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toMatch(/^root cause/);
	});

	it('falls back to SvelteKit\'s message for an Error with an EMPTY message', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		handleError({ error: new Error(''), event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('Internal Error');
	});

	it('falls back to SvelteKit\'s message for a thrown non-Error', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		handleError({ error: 'a bare thrown string', event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('Internal Error');
	});

	it('keeps a NON-Error terminal cause — a string cause is often the true root', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		handleError({
			error: new Error('write failed', { cause: 'socket closed' }),
			event,
			status: 500,
			message: 'Internal Error'
		} as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('socket closed ← write failed');
	});

	it('a "←" inside a bound-params value cannot fake a chain separator', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/admin/images', db, waits);

		// The params tail carries a literal '←': segment normalization must strip
		// it so the params redaction can't stop early and leak the value's tail —
		// while the REAL ' ← wrapper' separator after it still survives.
		const drizzle = new Error(
			'Failed query: insert into "artists" ("name") values (?)\nparams: evil ← Jane Q. Artist'
		);
		handleError({
			error: new Error('Failed to save artist', { cause: drizzle }),
			event,
			status: 500,
			message: 'Internal Error'
		} as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('Jane');
		expect(row.message).toBe(
			'Failed query: insert into "artists" ("name") values (?) params: [redacted] ← Failed to save artist'
		);
	});

	it('redacts the bound params of a REAL DrizzleQueryError (upstream format canary)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/admin/images', db, waits);

		// The genuine drizzle-orm class, not a hand-built message: if an upgrade
		// changes the "…\nparams: …" message format, THIS test fails instead of
		// the params redaction silently no-longer matching in production.
		const err = new DrizzleQueryError(
			'insert into "artists" ("name") values (?)',
			['Jane Q. Artist'],
			new Error('D1_ERROR: UNIQUE constraint failed')
		);
		handleError({ error: err, event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('Jane');
		expect(row.message).toContain('params: [redacted]');
		expect(row.message).toMatch(/^D1_ERROR: UNIQUE constraint failed/);
	});

	it('a whitespace-only wrapper message leaves no dangling " ← " separator', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/stickers/pack/1', db, waits);

		// Error(' ') in the middle of a chain cleans to an empty segment, which
		// must be dropped — not stored as 'boom ←  ← outer'.
		const root = new Error('D1_ERROR: boom');
		const blank = new Error(' ', { cause: root });
		const outer = new Error('outer wrapper', { cause: blank });
		handleError({ error: outer, event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('D1_ERROR: boom ← outer wrapper');
	});

	it('records the DECODED route, matching authHandle, so one 5xx class never splits across two route strings', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/%61dmin/images', db, waits);

		handleError({ error: new Error('boom'), event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT route FROM error_sample').get().route).toBe('/admin/images');
	});

	it('falls back to the raw route when the pathname does not decode', async () => {
		// authHandle 400s a malformed pathname before resolve, so this can't
		// normally happen — but a decode throw inside handleError must not turn an
		// error REPORT into a second error.
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const event = metricsEvent('/%E0%A4%A', db, waits);

		handleError({ error: new Error('boom'), event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT route FROM error_sample').get().route).toBe('/%E0%A4%A');
	});

	it('does nothing for a sub-500 status', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const locals = {} as App.Locals;
		const event = metricsEvent('/gallery', db, waits, locals);

		handleError({ error: new Error('not found'), event, status: 404, message: 'Not Found' } as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
		expect(locals.errorSampled).toBeUndefined();
	});
});

// Tier-A page-view capture (issue #149). A header bag with a case-insensitive get,
// so a test can hand authHandle a User-Agent / Referer / CF-IPCountry without a real
// Request (which forbids setting some of these header names).
function headers(map: Record<string, string>) {
	return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

function pageviewEvent(
	pathname: string,
	db: D1Database,
	waits: Promise<unknown>[],
	hdrs: Record<string, string> = {},
	envExtra: Record<string, string> = { OBSERVABILITY_ENABLED: 'true' }
) {
	return {
		cookies: { get: () => undefined },
		url: new URL(`https://taro.surf${pathname}`),
		request: { headers: headers(hdrs) },
		locals: {} as App.Locals,
		platform: { env: { DB: db, ...envExtra }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
	} as never;
}

describe('authHandle — Tier-A page-view capture (issue #149)', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	const resolveHtml = async () =>
		new Response('<!doctype html>ok', { status: 200, headers: { 'content-type': 'text/html' } });
	const resolveXml = async () =>
		new Response('<rss/>', { status: 200, headers: { 'content-type': 'application/xml' } });

	const REAL_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148';

	it('records reduced counters for a public HTML view — referrer kept to host only', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, {
				'user-agent': REAL_UA,
				referer: 'https://t.co/xyz?utm=1&uid=personal',
				'cf-ipcountry': 'us'
			}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		const rows = sqlite.prepare('SELECT metric, dim, count FROM metric_rollup ORDER BY metric, dim').all();
		expect(rows).toEqual([
			{ metric: 'country', dim: 'US', count: 1 },
			{ metric: 'device', dim: 'mobile', count: 1 },
			{ metric: 'pageview', dim: '/gallery', count: 1 },
			{ metric: 'referrer', dim: 't.co', count: 1 }, // host only — the path+query are gone
			{ metric: 'request', dim: 'public', count: 1 }
		]);
	});

	it('stores the DECODED path as the pageview key for an encoded public URL', async () => {
		// The pageview dim is deliberately the decoded path (see the comment at the
		// pageViewStatements call site): '/tags/foo%20bar' and '/tags/foo bar' are
		// one page to Kit's router, so they must roll up as one counter row.
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/tags/foo%20bar', db, waits, {
				'user-agent': REAL_UA,
				'cf-ipcountry': 'US'
			}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		const rows = sqlite.prepare("SELECT dim FROM metric_rollup WHERE metric='pageview'").all();
		expect(rows).toEqual([{ dim: '/tags/foo bar' }]);
	});

	it('classifies an encoded admin path by its DECODED route class — no visitor page view', async () => {
		// routeClass and the pageview key read the decoded path (SONA-187). If a
		// regression fed them the raw pathname, an admin loading '/%61dmin/images'
		// would classify as 'public' and mint a visitor pageview row for an admin
		// page. An admin session is needed so the request survives the gate.
		const { db, sqlite } = makeMetricsDb();
		sqlite.exec(
			`CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);`
		);
		sqlite
			.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
			.run(
				await hashToken('some-token'),
				new Date().toISOString(),
				new Date(Date.now() + 3_600_000).toISOString()
			);
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: {
				cookies: { get: (name: string) => (name === SESSION_COOKIE ? 'some-token' : undefined) },
				url: new URL('https://taro.surf/%61dmin/images'),
				request: { headers: headers({ 'user-agent': REAL_UA, 'cf-ipcountry': 'US' }) },
				locals: {} as App.Locals,
				platform: {
					env: { DB: db, OBSERVABILITY_ENABLED: 'true' },
					context: { waitUntil: (p: Promise<unknown>) => waits.push(p) }
				}
			} as never,
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		const request = sqlite.prepare("SELECT dim FROM metric_rollup WHERE metric='request'").all();
		expect(request).toEqual([{ dim: 'admin' }]);
		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='pageview'").get().c).toBe(0);
	});

	it('does NOT count admin routes or cron endpoints as page views', async () => {
		// /admin/login is admin-class but reachable (exempt from the login redirect);
		// /api/cron/* is machine-to-machine and reaches resolve. Neither is a page view.
		for (const path of ['/admin/login', '/api/cron/refresh']) {
			const { db, sqlite } = makeMetricsDb();
			const waits: Promise<unknown>[] = [];
			await authHandle({
				event: pageviewEvent(path, db, waits, { 'user-agent': REAL_UA, 'cf-ipcountry': 'US' }),
				resolve: resolveHtml
			} as never);
			await Promise.all(waits);

			expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='pageview'").get().c, path).toBe(0);
			expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='device'").get().c, path).toBe(0);
		}
	});

	it('excludes known bots at capture time and stores no user-agent string', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, {
				'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
				'cf-ipcountry': 'US'
			}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		// The request is still counted, but NO visitor rows exist for the bot.
		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='request'").get().c).toBe(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric IN ('pageview','device','referrer','country')").get().c
		).toBe(0);
		// And nothing that looks like a UA was persisted anywhere.
		const dims = sqlite.prepare('SELECT dim FROM metric_rollup').all().map((r: { dim: string }) => r.dim);
		for (const d of dims) expect(d).not.toContain('Googlebot');
	});

	it('does not count a non-HTML public response (feeds, sitemaps)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/rss.xml', db, waits, { 'user-agent': REAL_UA }),
			resolve: resolveXml
		} as never);
		await Promise.all(waits);

		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='pageview'").get().c).toBe(0);
	});

	it('writes NOTHING when the observability flag is off (capture dormant)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, { 'user-agent': REAL_UA, 'cf-ipcountry': 'US' }, {}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT COUNT(*) c FROM metric_rollup').get().c).toBe(0);
	});
});

describe('authHandle — 5xx counts toward the error rate (issue #6)', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	const resolve500 = async () =>
		new Response('err', { status: 500, headers: { 'content-type': 'text/html' } });

	it('counts a request + error rollup and drops a generic sample for a deliberate 5xx', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// errorSampled unset: this 5xx never reached handleError (a deliberate error(500)).
		await authHandle({ event: metricsEvent('/gallery', db, waits), resolve: resolve500 } as never);
		await Promise.all(waits);

		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='request'").get().c).toBe(1);
		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='error'").get().c).toBe(1);
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: '/gallery', status: 500, message: 'HTTP 500' }]);
	});

	it('skips the generic sample when handleError already sampled this 5xx (no duplicate row)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// errorSampled preset: a thrown exception already logged the detailed row.
		await authHandle({ event: metricsEvent('/gallery', db, waits, { errorSampled: true, timeZone: 'UTC' }), resolve: resolve500 } as never);
		await Promise.all(waits);

		// Rollup still lands exactly once (rate stays correct)...
		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='error'").get().c).toBe(1);
		// ...but no generic fallback sample is added on top of the detailed one.
		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
	});

	it('writes NOTHING when the observability flag is off (feature dormant)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// Empty envExtra => OBSERVABILITY_ENABLED unset => feature disabled.
		await authHandle({ event: metricsEvent('/gallery', db, waits, { timeZone: 'UTC' }, {}), resolve: resolve500 } as never);
		await Promise.all(waits);

		// No request/error rollups and no error samples: the same 5xx that writes
		// rows when enabled must leave both tables empty when the flag is off.
		expect(sqlite.prepare('SELECT COUNT(*) c FROM metric_rollup').get().c).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
	});
});

describe('authHandle — cache-control stamping honors handler opt-outs (SONA-123)', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	it('stamps the public edge default on a public non-HTML 200 with no explicit header', async () => {
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/stickers/pack/7/download', db),
			resolve: async () => new Response('bytes', { headers: { 'content-type': 'image/webp' } })
		} as never)) as Response;
		expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
	});

	it('keeps a handler-set Cache-Control (the download fallback must stay no-store)', async () => {
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/stickers/pack/7/download', db),
			resolve: async () =>
				new Response('bytes', {
					headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store' }
				})
		} as never)) as Response;
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('keeps /img/[...key] on its immutable year-long cache (the other opt-out)', async () => {
		// UUID-keyed R2 objects never change, so the route sets its own immutable
		// header — the hooks stamp must not shorten it to the s-maxage default.
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/img/stickers/pack/key.webp', db),
			resolve: async () =>
				new Response('bytes', {
					headers: {
						'content-type': 'image/webp',
						'cache-control': 'public, max-age=31536000, immutable'
					}
				})
		} as never)) as Response;
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});

	it('keeps a handler-set Cache-Control on a 304 revalidation (not clobbered to no-store)', async () => {
		// A conditional GET that revalidates answers 304 with the same
		// Cache-Control as the 200 — the fallthrough stamp must not tell caches
		// to drop the object they just successfully revalidated.
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/img/stickers/pack/key.webp', db),
			resolve: async () =>
				new Response(null, {
					status: 304,
					headers: { 'cache-control': 'public, max-age=31536000, immutable' }
				})
		} as never)) as Response;
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});

	it('keeps a handler-set Cache-Control on a 206 partial response (ranged media)', async () => {
		// /img serves ranged video (SONA-124 showcase clips) as 206 with the same
		// immutable Cache-Control as the 200 — a seek must not become uncacheable.
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/img/vr-media/clip.webm', db),
			resolve: async () =>
				new Response('xx', {
					status: 206,
					headers: {
						'cache-control': 'public, max-age=31536000, immutable',
						'content-range': 'bytes 0-1/100'
					}
				})
		} as never)) as Response;
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});
});

describe('authHandle — security response headers', () => {
	beforeEach(() => {
		vi.mocked(getSetupState).mockResolvedValue('complete');
	});

	it('sets HSTS (and the existing hardening headers) on a public response', async () => {
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/gallery', db),
			resolve
		} as never)) as Response;

		// HSTS: one year, this host only. Neither directive is an oversight —
		// `includeSubDomains` would force HTTPS across an operator's whole personal
		// apex for a year (browser-cached, no server-side undo), and `preload` is
		// irreversible. Both are the operator's call at the edge, not ours.
		const hsts = res.headers.get('Strict-Transport-Security');
		expect(hsts).toBe('max-age=31536000');
		expect(hsts).not.toContain('includeSubDomains');
		expect(hsts).not.toContain('preload');
		expect(res.headers.get('X-Frame-Options')).toBe('DENY');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		// CSP is emitted by SvelteKit's kit.csp during page render, not this hook, so
		// it is asserted end-to-end in tests/e2e/csp-check.spec.ts, not here.
	});
});
