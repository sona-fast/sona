/**
 * Cloudflare WAF rate-limit provisioning for the anonymously-reachable endpoints
 * (POST /api/metrics/download, GET/HEAD /api/oembed, GET/HEAD /feed.xml). Applies
 * ONE zone-level rate-limit rule capping how often a single IP can hit them — one,
 * for the reason documented on RULE_EXPRESSION — without touching any other WAF
 * rule on the zone.
 *
 * The core `applyDownloadRateLimit` is shared by two callers: the fork setup CLI
 * (scripts/setup.ts, for future forks) and the standalone runner
 * (scripts/apply-download-ratelimit.ts, for existing forks). It reuses `cfApi`
 * from setup-lib for token handling + fetch style, and — like the other CLI
 * helpers — lives here (not in the self-executing runner) so it is unit-testable.
 * The Cloudflare token is passed in, used only as a Bearer header by `cfApi`, and
 * never logged or returned in any result.
 */
import { cfApi, hostFromDomain, zoneNameCandidates, type CfApiResult } from './setup-lib.ts';
import { resolveZone } from './connect-domains-lib.ts';

/**
 * Stable identifier so re-runs find-and-skip our rule (idempotent) and a future
 * parameter change updates it in place rather than appending a duplicate. `ref`
 * is the machine key we match on; `description` is the human label shown in the
 * dashboard. Both are stable — do not change `ref` or old rules become orphans.
 */
export const RULE_REF = 'sona_download_beacon_ratelimit';
export const RULE_DESCRIPTION = 'sona: public endpoint rate limit';

/**
 * Matches every anonymous, un-gated path that costs the origin a D1 fan-out:
 *   - POST     /api/metrics/download — the download beacon (see its +server.ts).
 *   - GET/HEAD /api/oembed           — the oEmbed provider (SONA-168). HEAD is in
 *     because SvelteKit runs the GET handler for HEAD when no HEAD is exported, so
 *     a HEAD does the same two D1 reads a GET does. Written as two `eq`s joined by
 *     `or` rather than `in {"GET" "HEAD"}`: the docs confirm space-separated set
 *     literals but not the quoted-string form, and this rule is applied unattended
 *     across the fleet — `eq`/`or` is syntax the deployed rule already proves.
 *   - GET/HEAD /feed.xml             — the RSS feed (SONA-172), four primary-DB
 *     reads per request and no other limit in front of it. Same HEAD reasoning.
 *
 * ONE rule covers all three because the Free plan allows exactly ONE rate-limiting
 * rule per zone, and every fork runs on Free. A second rule is not "extra config"
 * there — the API rejects it. So when a new anonymous path appears, extend this
 * expression; do NOT add a rule. The counter is shared across the paths, which is
 * fine: they are matched per-IP and no real client hits two in the same window.
 */
export const RULE_EXPRESSION =
	'((http.request.method eq "POST" and http.request.uri.path eq "/api/metrics/download") or ((http.request.method eq "GET" or http.request.method eq "HEAD") and (http.request.uri.path eq "/api/oembed" or http.request.uri.path eq "/feed.xml")))';

/**
 * Rate-limit knobs: at most 20 matching requests per 10s from one IP, then that IP
 * is blocked for 10s. Generous enough that a real visitor mashing download never
 * trips it, tight enough that a scripted loop is throttled to a trickle. Kept at 20
 * when /api/oembed joined the rule, with the failure mode that buys: unfurl services
 * share egress IPs, so ~21 links pasted into one channel within 10s from a single
 * colo trip the block, and the consumer silently caches the failed preview.
 *
 * `cf.colo.id` is REQUIRED alongside `ip.src`: outside Enterprise, Cloudflare
 * counts rate-limit rules per data center, and the Rulesets API rejects the rule
 * (HTTP 400, code 20155) when the colo characteristic is absent. Counting is
 * therefore per-IP-per-colo — the standard non-Enterprise behavior. Do not drop it.
 *
 * `mitigation_timeout` MUST equal the period (10): the Free plan is "not entitled
 * to use a mitigation timeout different from 10", and 10 is valid on every higher
 * plan too, so the rule stays plan-portable across forks. A blocked IP is denied
 * for 10s, then must re-exceed the threshold to be blocked again.
 */
export const RULE_RATELIMIT = {
	characteristics: ['ip.src', 'cf.colo.id'],
	period: 10,
	requests_per_period: 20,
	mitigation_timeout: 10
} as const;

/** The rate-limit rule body sent to the Rulesets API (http_ratelimit phase). */
export function buildRule(): Record<string, unknown> {
	return {
		action: 'block',
		expression: RULE_EXPRESSION,
		description: RULE_DESCRIPTION,
		ref: RULE_REF,
		enabled: true,
		ratelimit: { ...RULE_RATELIMIT }
	};
}

/** A rule already on the zone, as returned by GET ...entrypoint. */
interface ExistingRule {
	id?: string;
	ref?: string;
	description?: string;
	action?: string;
	expression?: string;
	enabled?: boolean;
	ratelimit?: {
		characteristics?: string[];
		period?: number;
		requests_per_period?: number;
		mitigation_timeout?: number;
	};
}

/**
 * True when an existing rule already encodes exactly what `buildRule` wants, so
 * the run is a no-op. Compares only the fields we own; ignores server-managed
 * fields (id, version, last_updated) that the GET returns.
 */
function ruleMatches(rule: ExistingRule): boolean {
	const rl = rule.ratelimit ?? {};
	return (
		rule.action === 'block' &&
		rule.enabled === true &&
		rule.expression === RULE_EXPRESSION &&
		rl.period === RULE_RATELIMIT.period &&
		rl.requests_per_period === RULE_RATELIMIT.requests_per_period &&
		rl.mitigation_timeout === RULE_RATELIMIT.mitigation_timeout &&
		Array.isArray(rl.characteristics) &&
		rl.characteristics.length === RULE_RATELIMIT.characteristics.length &&
		rl.characteristics.every((c, i) => c === RULE_RATELIMIT.characteristics[i])
	);
}

export type RateLimitStatus = 'created' | 'updated' | 'exists' | 'error';

export interface RateLimitResult {
	status: RateLimitStatus;
	/** Human-readable, secret-free summary safe to print. */
	detail: string;
}

/** The token permission a fork operator must add, quoted verbatim in errors. */
const SCOPE_HINT = 'Zone → WAF: Edit (plus a Zone resource covering the domain)';

/**
 * Idempotently apply the public-endpoint rate-limit rule to `domain`'s zone.
 *
 * Sequence (all via `cfApi`, Bearer `cfToken`):
 *   1. GET /zones?name=<host>            → resolve the zone id (host derived from
 *      the domain input; scheme/path stripped). No zone in the account, or the
 *      token can't see it, → a clear error naming the missing scope. No mutation.
 *   2. GET /zones/<id>/rulesets/phases/http_ratelimit/entrypoint → the zone's
 *      rate-limit ruleset. 404 = no ruleset yet (fine — we create it). 401/403 or
 *      other non-ok = token lacks WAF scope → clear error, no mutation.
 *   3. Reconcile by `ref` (never the description — see the note at the match):
 *        - found & identical            → no-op, status 'exists'.
 *        - found & differs (param bump) → PATCH that one rule, status 'updated'.
 *        - not found, ruleset exists    → POST add our rule only, status 'created'.
 *        - no ruleset (404)             → PUT the phase entrypoint with just our
 *                                         rule (creates the ruleset), status 'created'.
 *      The add/patch paths touch only our rule, never other WAF rules on the zone.
 *
 * `api` is injectable (defaults to the real `cfApi`) so tests exercise every
 * branch without network. Never logs the token; no secret appears in any result.
 */
export async function applyDownloadRateLimit(
	cfToken: string,
	domain: string,
	api: typeof cfApi = cfApi,
	knownZoneId?: string
): Promise<RateLimitResult> {
	const host = hostFromDomain(domain);
	if (!host) return { status: 'error', detail: 'no domain given' };

	// 1. Resolve the zone id via the shared candidate walk (a subdomain is served
	// by its registrable zone, and any failed lookup aborts rather than reading
	// as "no zone" — see resolveZone in connect-domains-lib.ts). Skipped when the
	// caller already resolved the zone (the setup CLI's preflight just did).
	let zoneId = knownZoneId;
	if (!zoneId) {
		const { zone, errorStatus, failedName } = await resolveZone(zoneNameCandidates(host), (name) =>
			api(cfToken, `/zones?name=${encodeURIComponent(name)}`)
		);
		if (errorStatus !== null) {
			return {
				status: 'error',
				detail: `could not query zones for ${failedName ?? host} (HTTP ${errorStatus}); token needs ${SCOPE_HINT}`
			};
		}
		zoneId = zone.id;
	}
	if (!zoneId) {
		return {
			status: 'error',
			detail: `token has no access to zone ${host}: add ${SCOPE_HINT}`
		};
	}

	// 2. Read the zone's http_ratelimit entrypoint ruleset.
	const entry = await api(cfToken, `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`);
	let rulesetId: string | undefined;
	let existing: ExistingRule[] = [];
	if (entry.ok) {
		const r = entry.result as { id?: string; rules?: ExistingRule[] } | undefined;
		rulesetId = r?.id;
		existing = r?.rules ?? [];
	} else if (entry.status !== 404) {
		// 401/403 (no WAF scope) or a transient error — do NOT mutate.
		return {
			status: 'error',
			detail: `could not read the rate-limit ruleset for ${host} (HTTP ${entry.status}); token needs ${SCOPE_HINT}`
		};
	}

	// 3. Reconcile against any rule we already own. Match on our stable ref ONLY —
	// not the human description — so we never PATCH an operator's own rule that
	// merely happens to share the label.
	const mine = existing.find((r) => r.ref === RULE_REF);
	if (mine && ruleMatches(mine)) {
		return { status: 'exists', detail: `rate-limit rule already present on ${host} — no change` };
	}

	const write: CfApiResult = await (async () => {
		if (mine && rulesetId && mine.id) {
			// Param bump: update just our rule in place.
			return api(cfToken, `/zones/${zoneId}/rulesets/${rulesetId}/rules/${mine.id}`, {
				method: 'PATCH',
				body: buildRule()
			});
		}
		if (rulesetId) {
			// Ruleset exists, our rule is absent: append only our rule.
			return api(cfToken, `/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
				method: 'POST',
				body: buildRule()
			});
		}
		// No http_ratelimit ruleset yet: create the entrypoint with our rule.
		return api(cfToken, `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`, {
			method: 'PUT',
			body: { rules: [buildRule()] }
		});
	})();

	if (!write.ok) {
		return {
			status: 'error',
			detail: `failed to write the rate-limit rule to ${host} (HTTP ${write.status}); token needs ${SCOPE_HINT}`
		};
	}
	return mine
		? { status: 'updated', detail: `updated the public-endpoint rate-limit rule on ${host}` }
		: {
				status: 'created',
				detail: `created the public-endpoint rate-limit rule on ${host} (POST /api/metrics/download + GET/HEAD /api/oembed + GET/HEAD /feed.xml: max ${RULE_RATELIMIT.requests_per_period} / ${RULE_RATELIMIT.period}s per IP, ${RULE_RATELIMIT.mitigation_timeout}s block)`
			};
}
