import { describe, it, expect } from 'vitest';
import { supporterKeyValidUntil } from './supporter-key-expiry';
import {
	verifySupporterKey,
	supporterKeyStatusFromResult,
	resolveSupporterKeyStatus
} from './supporter-key';

// A test keypair minted in-test — NEVER the production private key (which lives
// only on sona.fast). The public half is passed through verify's override param.
async function makeIssuer() {
	const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const spki = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
	return { kp, spki };
}

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mint(
	privateKey: CryptoKey,
	payload: Record<string, unknown>
): Promise<string> {
	const seg = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = new Uint8Array(
		await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(seg))
	);
	return `${seg}.${b64url(sig)}`;
}

// End-of-day UTC exp seconds for a given date (start of the NEXT day UTC), so
// the key covers all of `dateStr`.
function expEndOfDay(dateStr: string): number {
	return Date.parse(`${dateStr}T00:00:00Z`) / 1000 + 86400;
}

const NOW = new Date('2026-08-15T12:00:00Z');

describe('verifySupporterKey', () => {
	it('accepts a well-formed, in-date key signed by the issuer', async () => {
		const { kp, spki } = await makeIssuer();
		const token = await mint(kp.privateKey, {
			v: 1,
			login: 'sparky',
			tier: 2,
			exp: expEndOfDay('2026-08-31')
		});

		const res = await verifySupporterKey(token, NOW, spki);

		expect(res).toMatchObject({ valid: true, login: 'sparky', tier: 2 });
		if (res.valid) {
			// The display date is the last covered day (exp - 1s, UTC), dotted.
			expect(supporterKeyValidUntil(res.expiresAt.getTime(), 'UTC')).toBe('2026.08.31');
		}
	});

	it('reports an expired key as invalid but still returns its payload', async () => {
		const { kp, spki } = await makeIssuer();
		const token = await mint(kp.privateKey, {
			v: 1,
			login: 'sparky',
			tier: 1,
			exp: expEndOfDay('2026-07-10')
		});

		const res = await verifySupporterKey(token, NOW, spki);

		expect(res).toMatchObject({ valid: false, reason: 'expired', login: 'sparky' });
		if (!res.valid && res.reason === 'expired') {
			expect(supporterKeyValidUntil(res.expiresAt.getTime(), 'UTC')).toBe('2026.07.10');
		}
	});

	it('rejects garbage / non-token input as malformed', async () => {
		const { spki } = await makeIssuer();
		for (const junk of ['', 'not-a-token', 'a.b.c', 'onlyonesegment', '.', 'abc.']) {
			const res = await verifySupporterKey(junk, NOW, spki);
			expect(res).toMatchObject({ valid: false });
			expect(res.valid).toBe(false);
		}
	});

	it('rejects a key signed by a different (wrong) key', async () => {
		const issuer = await makeIssuer();
		const attacker = await makeIssuer();
		// Signed by the attacker's key, verified against the issuer's public key.
		const token = await mint(attacker.kp.privateKey, {
			v: 1,
			login: 'sparky',
			tier: 2,
			exp: expEndOfDay('2026-08-31')
		});

		const res = await verifySupporterKey(token, NOW, issuer.spki);

		expect(res).toMatchObject({ valid: false, reason: 'bad-signature' });
	});

	it('rejects an unsupported payload version as malformed even if signed', async () => {
		const { kp, spki } = await makeIssuer();
		const token = await mint(kp.privateKey, {
			v: 2,
			login: 'sparky',
			tier: 2,
			exp: expEndOfDay('2026-08-31')
		});

		const res = await verifySupporterKey(token, NOW, spki);

		expect(res).toMatchObject({ valid: false, reason: 'malformed' });
	});

	it('accepts a key with whitespace/newlines injected by display wrapping', async () => {
		const { kp, spki } = await makeIssuer();
		const token = await mint(kp.privateKey, {
			v: 1,
			login: 'sparky',
			tier: 2,
			exp: expEndOfDay('2026-08-31')
		});
		// Simulate a copy-paste from the wrapped key record: spaces + newlines.
		const wrapped = token.slice(0, 20) + '\n' + token.slice(20, 40) + '  ' + token.slice(40);

		const res = await verifySupporterKey(wrapped, NOW, spki);

		expect(res).toMatchObject({ valid: true, login: 'sparky' });
	});

	it('verifies against the baked-in production key by default (no override)', async () => {
		// A random token can't be signed by the real (secret) issuer key, so the
		// default path must reject it — proves the default key is wired, not thrown.
		const res = await verifySupporterKey('abc.def', NOW);
		expect(res.valid).toBe(false);
	});

	// Key-rotation tripwire. This token was signed by the REAL production private
	// key (which lives only on sona.fast) and is verified here against the
	// baked-in PRODUCTION_PUBLIC_KEY_SPKI_B64 (no override). Reaching 'expired'
	// (not 'bad-signature') proves the signature validated against the baked key —
	// i.e. the baked public key still matches the deployed private key. If the two
	// ever diverge (rotation without updating the baked key, or vice versa), the
	// signature check fails first and this asserts 'bad-signature' instead.
	//
	// The token is exp 1752710400 (already in the past), so it unlocks nothing for
	// a freeloader — its only job is to bind the keypair. Minted once, offline,
	// with the private key; the private key is NOT in this repo.
	it('an expired token signed by the real key reaches expired against the baked key', async () => {
		const knownAnswer =
			'eyJ2IjoxLCJsb2dpbiI6Imtub3duLWFuc3dlciIsInRpZXIiOjgsImV4cCI6MTc1MjcxMDQwMH0.fr25p4GX1PXoTdqBTBTYQImZGdGKo13I5GDil_KXNi2dDVxBQaNiLQ5sGoVcapBmjPxV-0ADYAKCaFP-_CDTDA';
		const res = await verifySupporterKey(knownAnswer, new Date('2026-08-01T00:00:00Z'));
		expect(res).toMatchObject({ valid: false, reason: 'expired', login: 'known-answer' });
	});
});

describe('supporterKeyStatusFromResult', () => {
	const exp = new Date('2026-09-01T00:00:00Z');
	const base = { login: 'sparky', tier: 2, expiresAt: exp };

	it('marks a valid key inside the warning window as expiringSoon (and never carries the token)', () => {
		const status = supporterKeyStatusFromResult({ valid: true, ...base }, new Date('2026-08-25T00:00:00Z'), 'UTC');
		expect(status).toEqual({
			state: 'valid',
			validUntil: '2026.08.31',
			// UTC-pinned twin of validUntil; keys the dismissal cookie (SONA-119).
			dismissKey: '2026.08.31',
			// The other half of that cookie's value, counted in UTC for the same
			// reason — 7 days out is the early phase (final = last 3).
			dismissPhase: 'early',
			daysRemaining: 7,
			expiringSoon: true
		});
	});

	it('leaves a valid key outside the window unflagged', () => {
		const status = supporterKeyStatusFromResult({ valid: true, ...base }, new Date('2026-08-15T12:00:00Z'), 'UTC');
		expect(status).toMatchObject({ state: 'valid', daysRemaining: 17, expiringSoon: false });
	});

	it('maps expired to daysRemaining 0 and never expiringSoon', () => {
		const status = supporterKeyStatusFromResult(
			{ valid: false, reason: 'expired', ...base },
			new Date('2026-09-02T00:00:00Z'),
			'UTC'
		);
		expect(status).toMatchObject({ state: 'expired', validUntil: '2026.08.31', daysRemaining: 0, expiringSoon: false });
	});

	it('returns null for results with no trustworthy payload', () => {
		expect(supporterKeyStatusFromResult({ valid: false, reason: 'malformed' }, exp, 'UTC')).toBeNull();
		expect(supporterKeyStatusFromResult({ valid: false, reason: 'bad-signature' }, exp, 'UTC')).toBeNull();
	});
});

// The REAL resolver end to end (no mocks) — the loads' entry point. A passing
// token would need the sona.fast private key, so only the null paths are
// reachable here; the shaping of passing results is covered above.
describe('resolveSupporterKeyStatus (real, unmocked)', () => {
	it('resolves an empty token to null without touching crypto', async () => {
		expect(await resolveSupporterKeyStatus('', new Date(), 'UTC')).toBeNull();
	});

	it('resolves a garbage token to null (malformed falls through)', async () => {
		expect(await resolveSupporterKeyStatus('not-a-real-key', new Date(), 'UTC')).toBeNull();
	});
});
