import { describe, it, expect } from 'vitest';
import { verifySupporterKey, supporterKeyDisplayDate } from './supporter-key';

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
			expect(supporterKeyDisplayDate(res.expiresAt)).toBe('2026.08.31');
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
			expect(supporterKeyDisplayDate(res.expiresAt)).toBe('2026.07.10');
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
});
