import { vi } from 'vitest';
import type { SupporterKeyResult } from '$lib/server/supporter-key';

// Shared vi.mock factory body for '$lib/server/supporter-key', used by the
// settings page and admin layout server tests. Verification is stubbed (a
// passing token needs the sona.fast PRIVATE key, which tests can't have); the
// resolver keeps the real shaping so the boundary logic stays exercised, and a
// single mockResolvedValueOnce on verifySupporterKey drives actions and loads
// alike. The signature crypto itself is covered in supporter-key.test.ts.
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
		resolveSupporterKeyStatus: async (token: string, now: Date) =>
			token ? actual.supporterKeyStatusFromResult(await verifySupporterKey(token, now), now) : null
	};
}

/**
 * Shared vi.mock factory body for the VR gate suites: the literal token 'VALID'
 * verifies (far-future expiry), anything else is malformed. Same reason as
 * above — a token that really verifies needs the sona.fast private key — but
 * these suites drive the GATE rather than the status shaping, so they want a
 * pass/fail switch on the token value instead of a per-call stub.
 */
export async function supporterKeyLiteralMockModule(
	importOriginal: () => Promise<typeof import('$lib/server/supporter-key')>
) {
	const original = await importOriginal();
	return {
		...original,
		verifySupporterKey: vi.fn(
			async (token: string): Promise<SupporterKeyResult> =>
				token === 'VALID'
					? { valid: true, login: 'e2e', tier: 1, expiresAt: new Date('2999-01-01') }
					: { valid: false, reason: 'malformed' }
		)
	};
}
