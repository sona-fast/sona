import { describe, it, expect } from 'vitest';
import type { CfApiResult } from './setup-lib.ts';
import {
	applyDownloadRateLimit,
	buildRule,
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
			[`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`]: { ok: true, status: 200 }
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
		expect(res.detail).toContain('no access to zone akito.dog');
		expect(res.detail).toContain('WAF: Edit');
		// Never proceeded to the ruleset endpoint.
		expect(calls).toHaveLength(1);
	});

	it('a transient failure mid-walk aborts — never falls through to the parent zone', async () => {
		const { api, calls } = fakeApi({
			'/zones?name=sub.example.com': { ok: false, status: 500 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'sub.example.com', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 500');
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

	it('empty domain → error before any network call', async () => {
		const { api, calls } = fakeApi({});
		const res = await applyDownloadRateLimit(SECRET, '   ', api);
		expect(res.status).toBe('error');
		expect(calls).toHaveLength(0);
	});
});

describe('applyDownloadRateLimit — never leaks the token', () => {
	it('the secret appears in no returned detail across every branch', async () => {
		const scenarios: Record<string, CfApiResult>[] = [
			// error: no zone access
			{ [zonePath]: { ok: true, status: 200, result: [] } },
			// error: zones query failed
			{ [zonePath]: { ok: false, status: 403 } },
			// error: entrypoint scope failure
			{ [zonePath]: zoneOk, [entryPath]: { ok: false, status: 403 } },
			// error: write failed
			{
				[zonePath]: zoneOk,
				[entryPath]: { ok: false, status: 404 },
				[`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`]: { ok: false, status: 500 }
			},
			// success: created
			{
				[zonePath]: zoneOk,
				[entryPath]: { ok: false, status: 404 },
				[`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`]: { ok: true, status: 200 }
			}
		];
		for (const routes of scenarios) {
			const { api } = fakeApi(routes);
			const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
			expect(res.detail).not.toContain(SECRET);
		}
	});

	it('passes the token through to cfApi as the first arg (used as Bearer, not in path/body)', async () => {
		const { api, calls } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`]: { ok: true, status: 200 }
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
	it('surfaces a scoped error when the create PUT fails', async () => {
		const { api } = fakeApi({
			[zonePath]: zoneOk,
			[entryPath]: { ok: false, status: 404 },
			[`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`]: { ok: false, status: 500 }
		});
		const res = await applyDownloadRateLimit(SECRET, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to write');
	});
});
