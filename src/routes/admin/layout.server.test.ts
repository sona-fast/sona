import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { setRawSetting } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { load } from './+layout.server';

import { makeD1 } from '$lib/server/test/d1';

// Same arrangement as the settings page tests: verification is stubbed (a
// passing token needs the sona.fast PRIVATE key), the resolver keeps the real
// shaping so the boundary logic is exercised. Crypto itself is covered in
// supporter-key.test.ts.
vi.mock('$lib/server/supporter-key', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/supporter-key')>();
	const verifySupporterKey = vi.fn();
	return {
		...actual,
		verifySupporterKey,
		resolveSupporterKeyStatus: async (token: string, now: Date) =>
			token ? actual.supporterKeyStatusFromResult(token, await verifySupporterKey(token, now), now) : null
	};
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

describe('admin layout load — supporter-key expiry notice (SONA-114)', () => {
	it('is null with no stored key', async () => {
		const { platform } = makeLoadDb();

		const result = (await load({ platform } as never)) as { supporterKeyNotice: unknown };

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

		const result = (await load({ platform } as never)) as { supporterKeyNotice: unknown };

		expect(result.supporterKeyNotice).toBeNull();
	});

	it('surfaces days remaining inside the window and keeps the token out of the payload', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date(Date.now() + 6.5 * DAY_MS)
		});

		const result = (await load({ platform } as never)) as {
			supporterKeyNotice: { daysRemaining: number; validUntil: string } | null;
		};

		expect(result.supporterKeyNotice).toMatchObject({ daysRemaining: 7 });
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

		const result = (await load({ platform } as never)) as { supporterKeyNotice: unknown };

		expect(result.supporterKeyNotice).toBeNull();
	});
});
