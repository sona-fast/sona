import { describe, it, expect, vi } from 'vitest';
import { verifySupporterKey, resolveSupporterKeyStatus } from '$lib/server/supporter-key';

// The helper under test IS the mock, so this file installs it the way the VR
// suites do and checks the contract those suites rely on. Worth its own file:
// a helper that quietly falls through to the real module doesn't fail, it makes
// every token look malformed — which reads as a passing gate test.
vi.mock('$lib/server/supporter-key', async (importOriginal) =>
	(await import('./supporter-key-mock')).supporterKeyLiteralMockModule(
		importOriginal as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

describe('supporterKeyLiteralMockModule', () => {
	const now = new Date('2026-08-25T09:00:00Z');

	it('switches verification on the literal token', async () => {
		expect(await verifySupporterKey('VALID', now)).toMatchObject({ valid: true });
		expect(await verifySupporterKey('anything-else', now)).toMatchObject({
			valid: false,
			reason: 'malformed'
		});
	});

	it('resolves status through the SAME stub, not the real verifier', async () => {
		// The spread alone would hand back the real resolver, which calls the real
		// verifier internally — 'VALID' is not a signed token, so it would resolve
		// to null here and a consumer would never know its switch was ignored.
		expect(await resolveSupporterKeyStatus('VALID', now, 'UTC')).toMatchObject({ state: 'valid' });
		expect(await resolveSupporterKeyStatus('anything-else', now, 'UTC')).toBeNull();
		expect(await resolveSupporterKeyStatus('', now, 'UTC')).toBeNull();
	});
});
