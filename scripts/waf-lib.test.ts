import { describe, it, expect } from 'vitest';
import type { CfApiResult } from './setup-lib.ts';
import {
	applyDownloadRateLimit,
	buildRule,
	isPermissionError,
	SCOPE_HINT as WAF_SCOPE_HINT,
	RULE_REF,
	RULE_DESCRIPTION,
	RULE_EXPRESSION,
	RULE_RATELIMIT
} from './waf-lib.ts';

const SECRET = 'cf-secret-token-value-should-never-leak';

interface Call {
	token: string;
	path: string;
	method: string;
	body?: unknown;
}

/**
 * Builds a fake `cfApi` that never touches the network: it records every call and
 * answers from a path+method → result map. Any path not in the map returns a 500,
 * which surfaces as an unexpected-call failure in assertions.
 */
function fakeApi(routes: Record<string, CfApiResult>) {
	const calls: Call[] = [];
	const api = async (
		token: string,
		path: string,
		init: { method?: string; body?: unknown } = {}
	): Promise<CfApiResult> => {
		const method = init.method ?? 'GET';
		calls.push({ token, path, method, body: init.body });
		return routes[`${method} ${path}`] ?? routes[path] ?? { ok: false, status: 500 };
	};
	return { api, calls };
}

const ZONE = 'zone123';
const RULESET = 'ruleset456';
const zonePath = 'GET /zones?name=akito.dog';
const entryPath = `GET /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`;
const putEntryPath = `PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`;
const zoneOk: CfApiResult = { ok: true, status: 200, result: [{ id: ZONE }] };

describe('buildRule', () => {
	it('encodes the beacon expression, block action, ref, and rate-limit knobs', () => {
		const rule = buildRule();
		expect(rule.action).toBe('block');
		expect(rule.expression).toBe(RULE_EXPRESSION);
		expect(rule.ref).toBe(RULE_REF);
		expect(rule.description).toBe(RULE_DESCRIPTION);
		// Free requires a 10s period and a mitigation timeout equal to it (and one
		// rule per zone — see RULE_EXPRESSION); cf.colo.id is required outside
		// Enterprise. Drifting from any of these makes the rule unappliable. The
		// beacon threshold is unchanged now that oEmbed shares the rule.
		expect(rule.ratelimit).toEqual({
			characteristics: ['ip.src', 'cf.colo.id'],
			period: 10,
			requests_per_period: 20,
			mitigation_timeout: 10
		});
	});

	it('targets exactly the two gate-exempt public paths, in one rule', () => {
		// One rule for the reason documented on RULE_EXPRESSION (Free plan). Each
		// clause is method-scoped so the rule can't be tripped by a verb the app
		// doesn't serve — and /api/oembed lists HEAD as well as GET, because
		// SvelteKit runs its GET handler for HEAD (same two D1 reads).
		expect(RULE_EXPRESSION).toBe(
			'((http.request.method eq "POST" and http.request.uri.path eq "/api/metrics/download") or ((http.request.method eq "GET" or http.request.method eq "HEAD") and http.request.uri.path eq "/api/oembed"))'
		);
	});
});

describe('applyDownloadRateLimit — zone resolves, rule created', () => {
	it('creates the entrypoint ruleset when none exists yet (PUT payload asserted)', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			// No http_ratelimit ruleset on the zone yet.
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('created');

		const put = calls.find((c) => c.method === 'PUT');
		expect(put?.path).toBe(`/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`);
		const rules = (put?.body as { rules: Record<string, unknown>[] }).rules;
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({
			action: 'block',
			expression: RULE_EXPRESSION,
			ref: RULE_REF,
			ratelimit: RULE_RATELIMIT
		});
	});

	it('appends only our rule when a ruleset already exists (POST add-rule, others untouched)', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: {
				ok: true,
				status: 200,
				result: { id: RULESET, rules: [{ id: 'other', ref: 'someone_elses_rule' }] }
			},
			[`POST /zones/${ZONE}/rulesets/${RULESET}/rules`]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('created');

		const post = calls.find((c) => c.method === 'POST');
		// Adds a single rule to the existing ruleset — no PUT that would rewrite the set.
		expect(post?.path).toBe(`/zones/${ZONE}/rulesets/${RULESET}/rules`);
		expect(post?.body).toMatchObject({ ref: RULE_REF, action: 'block' });
		expect(calls.some((c) => c.method === 'PUT')).toBe(false);
	});
});

describe('applyDownloadRateLimit — idempotent no-op', () => {
	it('returns exists and writes nothing when our rule is already present and identical', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: {
				ok: true,
				status: 200,
				result: {
					id: RULESET,
					rules: [
						{
							id: 'mine',
							ref: RULE_REF,
							description: RULE_DESCRIPTION,
							action: 'block',
							enabled: true,
							expression: RULE_EXPRESSION,
							ratelimit: { ...RULE_RATELIMIT }
						}
					]
				}
			}
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('exists');
		// Only the two GETs happened — no POST/PUT/PATCH mutation.
		expect(calls.every((c) => c.method === 'GET')).toBe(true);
	});

	it('updates in place (PATCH by rule id) when our rule exists but params changed', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: {
				ok: true,
				status: 200,
				result: {
					id: RULESET,
					rules: [
						{
							id: 'mine',
							ref: RULE_REF,
							description: RULE_DESCRIPTION,
							action: 'block',
							enabled: true,
							expression: RULE_EXPRESSION,
							// Stale threshold from an earlier version — should be updated, not duplicated.
							ratelimit: { characteristics: ['ip.src'], period: 10, requests_per_period: 5, mitigation_timeout: 60 }
						}
					]
				}
			},
			[`PATCH /zones/${ZONE}/rulesets/${RULESET}/rules/mine`]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('updated');
		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.path).toBe(`/zones/${ZONE}/rulesets/${RULESET}/rules/mine`);
		expect(patch?.body).toMatchObject({ ratelimit: RULE_RATELIMIT });
		// No duplicate append.
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('migrates the download-only rule the deployed forks actually hold', async () => {
		// This is the shape on all six live forks: our `ref`, current rate-limit
		// params, but the pre-SONA-168 download-only expression (written literally so
		// the test still describes production even after RULE_EXPRESSION changes).
		const deployedRule = {
			id: 'mine',
			ref: RULE_REF,
			description: RULE_DESCRIPTION,
			action: 'block',
			enabled: true,
			expression:
				'(http.request.method eq "POST" and http.request.uri.path eq "/api/metrics/download")',
			ratelimit: { ...RULE_RATELIMIT }
		};
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: true, status: 200, result: { id: RULESET, rules: [deployedRule] } },
			[`PATCH /zones/${ZONE}/rulesets/${RULESET}/rules/mine`]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('updated');

		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.path).toBe(`/zones/${ZONE}/rulesets/${RULESET}/rules/mine`);
		expect((patch?.body as { expression: string }).expression).toBe(RULE_EXPRESSION);

		// And the patched shape is what a re-run recognises: the migration converges.
		const patched = { ...deployedRule, ...(patch?.body as Record<string, unknown>) };
		const rerun = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: true, status: 200, result: { id: RULESET, rules: [patched] } }
		});
		expect((await applyDownloadRateLimit(SECRET, 'akito.dog', rerun.api)).status).toBe('exists');
	});
});

describe('applyDownloadRateLimit — subdomain host resolves via the registrable zone', () => {
	it('strips leading labels until a zone matches (sub.example.com → example.com)', async () => {
		const { api, calls } = fakeApi({
			// Exact-name lookup for the subdomain finds nothing (Cloudflare only
			// registers the registrable zone), so it must fall back to example.com.
			'GET /zones?name=sub.example.com': { ok: true, status: 200, result: [] },
			'GET /zones?name=example.com': zoneOk,
			[entryPath]: { ok: true, status: 200, result: { id: RULESET, rules: [] } },
			[`POST /zones/${ZONE}/rulesets/${RULESET}/rules`]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'sub.example.com', api);
		expect(res.status).toBe('created');
		// Tried the subdomain first, then the registrable zone.
		const zoneQueries = calls.filter((c) => c.path.startsWith('/zones?name='));
		expect(zoneQueries.map((c) => c.path)).toEqual([
			'/zones?name=sub.example.com',
			'/zones?name=example.com'
		]);
	});
});

describe('applyDownloadRateLimit — clear errors, no mutation', () => {
	it('token has no access to the zone (empty result) → error naming WAF scope, no ruleset touched', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: { ok: true, status: 200, result: [] }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('no access to the akito.dog zone');
		expect(res.detail).toContain('WAF: Edit');
		// Never proceeded to the ruleset endpoint.
		expect(calls).toHaveLength(1);
	});

	it('skips the zone lookup entirely when the caller provides a resolved zone id', async () => {
		const { api, calls } = fakeApi({
			[entryPath]: { ok: true, status: 200, result: { id: RULESET, rules: [] } },
			[`POST /zones/${ZONE}/rulesets/${RULESET}/rules`]: { ok: true, status: 200 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api, ZONE);
		expect(res.status).toBe('created');
		// The setup CLI passes its preflight's zone id — no /zones?name= round trip.
		expect(calls.some((c) => c.path.startsWith('/zones?name='))).toBe(false);
	});

	it('a transient failure mid-walk aborts — never falls through to the parent zone', async () => {
		const { api, calls } = fakeApi({
			'/zones?name=sub.example.com': { ok: false, status: 500 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'sub.example.com', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 500');
		// A 500 is not a permission problem — no scope advice on this branch.
		expect(res.detail).not.toContain('token needs');
		// The walk stopped at the failing candidate instead of trying example.com.
		expect(calls.map((c) => c.path)).toEqual(['/zones?name=sub.example.com']);
	});

	it('domain is not a zone / zones query fails → error, no ruleset touched', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: { ok: false, status: 403, errors: [{ message: 'not authorized' }] }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('akito.dog');
		// Pin the abort semantics too: without this, a walk that stops aborting on
		// failed lookups still passed this test (found by mutation).
		expect(res.detail).toContain('HTTP 403');
		// A 403 IS a permission failure — the scope hint must survive here even
		// though non-permission statuses dropped it.
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('WAF: Edit');
		expect(calls).toHaveLength(1);
	});

	it('token lacks WAF scope (entrypoint 403) → error, no write attempted', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 403 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('WAF: Edit');
		// GET zone + GET entrypoint only — no mutation on a scope failure.
		expect(calls.every((c) => c.method === 'GET')).toBe(true);
	});

	it('a 401 entrypoint read names the scope too — both permission statuses hint', async () => {
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 401 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 401');
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('WAF: Edit');
	});

	// New contract: a 500 stays bare only when the body carried no usable
	// errors (this fixture has none); with errors the reason is appended.
	it('a transient entrypoint failure (500, no errors body) reports the status without blaming token scope', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 500 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 500');
		expect(res.detail).not.toContain('token needs');
		expect(calls.every((c) => c.method === 'GET')).toBe(true);
	});

	it('a thrown fetch (status 0) says the API was never reached', async () => {
		const { api } = fakeApi({
			[zonePath]: { ok: false, status: 0 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('the Cloudflare API did not respond');
		// The tail already says it; a bare '(HTTP 0)' would be noise.
		expect(res.detail).not.toContain('HTTP 0');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 200 zone query whose body says success:false carries the API’s reason', async () => {
		// resolveZone threads the failed lookup's errors body through, so this
		// arm prints the reason like the ruleset-read and write branches do.
		const { api } = fakeApi({
			[zonePath]: { ok: false, status: 200, errors: [{ code: 2003, message: 'zones listing disabled' }] }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('could not query zones');
		expect(res.detail).toContain('the API reported failure (2003: zones listing disabled)');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 200 entrypoint read whose body says success:false repeats the API’s reason', async () => {
		// cfApi maps a 2xx with success:false to ok=false — a bare '(HTTP 200)'
		// would be nonsense, so the detail carries the error summary.
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 200, errors: [{ code: 2001, message: 'zone is on hold' }] }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 200');
		expect(res.detail).toContain('the API reported failure (2001: zone is on hold)');
		expect(res.detail).not.toContain('token needs');
	});

	it('empty domain → error before any network call', async () => {
		const { api, calls } = fakeApi({});
		const res = await applyDownloadRateLimit(SECRET, '   ', api);
		expect(res.status).toBe('error');
		expect(calls).toHaveLength(0);
	});
});

describe('applyDownloadRateLimit — never leaks the token', () => {
	it('no returned detail carries a non-allowlisted error field, the secret, or the zone id, across every branch', async () => {
		// The allowlisted code+message IS repeated in error details now (that is
		// the honest contract); everything else in the body must never be.
		const ALLOWLISTED_MESSAGE = 'cf-error-message-expected-in-detail';
		const NON_ALLOWLISTED_MARKER = 'cf-error-extra-field-must-not-leak';
		const apiErrors = [
			{ code: 10000, message: ALLOWLISTED_MESSAGE, detail_url: NON_ALLOWLISTED_MARKER }
		];
		// Each scenario pins the branch it exercises via the expected status —
		// otherwise route drift would silently collapse them all into the error
		// branch and the sweep would stop covering the success details.
		// `carriesReason` = the failing route returned an errors body, so the
		// detail must repeat its code+message.
		const scenarios: {
			routes: Record<string, CfApiResult>;
			status: string;
			carriesReason?: boolean;
		}[] = [
			// error: no zone access
			{ routes: { [zonePath]: { ok: true, status: 200, result: [] } }, status: 'error' },
			// error: zones query failed
			{
				routes: { [zonePath]: { ok: false, status: 403, errors: apiErrors } },
				status: 'error',
				carriesReason: true
			},
			// error: entrypoint scope failure
			{
				routes: { [zonePath]: zoneOk, [entryPath]: { ok: false, status: 403, errors: apiErrors } },
				status: 'error',
				carriesReason: true
			},
			// error: write failed
			{
				routes: {
					[zonePath]: zoneOk,
					[entryPath]: { ok: false, status: 404 },
					[putEntryPath]: {
						ok: false,
						status: 500,
						errors: apiErrors
					}
				},
				status: 'error',
				carriesReason: true
			},
			// success: created (no ruleset yet, PUT creates the entrypoint)
			{
				routes: {
					[zonePath]: zoneOk,
					[entryPath]: { ok: false, status: 404 },
					[putEntryPath]: { ok: true, status: 200 }
				},
				status: 'created'
			},
			// success: created (ruleset exists, POST appends our rule)
			{
				routes: {
					[zonePath]: zoneOk,
					[entryPath]: { ok: true, status: 200, result: { id: RULESET, rules: [] } },
					[`POST /zones/${ZONE}/rulesets/${RULESET}/rules`]: { ok: true, status: 200 }
				},
				status: 'created'
			},
			// success: updated (our rule present with stale params, PATCH in place)
			{
				routes: {
					[zonePath]: zoneOk,
					[entryPath]: {
						ok: true,
						status: 200,
						result: {
							id: RULESET,
							rules: [{ id: 'mine', ref: RULE_REF, action: 'block', enabled: true, expression: 'stale' }]
						}
					},
					[`PATCH /zones/${ZONE}/rulesets/${RULESET}/rules/mine`]: { ok: true, status: 200 }
				},
				status: 'updated'
			},
			// success: exists (our rule already identical — no-op)
			{
				routes: {
					[zonePath]: zoneOk,
					[entryPath]: {
						ok: true,
						status: 200,
						result: {
							id: RULESET,
							rules: [
								{
									id: 'mine',
									ref: RULE_REF,
									action: 'block',
									enabled: true,
									expression: RULE_EXPRESSION,
									ratelimit: { ...RULE_RATELIMIT }
								}
							]
						}
					}
				},
				status: 'exists'
			}
		];
		for (const { routes, status, carriesReason } of scenarios) {
			const { api } = fakeApi(routes);
			const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
			expect(res.status).toBe(status);
			expect(res.detail).not.toContain(SECRET);
			expect(res.detail).not.toContain(ZONE);
			expect(res.detail).not.toContain(NON_ALLOWLISTED_MARKER);
			if (carriesReason) expect(res.detail).toContain(`10000: ${ALLOWLISTED_MESSAGE}`);
			else expect(res.detail).not.toContain(ALLOWLISTED_MESSAGE);
		}
		// The knownZoneId entry point skips the zone walk — its details must be
		// just as clean (the caller-provided zone id is the leak candidate here).
		const { api } = fakeApi({
			[entryPath]: { ok: false, status: 500, errors: apiErrors }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api, ZONE);
		expect(res.status).toBe('error');
		expect(res.detail).not.toContain(SECRET);
		expect(res.detail).not.toContain(ZONE);
		expect(res.detail).not.toContain(NON_ALLOWLISTED_MARKER);
		expect(res.detail).toContain(`10000: ${ALLOWLISTED_MESSAGE}`);

		// 200/success:false: the reported-failure arm repeats the allowlisted
		// code+message too, and only the allowlisted fields may appear.
		const split = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: {
				ok: false,
				status: 200,
				errors: [
					{ code: 9110, message: ALLOWLISTED_MESSAGE, detail_url: NON_ALLOWLISTED_MARKER }
				]
			}
		});
		const splitRes = await applyDownloadRateLimit(SECRET, 'akito.dog', split.api);
		expect(splitRes.status).toBe('error');
		expect(splitRes.detail).toContain(`9110: ${ALLOWLISTED_MESSAGE}`);
		expect(splitRes.detail).not.toContain(NON_ALLOWLISTED_MARKER);
		expect(splitRes.detail).not.toContain(SECRET);
		expect(splitRes.detail).not.toContain(ZONE);
	});

	it('passes the token through to cfApi as the first arg (used as Bearer, not in path/body)', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: { ok: true, status: 200 }
		});
		await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		// Token is the first arg on every call; never embedded in a path or body.
		for (const c of calls) {
			expect(c.token).toBe(SECRET);
			expect(c.path).not.toContain(SECRET);
			expect(JSON.stringify(c.body ?? '')).not.toContain(SECRET);
		}
	});
});

describe('applyDownloadRateLimit — write failure', () => {
	it('reports the write failure with its status, without blaming token scope', async () => {
		// The token already read the ruleset by this point, so a failed write is
		// rarely a scope problem — the old "token needs …" suffix here sent
		// operators to fix scopes for what was really an HTTP 500.
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: { ok: false, status: 500 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to write');
		expect(res.detail).toContain('HTTP 500');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 403 with an errors body appends the attributed API reason after the scope hint', async () => {
		// Our advice first, the API's own words attributed after — separable, not
		// contradictory, and neither is dropped.
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 403, errors: [{ code: 10000, message: 'Authentication error' }] }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toMatch(/token needs .*; the API said 10000: Authentication error/);
	});

	it('a 403 write DOES name the scope: WAF Read and WAF Edit are separate groups', async () => {
		// A token minted with WAF Read passes the zone query and the entrypoint
		// read, then 403s on the first mutation — the most likely real-world
		// failure, so it must keep the guidance.
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: { ok: false, status: 403 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to write');
		expect(res.detail).toContain('HTTP 403');
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('WAF: Edit');
	});

	it('a 200 write whose body says success:false repeats the API’s reason', async () => {
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[putEntryPath]: {
				ok: false,
				status: 200,
				errors: [{ code: 2002, message: 'ruleset limit reached' }]
			}
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to write');
		expect(res.detail).toContain('the API reported failure (2002: ruleset limit reached)');
		expect(res.detail).not.toContain('token needs');
	});
});

describe('isPermissionError — the standalone runner’s recipe gate', () => {
	// apply-download-ratelimit.ts prints its token recipe only when this returns
	// true, so pin it against REAL branch output, both directions.
	it('is true for real permission details and false for real transient ones', async () => {
		const denied = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({ [zonePath]: zoneOk, [entryPath]: { ok: false, status: 403 } }).api
		);
		expect(isPermissionError(denied)).toBe(true);

		const noAccess = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({ [zonePath]: { ok: true, status: 200, result: [] } }).api
		);
		expect(isPermissionError(noAccess)).toBe(true);

		const transient = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({
				[zonePath]: zoneOk,
				[entryPath]: { ok: false, status: 404 },
				[putEntryPath]: { ok: false, status: 500 }
			}).api
		);
		expect(isPermissionError(transient)).toBe(false);
	});

	// The gate used to search the formatted detail for the scope hint. Since the
	// API's own message is echoed into that same text, a 500 whose body quoted the
	// permission read as a refusal and sent the operator to re-mint a working
	// token. The result now records what happened, so the wording cannot lie.
	it('is false for a 500 whose API message quotes the scope hint verbatim', async () => {
		const res = await applyDownloadRateLimit(
			SECRET,
			'akito.dog',
			fakeApi({
				[zonePath]: zoneOk,
				[entryPath]: { ok: false, status: 404 },
				[putEntryPath]: {
					ok: false,
					status: 500,
					errors: [{ code: 1000, message: `internal error; check Zone → WAF: Edit (plus a Zone resource covering the domain)` }]
				}
			}).api
		);
		expect(res.detail).toContain(WAF_SCOPE_HINT);
		expect(isPermissionError(res)).toBe(false);
	});
});
