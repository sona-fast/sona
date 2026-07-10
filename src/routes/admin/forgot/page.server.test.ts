import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import { PASSWORD_RESET_SETTING } from '$lib/server/password-reset';
import { actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb(env: Record<string, unknown> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1, ...env } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

function forgotEvent(platform: App.Platform, email: string) {
	const body = new FormData();
	body.append('email', email);
	return {
		platform,
		url: new URL('https://taro.surf/admin/forgot'),
		request: new Request('https://taro.surf/admin/forgot', { method: 'POST', body })
	} as never;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function sentEmail(): { from: string; to: string; subject: string; html: string; text: string } {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(String(url)).toBe('https://api.resend.com/emails');
	return JSON.parse(init.body as string);
}

describe('forgot action', () => {
	it('mints a hashed token and sends the reset email when the email matches', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro Surf' });

		// Case-insensitive match still succeeds.
		const result = await actions.default(forgotEvent(platform, 'Admin@Taro.Surf'));

		expect(result).toEqual({ sent: true });
		const row = await getRawSetting(db, PASSWORD_RESET_SETTING);
		expect(row).toBeTruthy();
		const stored = JSON.parse(row!);
		// Only the hash is stored — never a raw token.
		expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(typeof stored.expiresAt).toBe('string');

		const email = sentEmail();
		expect(email.to).toBe('admin@taro.surf');
		expect(email.subject).toContain('Taro Surf');
		expect(email.text).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
		// From identifies the fork (its siteName), not Sona, when RESEND_FROM is unset.
		// The display name is a quoted-string (RFC 5322), so Resend accepts names
		// with commas/colons/quotes.
		expect(email.from).toBe('"Taro Surf" <onboarding@resend.dev>');
		// An HTML body ships alongside the text, carrying the fork identity + reset link.
		expect(email.html).toContain('Taro Surf');
		expect(email.html).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
	});

	it('quotes and escapes a siteName with a comma and double-quote in the From display name', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Aki, "The" Serval' });

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		const email = sentEmail();
		expect(email.from).toBe('"Aki, \\"The\\" Serval" <onboarding@resend.dev>');
	});

	it('HTML-escapes the siteName in the email body', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro & <Surf>' });

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const email = sentEmail();
		expect(email.html).toContain('Taro &amp; &lt;Surf&gt;');
		expect(email.html).not.toContain('<Surf>');
	});

	it('uses RESEND_FROM verbatim when set, overriding the fork-siteName default', async () => {
		const { db, platform } = makeDb({
			RESEND_API_KEY: 'rk_test',
			RESEND_FROM: 'Taro <noreply@taro.surf>'
		});
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro Surf' });

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const email = sentEmail();
		expect(email.from).toBe('Taro <noreply@taro.surf>');
	});

	it('strips CR/LF from the siteName in the From name and subject (header safety)', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Aki\nServal' });

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const email = sentEmail();
		expect(email.from).toBe('"Aki Serval" <onboarding@resend.dev>');
		expect(email.subject).toBe('Reset your Aki Serval admin password');
	});

	it('returns the same generic response and does nothing when the email does not match', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		const result = await actions.default(forgotEvent(platform, 'someone-else@example.com'));

		expect(result).toEqual({ sent: true });
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('no-ops (but still generic) when RESEND_API_KEY is unset', async () => {
		const { db, platform } = makeDb(); // no RESEND_API_KEY
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('skips the send within the 2-minute cooldown, keeping the existing token', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		// A fresh existing request (30s ago) should suppress a resend.
		const existing = JSON.stringify({
			tokenHash: 'a'.repeat(64),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			requestedAt: new Date(Date.now() - 30_000).toISOString()
		});
		await setRawSetting(db, PASSWORD_RESET_SETTING, existing);

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(fetchMock).not.toHaveBeenCalled();
		// The existing token row is left intact (link the operator may be following).
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBe(existing);
	});

	it('does not overwrite an existing valid token when the Resend send fails', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		// Outside the 2-minute cooldown, so this submission attempts a fresh send
		// rather than being suppressed — and that send is about to fail.
		const existing = JSON.stringify({
			tokenHash: 'a'.repeat(64),
			expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
			requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
		});
		await setRawSetting(db, PASSWORD_RESET_SETTING, existing);
		fetchMock.mockImplementation(async () => new Response('Internal error', { status: 500 }));

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// A failed send must not burn the prior valid link or start a new cooldown —
		// the operator couldn't have received a new link to use instead.
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBe(existing);
	});

	it('logs the Resend response body (not just the status) on a non-2xx response', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 422 })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('422'));
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('domain not verified'));
		errorSpy.mockRestore();
	});

	it('redacts an email address echoed in the Resend error body before logging it', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		fetchMock.mockImplementation(
			async () =>
				new Response(JSON.stringify({ message: 'admin@taro.surf is not a verified sender' }), { status: 403 })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		// Status + reason kept for diagnosis; the recovery address stripped (PII).
		expect(logged).toContain('403');
		expect(logged).toContain('[redacted]');
		expect(logged).not.toContain('admin@taro.surf');
		errorSpy.mockRestore();
	});

	it('strips other C0 control chars (not just CR/LF) from the siteName in the From name and subject', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Aki\x07Serval\x1f!' });

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const email = sentEmail();
		expect(email.from).toBe('"Aki Serval !" <onboarding@resend.dev>');
		expect(email.subject).toBe('Reset your Aki Serval ! admin password');
	});

	it('pins the reset link to the request origin', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		const email = sentEmail();
		expect(email.text).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
		expect(email.html).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
	});

	it('renders the reset email in the base locale (English)', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const email = sentEmail();
		expect(email.html).toContain('lang="en"');
	});

	it('defers the mint+send work via platform.ctx.waitUntil instead of awaiting it inline', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		// A real delay — long enough that it's still in flight once the action call
		// below has resolved, proving the response didn't wait on it.
		fetchMock.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
		});
		let captured: Promise<unknown> | undefined;
		const platformWithCtx = {
			...platform,
			ctx: { waitUntil: (p: Promise<unknown>) => (captured = p) }
		} as unknown as App.Platform;

		const result = await actions.default(forgotEvent(platformWithCtx, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(captured).toBeDefined();
		// The response returned before the deferred work (still delayed above) had
		// a chance to persist anything — a match and a non-match both return this
		// fast, which is the point (no timing oracle).
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();

		await captured;
		// Once the deferred work has actually run, the token is there.
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeTruthy();
	});

	it('redacts a reset-link token echoed in the Resend error body before logging it', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		fetchMock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ message: 'bad link https://taro.surf/admin/reset?token=SECRETTOKEN123 rejected' }),
					{ status: 422 }
				)
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		// Status + reason kept; the reset token stripped so it can't be replayed from logs.
		expect(logged).toContain('422');
		expect(logged).toContain('token=[redacted]');
		expect(logged).not.toContain('SECRETTOKEN123');
		errorSpy.mockRestore();
	});

	it('logs a deferred-task failure distinctly and still returns the generic response', async () => {
		// A DB that throws on use forces the deferred mint+send task to reject after
		// the response has already returned — the "2xx send then D1 write fails"
		// dead-link case the failure log exists to surface.
		const brokenDb = {
			prepare: () => {
				throw new Error('D1 unavailable');
			}
		};
		let captured: Promise<unknown> | undefined;
		const platform = {
			env: { DB: brokenDb, RESEND_API_KEY: 'rk_test' },
			ctx: { waitUntil: (p: Promise<unknown>) => (captured = p) }
		} as unknown as App.Platform;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		// Generic response regardless of the deferred failure (no enumeration).
		expect(result).toEqual({ sent: true });
		await captured; // let the deferred .catch run
		const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('password-reset deferred task failed:');
		expect(logged).toContain('D1 unavailable');
		errorSpy.mockRestore();
	});
});
