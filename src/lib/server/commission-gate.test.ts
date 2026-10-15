import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { commissionLedgerEnabled, commissionLedgerGaDate, commissionGateView } from './commission-gate';
import { clearSupporterKeyStatusCache } from './settings';
import { verifySupporterKey } from './supporter-key';
import { fakeKeyDb, throwingKeyDb } from './test/supporter-key-db';
import { EARLY_ACCESS } from '$lib/early-access';

// A real supporter key can't be minted in tests (the issuer's private key never
// leaves sona.fast), so verification is stubbed; the gate logic on top of it,
// including the expiry comparison, stays real.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

const SHIPPED = { ...EARLY_ACCESS };
const label = () => 'Commission ledger';
const NOW = new Date('2026-10-20T09:00:00Z');
const EXPIRES_AT = new Date('2026-11-01T00:00:00Z');

function restore() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}

beforeEach(() => {
	restore();
	// Pre-GA, so only a key can open it.
	EARLY_ACCESS['commission-ledger'] = { gaDate: '2999-01-01', label };
	clearSupporterKeyStatusCache();
	vi.mocked(verifySupporterKey).mockReset();
});
afterEach(() => {
	restore();
	clearSupporterKeyStatusCache();
});

function stubValidKey() {
	vi.mocked(verifySupporterKey).mockResolvedValue({ valid: true, login: 'sparky', tier: 2, expiresAt: EXPIRES_AT });
}

describe('commissionLedgerEnabled', () => {
	it('stays closed before GA with no key stored', async () => {
		const { db } = fakeKeyDb(null);
		expect(await commissionLedgerEnabled(db, undefined, NOW)).toBe(false);
	});

	it('opens before GA for a valid key', async () => {
		stubValidKey();
		const { db } = fakeKeyDb('head.tail');
		expect(await commissionLedgerEnabled(db, undefined, NOW)).toBe(true);
	});

	it('closes once the key expires, on the same cached key', async () => {
		// Only the signature and the expiry instant are memoized, so the verdict is
		// made again from `now` on every call. A cached boolean would still say yes.
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');
		expect(await commissionLedgerEnabled(db, undefined, new Date(EXPIRES_AT.getTime() - 1000))).toBe(true);
		expect(await commissionLedgerEnabled(db, undefined, EXPIRES_AT)).toBe(false);
		expect(state.reads).toBe(1);
	});

	it('denies when the key read fails', async () => {
		expect(await commissionLedgerEnabled(throwingKeyDb(), undefined, NOW)).toBe(false);
	});

	it('denies when the verifier throws', async () => {
		vi.mocked(verifySupporterKey).mockRejectedValue(new Error('crypto unavailable'));
		const { db } = fakeKeyDb('head.tail');
		expect(await commissionLedgerEnabled(db, undefined, NOW)).toBe(false);
	});

	it('denies a key that does not verify', async () => {
		vi.mocked(verifySupporterKey).mockResolvedValue({ valid: false, reason: 'bad-signature' });
		const { db } = fakeKeyDb('forged.token');
		expect(await commissionLedgerEnabled(db, undefined, NOW)).toBe(false);
	});

	it('opens past GA without reading or verifying a key', async () => {
		EARLY_ACCESS['commission-ledger'] = { gaDate: '2000-01-01', label };
		const { db, state } = fakeKeyDb(null);
		expect(await commissionLedgerEnabled(db, undefined, NOW)).toBe(true);
		expect(state.reads).toBe(0);
		expect(verifySupporterKey).not.toHaveBeenCalled();
	});

	it('opens on the GA date itself, at midnight UTC', async () => {
		EARLY_ACCESS['commission-ledger'] = { gaDate: '2026-10-28', label };
		const { db } = fakeKeyDb(null);
		expect(await commissionLedgerEnabled(db, undefined, new Date('2026-10-27T23:59:59Z'))).toBe(false);
		expect(await commissionLedgerEnabled(db, undefined, new Date('2026-10-28T00:00:00Z'))).toBe(true);
	});

	it('ignores the e2e bypass outside dev builds', async () => {
		// The vitest stub for $app/environment reports dev=false, which is what a
		// production build compiles to. A var set on a production deployment must
		// not open the pre-GA gate. The e2e suite covers the dev-build side.
		const { db } = fakeKeyDb(null);
		const env = { E2E_COMMISSION_GATE: 'open' } as unknown as App.Platform['env'];
		expect(await commissionLedgerEnabled(db, env, NOW)).toBe(false);
	});
});

describe('commissionLedgerGaDate', () => {
	it('returns the GA date string, not the registry entry', () => {
		EARLY_ACCESS['commission-ledger'] = { gaDate: '2026-10-28', label };
		expect(commissionLedgerGaDate()).toBe('2026-10-28');
	});

	it('returns null once the entry retires', () => {
		delete EARLY_ACCESS['commission-ledger'];
		expect(commissionLedgerGaDate()).toBeNull();
	});
});

describe('commissionGateView', () => {
	it('formats the GA date the way the UI shows dates', async () => {
		EARLY_ACCESS['commission-ledger'] = { gaDate: '2026-10-28', label };
		const { db } = fakeKeyDb(null);
		expect(await commissionGateView(db, undefined, NOW)).toEqual({ open: false, gaDate: '2026.10.28' });
	});
});
