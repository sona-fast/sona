import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import {
	setRawSetting,
	getSupporterKeyStatus,
	clearSettingsCache,
	clearSupporterKeyStatusCache
} from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { APP_NAME } from '$lib/config';
import { load } from './+layout.server';

import { makeD1 } from '$lib/server/test/d1';

// Same arrangement as the settings page tests, via the shared factory:
// verification is stubbed (a passing token needs the sona.fast PRIVATE key),
// the resolver keeps the real shaping so the boundary logic is exercised.
// Crypto itself is covered in supporter-key.test.ts.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

// getSupporterKeyStatus is wrapped (default impl = the real one, so every other
// test is unaffected) so the D1-failure test below can make JUST the
// supporter-key read reject. mockReset() restores the wrapped original.
vi.mock('$lib/server/settings', async (importActual) => {
	const actual = await (importActual as () => Promise<typeof import('$lib/server/settings')>)();
	return { ...actual, getSupporterKeyStatus: vi.fn(actual.getSupporterKeyStatus) };
});

const DAY_MS = 86_400_000;

// The resolved status is memoized per isolate (SONA-118). Each test builds its
// own database, so the cache from the previous one would be a cross-test leak.
beforeEach(() => {
	clearSupporterKeyStatusCache();
});

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
	{ admin = true, cookie }: { admin?: boolean; cookie?: string } = {}
) {
	return {
		platform,
		locals: { admin },
		cookies: { get: (name: string) => (name === 'supporterNoticeDismissed' ? cookie : undefined) }
	} as never;
}

type NoticeResult = { supporterKeyNotice: { daysRemaining: number; dismissValue: string } | null };

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
			expiresAt: new Date(Date.now() + 40 * DAY_MS)
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
			expiresAt: new Date(Date.now() + 6.5 * DAY_MS)
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
		// Asserting on getSupporterKeyStatus, not just on the verify: a warm memo
		// would serve an anonymous request without verifying anything, so the verify
		// spy alone would no longer catch the gate coming off.
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockClear();
		vi.mocked(getSupporterKeyStatus).mockClear();

		const result = (await load(loadEvent(platform, { admin: false }))) as NoticeResult;

		expect(result.supporterKeyNotice).toBeNull();
		expect(getSupporterKeyStatus).not.toHaveBeenCalled();
		expect(verifySupporterKey).not.toHaveBeenCalled();
	});

	it('shares one resolution across admin requests instead of re-verifying (SONA-118)', async () => {
		// The point of the memo: the second admin page request in the same isolate
		// pays neither the key read nor the Ed25519 verify, and sees the same notice.
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockClear();
		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date(Date.now() + 6.5 * DAY_MS)
		});
		try {
			const first = (await load(loadEvent(platform))) as NoticeResult;
			const second = (await load(loadEvent(platform))) as NoticeResult;

			expect(second.supporterKeyNotice).toEqual(first.supporterKeyNotice);
			expect(verifySupporterKey).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(verifySupporterKey).mockReset();
		}
	});

	it('degrades only the notice when the supporter-key read itself fails', async () => {
		// getSupporterKeyStatus propagates D1 errors (getSettings self-catches) — a
		// transient failure on that one row must yield a null notice, never reject the
		// shared Promise.all and drop the whole layout to EMPTY (siteName, flags intact).
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'siteName', 'Sparky Site');
		clearSettingsCache();
		vi.mocked(getSupporterKeyStatus).mockRejectedValueOnce(new Error('D1 unavailable'));
		try {
			const result = (await load(loadEvent(platform))) as NoticeResult & Record<string, unknown>;

			expect(result.supporterKeyNotice).toBeNull();
			expect(result).toMatchObject({
				siteName: 'Sparky Site',
				registryEnabled: false,
				observabilityEnabled: false
			});
		} finally {
			// Restores the wrapped original implementation (and drains any unconsumed
			// once-rejection) for the other tests.
			vi.mocked(getSupporterKeyStatus).mockReset();
		}
	});
});

describe('admin layout load — cookie dismissal with phase re-warn (SONA-114)', () => {
	async function loadWithNotice(expiresAt: Date, cookie?: string) {
		// Each call is a fresh world (new database, new verification result), so it
		// must not inherit the status memoized by the previous one.
		clearSupporterKeyStatusCache();
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
		const expiresAt = new Date(Date.now() + 6.5 * DAY_MS);
		const first = await loadWithNotice(expiresAt);
		const dismissValue = first.supporterKeyNotice!.dismissValue;

		const second = await loadWithNotice(expiresAt, dismissValue);

		expect(second.supporterKeyNotice).toBeNull();
	});

	it('re-shows a notice dismissed in the early phase once the final days start', async () => {
		// Same key, now inside the final 3 days: its dismissValue carries ':final',
		// so a cookie recorded during the early phase no longer matches and the
		// notice comes back for the last-chance warning.
		const expiresAt = new Date(Date.now() + 2.5 * DAY_MS);
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
		const expiresAt = new Date(Date.now() + 6.5 * DAY_MS);
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
