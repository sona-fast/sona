import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vrTabEnabled, clearVrTabCache, vrPublishingEnabled } from './vr-gate';
import { clearSupporterKeyStatusCache } from './settings';
import { verifySupporterKey } from './supporter-key';
import { fakeKeyDb, throwingKeyDb } from './test/supporter-key-db';
import { EARLY_ACCESS } from '$lib/early-access';
import type { Database } from './db';

// A real supporter key can't be minted in tests (the issuer's private key never
// leaves sona.fast), so verification is stubbed; the gate logic on top of it,
// including the expiry comparison these tests turn on, stays real.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

// vrTabEnabled caches per-isolate with a short TTL (cachedProbe). The avatar
// write paths clear it in their own isolate; TTL expiry is what re-runs the
// probe everywhere else after the first avatar publishes — same pin as
// stickers.test.ts / collections.test.ts.

/** Query-counting fake of the Drizzle chain vrTabEnabled uses
 * (select→from→where→limit→get). */
function fakeProbeDb(row: { one: number } | undefined) {
	const calls = { count: 0 };
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => ({
						get: async () => {
							calls.count += 1;
							return row;
						}
					})
				})
			})
		})
	} as unknown as Database;
	return { db, calls };
}

describe('vrTabEnabled — cache TTL', () => {
	beforeEach(() => clearVrTabCache());
	afterEach(() => {
		vi.useRealTimers();
		clearVrTabCache();
	});

	it('re-queries after the TTL expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { db, calls } = fakeProbeDb({ one: 1 });

		expect(await vrTabEnabled(db)).toBe(true);
		expect(calls.count).toBe(1);

		// Still inside the 60s TTL → cache hit.
		vi.setSystemTime(59_000);
		await vrTabEnabled(db);
		expect(calls.count).toBe(1);

		// Past the TTL → fresh read. This is how OTHER isolates pick up a fork's
		// first published avatar (the writing isolate clears immediately).
		vi.setSystemTime(61_000);
		await vrTabEnabled(db);
		expect(calls.count).toBe(2);
	});

	it('clearVrTabCache forces a fresh read inside the TTL (the write-path hook)', async () => {
		const { db, calls } = fakeProbeDb({ one: 1 });
		expect(await vrTabEnabled(db)).toBe(true);
		expect(calls.count).toBe(1);

		clearVrTabCache();
		await vrTabEnabled(db);
		expect(calls.count).toBe(2);
	});
});

// vrPublishingEnabled is the ENFORCEMENT predicate — every mutating VR action
// and the model-upload endpoint refuse when it is false — and it now answers
// from a memo (SONA-118 extension). So these pin the two ways a memo can be
// wrong on an enforcement path: answering after the key it came from stopped
// working, and answering at all when something failed.
describe('vrPublishingEnabled — memoized entitlement', () => {
	const SHIPPED = { ...EARLY_ACCESS };
	const FUTURE_GA = '2999-01-01';
	const EXPIRES_AT = new Date('2026-09-01T00:00:00Z');

	beforeEach(() => {
		for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
		Object.assign(EARLY_ACCESS, SHIPPED);
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA; // pre-GA, so only a key can open it
		clearSupporterKeyStatusCache();
		vi.mocked(verifySupporterKey).mockReset();
	});
	afterEach(() => {
		for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
		Object.assign(EARLY_ACCESS, SHIPPED);
		clearSupporterKeyStatusCache();
	});

	function stubValidKey() {
		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: EXPIRES_AT
		});
	}

	it('opens the gate on a valid key and answers again without a second read or verify', async () => {
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');
		const now = new Date('2026-08-25T09:00:00Z');

		expect(await vrPublishingEnabled(db, undefined, now)).toBe(true);
		expect(await vrPublishingEnabled(db, undefined, now)).toBe(true);
		expect(state.reads).toBe(1);
		expect(verifySupporterKey).toHaveBeenCalledTimes(1);
	});

	it('denies once the key expires, on the very same cache entry', async () => {
		// The property that makes caching the pre-zone entitlement safe: only the
		// signature and the expiry instant are memoized, so the verdict is re-made
		// from `now` on every call. A cached BOOLEAN would still say yes here.
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');

		expect(await vrPublishingEnabled(db, undefined, new Date(EXPIRES_AT.getTime() - 1000))).toBe(true);
		expect(await vrPublishingEnabled(db, undefined, EXPIRES_AT)).toBe(false);
		expect(state.reads).toBe(1);
	});

	it('denies when the D1 read fails, warm cache or not', async () => {
		// Fail closed: an enforcement path that can't establish entitlement has not
		// established it. (Pre-GA — the GA branch opens the gate on its own date.)
		expect(await vrPublishingEnabled(throwingKeyDb(), undefined, new Date('2026-08-25T09:00:00Z'))).toBe(
			false
		);
	});

	it('denies when the verify itself throws', async () => {
		// The other half of fail-closed: not just a failed read, but a verifier that
		// blows up (bad key material, a WebCrypto that isn't there).
		vi.mocked(verifySupporterKey).mockRejectedValue(new Error('crypto unavailable'));
		const { db } = fakeKeyDb('head.tail');

		expect(await vrPublishingEnabled(db, undefined, new Date('2026-08-25T09:00:00Z'))).toBe(false);
	});

	it('denies on a token that does not verify', async () => {
		vi.mocked(verifySupporterKey).mockResolvedValue({ valid: false, reason: 'bad-signature' });
		const { db } = fakeKeyDb('forged.token');

		expect(await vrPublishingEnabled(db, undefined, new Date('2026-08-25T09:00:00Z'))).toBe(false);
	});

	it('shuts the gate in the same isolate the moment the key is removed', async () => {
		// What saveSupporterKey / removeSupporterKey rely on: they clear the memo,
		// so the operator's next request sees the new state rather than a TTL of the
		// old one.
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');
		const now = new Date('2026-08-25T09:00:00Z');
		expect(await vrPublishingEnabled(db, undefined, now)).toBe(true);

		state.value = null; // removeSupporterKey blanks the row…
		clearSupporterKeyStatusCache(); // …and clears the memo
		expect(await vrPublishingEnabled(db, undefined, now)).toBe(false);
	});

	it('opens the gate once the flag GAs without reading the key at all', async () => {
		// After GA the key cannot change the answer, so the enforcement path stops
		// touching D1 — otherwise every fork pays a read per VR request forever.
		EARLY_ACCESS['vr-avatars'] = '2000-01-01';
		const { db, state } = fakeKeyDb(null);

		expect(await vrPublishingEnabled(db, undefined, new Date('2026-08-25T09:00:00Z'))).toBe(true);
		expect(verifySupporterKey).not.toHaveBeenCalled();
		expect(state.reads).toBe(0);
	});
});
