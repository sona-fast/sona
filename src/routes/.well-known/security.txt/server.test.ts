import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GET } from './+server';

// The per-fork security.txt (SONA-171). The properties that matter: it points
// at the UPSTREAM private channels (never a public issue tracker, never the
// fork operator), Canonical follows the serving domain, and Expires is rolling
// so the file can never quietly go stale.

async function fetchTxt(origin = 'https://taro.surf') {
	const res = GET({ url: new URL(`${origin}/.well-known/security.txt`) } as never) as Response;
	return { res, body: await res.text() };
}

describe('/.well-known/security.txt', () => {
	it('serves an RFC 9116 file pointing at the upstream private channels', async () => {
		const { res, body } = await fetchTxt();

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(body).toContain('Contact: https://github.com/sona-fast/sona/security/advisories/new');
		expect(body).toContain('Contact: mailto:security@sona.fast');
		expect(body).toContain('Policy: https://github.com/sona-fast/sona/blob/main/SECURITY.md');
		// A public issue tracker in Contact would make a report a disclosure.
		expect(body).not.toContain('/issues');
	});

	it('claims the domain it is served from as Canonical', async () => {
		const { body } = await fetchTxt('https://rechner.solutions');
		expect(body).toContain('Canonical: https://rechner.solutions/.well-known/security.txt');
	});

	it('pins the Canonical scheme to https even on a plain-HTTP request', async () => {
		// RFC 9116 §3: the file must be served (and claimed) over https. An
		// origin-derived Canonical would echo http:// back here.
		const { body } = await fetchTxt('http://rechner.solutions');
		expect(body).toContain('Canonical: https://rechner.solutions/.well-known/security.txt');
	});

	it('points Policy at a file that actually exists in this repo', async () => {
		// The Policy URL 404s on every deployed fork if SECURITY.md moves or is
		// renamed, and nothing else would notice: URL-pinning tests keep passing.
		const { body } = await fetchTxt();
		const policyPath = body.match(/^Policy: .*\/blob\/main\/(.+)$/m)?.[1] ?? '';
		expect(policyPath).toBe('SECURITY.md');
		const repoRoot = new URL('../../../../SECURITY.md', import.meta.url);
		expect(readFileSync(repoRoot, 'utf8')).toContain('Reporting a vulnerability');
	});

	it('carries a rolling Expires in the future but under the RFC year cap', async () => {
		const { body } = await fetchTxt();
		const expires = body.match(/^Expires: (.+)$/m)?.[1] ?? '';
		const delta = new Date(expires).getTime() - Date.now();
		expect(delta).toBeGreaterThan(0);
		expect(delta).toBeLessThan(366 * 24 * 60 * 60 * 1000);
	});
});
