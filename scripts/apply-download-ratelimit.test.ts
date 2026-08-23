import { describe, it, expect } from 'vitest';
import type { CfApiResult } from './setup-lib.ts';
import { applyDownloadRateLimit } from './waf-lib.ts';
import { failureLines, TOKEN_RECIPE } from './apply-download-ratelimit.ts';

const SECRET = 'cf-secret-token-value-should-never-leak';
const ZONE = 'zone123';
const zonePath = 'GET /zones?name=akito.dog';
const entryPath = `GET /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`;
const zoneOk: CfApiResult = { ok: true, status: 200, result: [{ id: ZONE }] };

/** A cfApi stub answering from a path+method map; anything else is a 500. */
const fakeApi =
	(routes: Record<string, CfApiResult>) =>
	async (_token: string, path: string, init: { method?: string } = {}): Promise<CfApiResult> =>
		routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path] ?? { ok: false, status: 500 };

// The recipe is a fix for token scopes and nothing else. Printing it for a 500
// sends the operator to re-mint a token that was never the problem; withholding
// it on a 403 leaves them with no fix at all. Both directions are pinned against
// REAL results from the lib, not hand-built ones.
describe('failureLines — the token-recipe gate', () => {
	it('prints the token recipe when the API refused the call', async () => {
		const res = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({ [zonePath]: zoneOk, [entryPath]: { ok: false, status: 403 } })
		);
		const text = failureLines(res).join('\n');
		expect(text).toContain(res.detail);
		expect(text).toContain(TOKEN_RECIPE);
		expect(text).not.toContain('may not be a token-permission problem');
	});

	it('gives plain retry guidance, and no recipe, for a transient failure', async () => {
		const res = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({ [zonePath]: zoneOk, [entryPath]: { ok: false, status: 500 } })
		);
		const text = failureLines(res).join('\n');
		expect(text).toContain(res.detail);
		expect(text).toContain('This may not be a token-permission problem.');
		expect(text).not.toContain(TOKEN_RECIPE);
		expect(text).toContain('npm run apply-download-ratelimit -- <domain>');
	});
});
