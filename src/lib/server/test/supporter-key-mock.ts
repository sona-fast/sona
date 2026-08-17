import { vi } from 'vitest';
import type { SupporterKeyResult } from '$lib/server/supporter-key';

// Two shared vi.mock factory bodies for '$lib/server/supporter-key'. Both exist
// because a token that really verifies needs the sona.fast PRIVATE key, which
// tests can't have; the signature crypto itself is covered for real in
// supporter-key.test.ts with an in-test keypair.
//
// This one leaves verification to a per-call stub — a single
// mockResolvedValueOnce drives actions and loads alike — and keeps the real
// resolver shaping, so the status boundary logic stays exercised. Reach for it
// when the test is about what a given verification RESULT produces.
export async function supporterKeyMockModule(
	importActual: () => Promise<typeof import('$lib/server/supporter-key')>
) {
	const actual = await importActual();
	// Default to a malformed result so a test that forgets mockResolvedValueOnce
	// fails on its own assertion instead of a TypeError inside the resolver.
	const verifySupporterKey = vi.fn(
		async (_token: string, _now: Date): Promise<SupporterKeyResult> => ({ valid: false, reason: 'malformed' })
	);
	return {
		...actual,
		verifySupporterKey,
		resolveSupporterKeyStatus: async (token: string, now: Date, timeZone: string) =>
			token
				? actual.supporterKeyStatusFromResult(await verifySupporterKey(token, now), now, timeZone)
				: null
	};
}

/**
 * The other one: a pass/fail switch on the token VALUE — the literal 'VALID'
 * verifies with a far-future expiry, anything else is malformed. Reach for it
 * when the test drives a gate across several fixtures and wants the stored row
 * to decide the outcome, rather than ordering per-call stubs.
 */
export async function supporterKeyLiteralMockModule(
	importOriginal: () => Promise<typeof import('$lib/server/supporter-key')>
) {
	const original = await importOriginal();
	const verifySupporterKey = vi.fn(
		async (token: string): Promise<SupporterKeyResult> =>
			token === 'VALID'
				? { valid: true, login: 'e2e', tier: 1, expiresAt: new Date('2999-01-01') }
				: { valid: false, reason: 'malformed' }
	);
	return {
		...original,
		verifySupporterKey,
		// Rewired like the helper above rather than left to the spread: the real
		// resolver calls the real verifier internally, so a spread copy would
		// answer from production crypto no matter what this factory says. Every
		// token fails that way, which is the shape a test passes vacuously in.
		resolveSupporterKeyStatus: async (token: string, now: Date, timeZone = 'UTC') =>
			token
				? original.supporterKeyStatusFromResult(await verifySupporterKey(token), now, timeZone)
				: null
	};
}
