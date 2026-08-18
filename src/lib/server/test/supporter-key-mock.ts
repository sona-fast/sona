import { vi } from 'vitest';
import type { SupporterKeyResult } from '$lib/server/supporter-key';

// Shared vi.mock factory body for '$lib/server/supporter-key'. It exists
// because a token that really verifies needs the sona.fast PRIVATE key, which
// tests can't have; the signature crypto itself is covered for real in
// supporter-key.test.ts with an in-test keypair.
//
// It leaves verification to a per-call stub — a single
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
