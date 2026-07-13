import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { setAdminPassword } from '$lib/server/admin-auth';
import { makeD1 } from '$lib/server/test/d1';
import { load, actions } from './+page.server';

// The load maps `?reset=1` (set by the /admin/reset redirect) to a success flag
// and surfaces the public Turnstile site key; an unauthenticated visit does no DB
// work.
function loadEvent(search: string, env: Record<string, unknown> = {}) {
	return {
		locals: {},
		url: new URL(`https://taro.surf/admin/login${search}`),
		platform: { env } as unknown
	} as never;
}

describe('login load', () => {
	it('maps ?reset=1 to { resetSuccess: true }', async () => {
		expect(await load(loadEvent('?reset=1'))).toEqual({ resetSuccess: true, turnstileSitekey: null });
	});

	it('is not a success without the reset flag', async () => {
		expect(await load(loadEvent(''))).toEqual({ resetSuccess: false, turnstileSitekey: null });
	});

	it('surfaces the configured Turnstile site key to the page', async () => {
		expect(await load(loadEvent('', { TURNSTILE_SITEKEY: 'sk-public' }))).toEqual({
			resetSuccess: false,
			turnstileSitekey: 'sk-public'
		});
	});
});

// --- login action: Turnstile enforcement ------------------------------------

const CORRECT = 'correct-horse-battery';
const WRONG = 'nope-nope-nope';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function makeDb(env: Record<string, unknown> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	const db = drizzle(d1, { schema });
	await setAdminPassword(db, CORRECT);
	const platform = { env: { DB: d1, ...env } } as unknown as App.Platform;
	return { platform };
}

let ipCounter = 0;
function loginEvent(platform: App.Platform, password: string, token?: string) {
	const body = new FormData();
	body.append('password', password);
	if (token !== undefined) body.append('cf-turnstile-response', token);
	// Unique IP per call so the per-isolate login throttle never bleeds across tests.
	const ip = `10.0.0.${++ipCounter}`;
	return {
		platform,
		getClientAddress: () => ip,
		cookies: { set: vi.fn() },
		request: new Request('https://taro.surf/admin/login', { method: 'POST', body })
	} as never;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// Enforcement is gated on BOTH keys, matching the widget-render condition, so the
// enforced-path tests configure both.
const BOTH = { TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'sk-public' };

describe('login action Turnstile enforcement', () => {
	it('configured + missing token → rejected without calling siteverify (fail closed)', async () => {
		const { platform } = await makeDb(BOTH);
		const result = (await actions.default(loginEvent(platform, CORRECT))) as {
			status: number;
			data: { error: string };
		};
		expect(result.status).toBe(403);
		expect(result.data.error).toMatch(/verification/i);
		// A missing token is rejected locally — no PBKDF2 and no siteverify round-trip.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('configured + valid token → proceeds to the password check', async () => {
		const { platform } = await makeDb(BOTH);
		// Valid token but WRONG password: a 401 (not 403) proves Turnstile passed and
		// the flow reached the password verify.
		const result = (await actions.default(loginEvent(platform, WRONG, 'tok-abc'))) as {
			status: number;
			data: { error: string };
		};
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(SITEVERIFY);
		expect(result.status).toBe(401);
		expect(result.data.error).toBe('Invalid password');
	});

	it('NOT configured → login proceeds without Turnstile', async () => {
		const { platform } = await makeDb(); // no TURNSTILE_SECRET
		const result = (await actions.default(loginEvent(platform, WRONG))) as {
			status: number;
			data: { error: string };
		};
		// Reaches the password check (401), and siteverify is never called.
		expect(result.status).toBe(401);
		expect(result.data.error).toBe('Invalid password');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('configured + siteverify fails → rejected (fail closed)', async () => {
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ success: false }), { status: 200 })
		);
		const { platform } = await makeDb(BOTH);
		const result = (await actions.default(loginEvent(platform, CORRECT, 'tok-bad'))) as {
			status: number;
			data: { error: string };
		};
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(403);
		expect(result.data.error).toMatch(/verification/i);
	});

	it('configured + siteverify fetch throws → rejected (fail closed, no 500)', async () => {
		// The siteverify request rejects (network error). The helper's catch must fail
		// closed → the action returns 403, never a pass and never an unhandled 500.
		fetchMock.mockRejectedValue(new Error('network down'));
		const { platform } = await makeDb(BOTH);
		const result = (await actions.default(loginEvent(platform, CORRECT, 'tok-x'))) as {
			status: number;
			data: { error: string };
		};
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(403);
		expect(result.data.error).toMatch(/verification/i);
	});

	it('secret set but sitekey unset → login proceeds without Turnstile (no lockout)', async () => {
		// Half-config: only the secret is set, so no widget renders. Enforcing here
		// would brick the admin, so the action must SKIP Turnstile and fall through to
		// the throttle+password path (reaches the password check, no siteverify call).
		const { platform } = await makeDb({ TURNSTILE_SECRET: 'ts-secret' });
		const result = (await actions.default(loginEvent(platform, WRONG))) as {
			status: number;
			data: { error: string };
		};
		expect(result.status).toBe(401);
		expect(result.data.error).toBe('Invalid password');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
