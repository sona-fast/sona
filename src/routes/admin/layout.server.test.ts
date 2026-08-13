import { describe, it, expect, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { setRawSetting, getRawSetting, clearSettingsCache } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { APP_NAME } from '$lib/config';
import { load } from './+layout.server';

import { makeD1 } from '$lib/server/test/d1';
import { expInDays } from '$lib/server/test/exp-in-days';

// Same arrangement as the settings page tests, via the shared factory:
// verification is stubbed (a passing token needs the sona.fast PRIVATE key),
// the resolver keeps the real shaping so the boundary logic is exercised.
// Crypto itself is covered in supporter-key.test.ts.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

// getRawSetting is wrapped (default impl = the real one, so every other test is
// unaffected) so the D1-failure test below can make JUST the supporter-key read
// reject. mockReset() restores the wrapped original.
vi.mock('$lib/server/settings', async (importActual) => {
	const actual = await (importActual as () => Promise<typeof import('$lib/server/settings')>)();
	return { ...actual, getRawSetting: vi.fn(actual.getRawSetting) };
});

const DAY_MS = 86_400_000;

function makeLoadDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1 } } as unknown as App.Platform
	};
}

// The load reads locals.admin (set by hooks.server.ts) and the dismissal cookie.
function loadEvent(
	platform: App.Platform | undefined,
	{ admin = true, cookie, tz }: { admin?: boolean; cookie?: string; tz?: string } = {}
) {
	return {
		platform,
		// timeZone is resolved in hooks (SONA-119), so the load reads it off locals
		// rather than the cookie; 'UTC' is what an absent/unusable cookie yields.
		locals: { admin, timeZone: tz ?? 'UTC' },
		cookies: { get: (name: string) => (name === 'supporterNoticeDismissed' ? cookie : undefined) }
	} as never;
}

type NoticeResult = { supporterKeyNotice: { daysRemaining: number; dismissValue: string } | null };

async function loadWithZone(expiresAt: Date, tz?: string) {
	const { db, platform } = makeLoadDb();
	await setRawSetting(db, 'supporterKey', 'head.tail');
	vi.mocked(verifySupporterKey).mockResolvedValueOnce({
		valid: true,
		login: 'sparky',
		tier: 2,
		expiresAt
	});
	return (await load(loadEvent(platform, { tz }))) as NoticeResult;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('admin layout load — supporter-key expiry notice (SONA-114)', () => {
	it('is null with no stored key', async () => {
		const { platform } = makeLoadDb();

		const result = (await load(loadEvent(platform))) as NoticeResult;

		expect(result.supporterKeyNotice).toBeNull();
	});

	it('is null while the key is outside the warning window', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: expInDays(40)
		});

		const result = (await load(loadEvent(platform))) as NoticeResult;

		expect(result.supporterKeyNotice).toBeNull();
	});

	it('surfaces days remaining inside the window and keeps the token out of the payload', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'siteName', 'Sparky Site');
		clearSettingsCache();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: expInDays(7)
		});

		const result = (await load(loadEvent(platform))) as NoticeResult & Record<string, unknown>;

		expect(result.supporterKeyNotice).toMatchObject({ daysRemaining: 7 });
		// The successful load carries the real chrome fields, not EMPTY fallbacks.
		expect(result).toMatchObject({
			siteName: 'Sparky Site',
			registryEnabled: false,
			observabilityEnabled: false
		});
		// 7 days out is the early phase (final = last 3 days).
		expect(result.supporterKeyNotice?.dismissValue).toMatch(/^\d{4}\.\d{2}\.\d{2}:early$/);
		// The layout payload rides along on every admin page — the token must not.
		expect(JSON.stringify(result)).not.toContain('head.tail');
	});

	// SONA-119: the operator's zone reaches the load through the tz cookie, and
	// BOTH the date and the count are read in it. Computing them in the browser
	// instead would make SSR print the UTC answer and hydration overwrite it.
	it('reads the expiry date and the countdown in the tz cookie zone', async () => {
		// Pinned clock: the load reads new Date(), and whether Tokyo is already on
		// the next UTC calendar day is exactly what decides the numbers below. At
		// 12:00 UTC it is not (21:00 JST, same date), so the offset is the key's
		// own — from 15:00 UTC the two zones would agree and this would fail.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-13T12:00:00Z'));
		// exp = midnight UTC, so its last covered instant (23:59:59Z) is already
		// the next calendar day anywhere east of UTC. Five days out so both zones
		// sit inside the warn window (which is itself now judged in that zone).
		const expiresAt = new Date('2026-08-18T00:00:00Z');
		const utc = await loadWithZone(expiresAt);
		const tokyo = await loadWithZone(expiresAt, 'Asia/Tokyo');

		// Tokyo's last covered day is one calendar day further out than UTC's, and
		// the displayed count moves with the displayed date.
		expect(utc.supporterKeyNotice?.daysRemaining).toBe(5);
		expect(tokyo.supporterKeyNotice?.daysRemaining).toBe(6);
		// The dismissal key does NOT move with the zone: it is UTC-pinned, so a
		// notice dismissed before the tz cookie arrived (or before the operator
		// travelled) stays dismissed rather than springing back.
		expect(tokyo.supporterKeyNotice?.dismissValue).toBe(utc.supporterKeyNotice?.dismissValue);
	});

	it('keeps the dismissal value zone-free across the early/final phase boundary', async () => {
		// The phase boundary, not just the date: the previous version appended a
		// phase counted in the VIEWER's zone to a UTC-pinned key, so the two halves
		// could disagree and a dismissal made in one zone stopped matching in the
		// other. The zone test above never caught it — days 5 and 6 are both 'early',
		// so its two dismissValues coincided for the wrong reason.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-29T15:00:00Z'));
		// Straddles EXPIRY_FINAL_DAYS (3): UTC counts 3 ('final'), London — one hour
		// ahead, so its "now" is still the 29th while its last covered day is the
		// 1st — counts 4 ('early').
		const expiresAt = new Date('2026-09-01T00:00:00Z');
		const utc = await loadWithZone(expiresAt);
		const london = await loadWithZone(expiresAt, 'Europe/London');

		// The displayed countdown still moves with the viewer's zone...
		expect(utc.supporterKeyNotice?.daysRemaining).toBe(3);
		expect(london.supporterKeyNotice?.daysRemaining).toBe(4);
		// ...but the dismissal value, phase included, does not.
		expect(london.supporterKeyNotice?.dismissValue).toBe(utc.supporterKeyNotice?.dismissValue);
		expect(utc.supporterKeyNotice?.dismissValue).toBe('2026.08.31:final');
	});

	it('is null for an expired key (the settings page owns that state)', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'old.token');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: false,
			reason: 'expired',
			login: 'sparky',
			tier: 1,
			expiresAt: new Date(Date.now() - DAY_MS)
		});

		const result = (await load(loadEvent(platform))) as NoticeResult;

		expect(result.supporterKeyNotice).toBeNull();
	});

	it('is null for an unauthenticated request even with a near-expiry key stored', async () => {
		// The layout load also runs for the auth-exempt routes (/admin/login etc.):
		// no session means no D1 key read, no Ed25519 verify, no notice metadata.
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockClear();

		const result = (await load(loadEvent(platform, { admin: false }))) as NoticeResult;

		expect(result.supporterKeyNotice).toBeNull();
		expect(verifySupporterKey).not.toHaveBeenCalled();
	});

	it('degrades only the notice when the supporter-key read itself fails', async () => {
		// getRawSetting propagates D1 errors (getSettings self-catches) — a transient
		// failure on that one row must yield a null notice, never reject the shared
		// Promise.all and drop the whole layout to EMPTY (siteName, flags intact).
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'siteName', 'Sparky Site');
		clearSettingsCache();
		const real = vi.mocked(getRawSetting).getMockImplementation()!;
		vi.mocked(getRawSetting).mockImplementation(async (dbArg, key) => {
			if (key === 'supporterKey') throw new Error('D1 unavailable');
			return real(dbArg, key);
		});
		try {
			const result = (await load(loadEvent(platform))) as NoticeResult & Record<string, unknown>;

			expect(result.supporterKeyNotice).toBeNull();
			expect(result).toMatchObject({
				siteName: 'Sparky Site',
				registryEnabled: false,
				observabilityEnabled: false
			});
		} finally {
			// Restores the wrapped original implementation for the other tests.
			vi.mocked(getRawSetting).mockReset();
		}
	});
});

describe('admin layout load — cookie dismissal with phase re-warn (SONA-114)', () => {
	async function loadWithNotice(expiresAt: Date, cookie?: string) {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt
		});
		return (await load(loadEvent(platform, { cookie }))) as NoticeResult;
	}

	it('suppresses the notice when the cookie matches the current key + phase', async () => {
		// First load learns the dismissValue; a second load of the SAME key with it
		// as the cookie (same phase) renders no notice.
		const expiresAt = expInDays(7);
		const first = await loadWithNotice(expiresAt);
		const dismissValue = first.supporterKeyNotice!.dismissValue;

		const second = await loadWithNotice(expiresAt, dismissValue);

		expect(second.supporterKeyNotice).toBeNull();
	});

	it('re-shows a notice dismissed in the early phase once the final days start', async () => {
		// Same key, now inside the final 3 days: its dismissValue carries ':final',
		// so a cookie recorded during the early phase no longer matches and the
		// notice comes back for the last-chance warning.
		const expiresAt = expInDays(3);
		const first = await loadWithNotice(expiresAt);
		const finalDismiss = first.supporterKeyNotice!.dismissValue;
		expect(finalDismiss).toMatch(/:final$/);
		const earlyCookie = finalDismiss.replace(/:final$/, ':early');

		const result = await loadWithNotice(expiresAt, earlyCookie);

		expect(result.supporterKeyNotice).not.toBeNull();
	});

	it("a 'final' dismissal also suppresses the early phase (phase order, not string equality)", async () => {
		// Phases are ordered: a final-phase dismissal covers the whole warning
		// window for that validUntil, so a request landing a phase earlier (clock
		// skew, stale edge cache) must not resurrect an already-dismissed notice.
		const expiresAt = expInDays(7);
		const first = await loadWithNotice(expiresAt);
		const earlyDismiss = first.supporterKeyNotice!.dismissValue;
		expect(earlyDismiss).toMatch(/:early$/);
		const finalCookie = earlyDismiss.replace(/:early$/, ':final');

		const result = await loadWithNotice(expiresAt, finalCookie);

		expect(result.supporterKeyNotice).toBeNull();
	});
});

describe('admin layout load — fallback to EMPTY', () => {
	// Mirrors the load's EMPTY constant — the full shape, so a fallback can never
	// silently drop or grow a field without this test noticing.
	const EMPTY_SHAPE = {
		adminAvatarUrl: null,
		siteName: APP_NAME,
		ownerName: '',
		registryEnabled: false,
		observabilityEnabled: false,
		supporterKeyNotice: null
	};

	it('returns the full EMPTY shape when the platform has no DB binding', async () => {
		const result = await load(loadEvent(undefined));

		expect(result).toEqual(EMPTY_SHAPE);
	});

	it('returns the full EMPTY shape when the settings reads throw (missing table)', async () => {
		// No site_settings table at all: the registry read throws and the load's
		// catch falls back to EMPTY. (getSettings self-catches to defaults, and the
		// guarded supporter-key read degrades to null on its own.)
		const sqlite = new Database(':memory:');
		const platform = { env: { DB: makeD1(sqlite) } } as unknown as App.Platform;
		clearSettingsCache();

		const result = await load(loadEvent(platform));

		expect(result).toEqual(EMPTY_SHAPE);
	});
});
