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
		resolveSupporterKeyStatus: async (token: string, now: Date, timeZone: string) =>
			token
				? actual.supporterKeyStatusFromResult(await verifySupporterKey(token, now), now, timeZone)
				: null
	};
}
