/**
 * Cloudflare Turnstile widget provisioning for the optional admin-login bot
 * check. This creates (or reuses) an account-level Turnstile widget for the
 * fork's domain and hands back its sitekey + secret so setup can wire
 * TURNSTILE_SITEKEY (a Pages var, public) and TURNSTILE_SECRET (a Pages secret,
 * server-only). The app side — the login form + `verifyTurnstile` — is a separate
 * change; the check is enforced only when BOTH keys are set.
 *
 * The core `provisionTurnstileWidget` mirrors `applyDownloadRateLimit` in
 * waf-lib.ts: it reuses `cfApi` from setup-lib for token handling + fetch style,
 * lives here (not in the self-executing setup.ts) so it is unit-testable, and is
 * idempotent — a re-run finds the existing widget by its stable name and reuses
 * it rather than minting a duplicate. The Cloudflare token is passed in, used only
 * as a Bearer header by `cfApi`, and never logged; the widget SECRET it returns is
 * never placed in any `detail` string (setup feeds it to `wrangler pages secret
 * put` over stdin, never the console).
 *
 * Unlike WAF, Turnstile is ACCOUNT-scoped and needs no Cloudflare zone — a widget
 * can be issued for any domain, including one whose DNS lives elsewhere — so the
 * caller does not gate this on zone resolution, only on having a custom domain.
 */
import { cfApi, cfFailureTail, hostFromDomain, statusLabel, type CfApiResult } from './setup-lib.ts';

/**
 * Stable widget name we match on so re-runs find-and-reuse our widget (idempotent)
 * instead of appending a duplicate. Turnstile has no unique key or get-by-name, so
 * the reconciliation key is this name PLUS the fork's host — do not change the name
 * or old forks' widgets become unmatched and a fresh one is created alongside.
 *
 * The host half is not optional: one Cloudflare account can hold several forks (a
 * multi-fork operator), and every fork's widget carries this same name. Matching on
 * the name alone hands the SECOND fork the FIRST fork's sitekey — a widget scoped to
 * the wrong domain, so every Turnstile verify fails and (the check being
 * fail-closed) the
 * admin login locks. Wrong-domain reuse is strictly worse than a duplicate widget.
 */
export const WIDGET_NAME = 'sona-admin-login';

/**
 * Managed mode: Cloudflare picks the challenge from the visitor's signals and only
 * shows an interaction to suspected bots — the least-friction option for a login a
 * real operator hits daily. (Non-Interactive / Invisible are the other modes.)
 */
export const WIDGET_MODE = 'managed';

/** The token permission a fork operator must add — exported so setup's token
 * recipe names the same scope this module's errors do. */
export const SCOPE_HINT = 'Account → Turnstile: Edit';

/** Widgets asked for per list page; also the "was that page full?" test. */
const PER_PAGE = 50;

/**
 * Stop after this many list pages. Termination normally comes from a short page,
 * but an API that ignored `page` would hand back the same full page forever, so
 * the loop needs a floor it cannot fall through. 20 pages covers far more widgets
 * than any account we provision into holds.
 */
const MAX_PAGES = 20;

/** setup-lib's shared cfFailureTail, bound to this lib's scope hint. */
function failureTail(res: CfApiResult): string {
	return cfFailureTail(res.status, res.errors, SCOPE_HINT);
}

/** A Turnstile widget as returned by the challenges/widgets API. */
interface Widget {
	sitekey?: string;
	secret?: string;
	name?: string;
	domains?: string[];
}

/** The create-widget body sent to POST .../challenges/widgets. */
export function buildCreateBody(host: string): Record<string, unknown> {
	return { name: WIDGET_NAME, domains: [host], mode: WIDGET_MODE };
}

export type TurnstileStatus = 'created' | 'exists' | 'error';

export interface TurnstileResult {
	status: TurnstileStatus;
	/** Human-readable, SECRET-free summary safe to print. */
	detail: string;
	/** Public site key — safe to render into the page / set as a plain Pages var. */
	sitekey?: string;
	/** Server-only secret — feed to `pages secret put`, never log. Absent on error. */
	secret?: string;
}

/**
 * Idempotently provision the admin-login Turnstile widget for `domain`'s host.
 *
 * Sequence (all via `cfApi`, Bearer `cfToken`):
 *   1. GET /accounts/<acct>/challenges/widgets → list the account's widgets, a
 *      page at a time until ours turns up or a page comes back short. A non-ok
 *      response on any page → a clear error whose detail carries the actual reason
 *      (the scope hint on 401/403, otherwise just the HTTP status), and so does an
 *      ok page whose body isn't a list at all. No mutation.
 *   2. Match our widget by its stable `name` (WIDGET_NAME) AND `domains` containing
 *      this fork's host — see WIDGET_NAME on why the host half is required:
 *        - found → GET .../widgets/<sitekey> to read its secret authoritatively
 *          (the single-widget GET returns the secret; the reuse is a no-op create),
 *          status 'exists'.
 *        - not found → POST .../widgets with our create body, status 'created'.
 *      Either way the returned result carries the sitekey + secret; nothing else on
 *      the account is touched.
 *
 * `api` is injectable (defaults to the real `cfApi`) so tests exercise every branch
 * without network. Never logs the token; the widget secret appears in no `detail`.
 *
 * Note on matching: the list is paginated because a first-page-only read on an
 * account holding more than PER_PAGE widgets can miss ours, and a miss is not free
 * — the re-run mints a duplicate widget and rewires Pages to its sitekey/secret.
 * Missing is still the only acceptable failure direction, though: see WIDGET_NAME
 * on why matching must never reuse a widget issued for a different host.
 */
export async function provisionTurnstileWidget(
	cfToken: string,
	accountId: string,
	domain: string,
	api: typeof cfApi = cfApi
): Promise<TurnstileResult> {
	const host = hostFromDomain(domain);
	if (!host) return { status: 'error', detail: 'no domain given' };

	// 1. List existing widgets a page at a time; reconcile against ours by stable
	// name. Stop at the first match, at a short page (the last one), or at MAX_PAGES.
	// The explicit sort pins the ordering for the life of the walk: created_on never
	// changes, while the API's default order can be recomputed mid-walk and shuffle
	// widgets across page boundaries. A concurrent delete can still shift a widget
	// onto an already-read page — that miss just mints a duplicate, per above.
	let mine: Widget | undefined;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const listRes = await api(
			cfToken,
			`/accounts/${accountId}/challenges/widgets?page=${page}&per_page=${PER_PAGE}&order=created_on&direction=asc`
		);
		if (!listRes.ok) {
			return {
				status: 'error',
				detail: `could not list Turnstile widgets${statusLabel(listRes.status)}${failureTail(listRes)}`
			};
		}
		// An ok page whose result isn't a list is a partial body. Reading it as an
		// empty page would end the walk and mint a duplicate widget — the exact
		// failure the paging exists to prevent — so stop and say so instead.
		if (!Array.isArray(listRes.result)) {
			return {
				status: 'error',
				detail: `could not list Turnstile widgets${statusLabel(listRes.status)}; the response carried no widget list, so setup stopped rather than risk creating a second widget`
			};
		}
		const widgets = listRes.result as Widget[];
		mine = widgets.find((w) => w.name === WIDGET_NAME && w.sitekey && w.domains?.includes(host));
		if (mine || widgets.length < PER_PAGE) break;
	}

	// 2a. Reuse: fetch the single widget so we read its secret from the authoritative
	// GET (matching `wrangler turnstile widget get`, which returns the secret).
	if (mine?.sitekey) {
		const getRes = await api(cfToken, `/accounts/${accountId}/challenges/widgets/${mine.sitekey}`);
		const secret = (getRes.result as Widget | undefined)?.secret;
		if (!getRes.ok || !secret) {
			// An ok response with no secret is a partial body — the one actionable
			// lead is that a read-scoped token gets the widget without its secret.
			const why = getRes.ok
				? `; the widget came back without one, so check that the token has ${SCOPE_HINT}`
				: failureTail(getRes);
			return {
				status: 'error',
				detail: `found the ${WIDGET_NAME} widget for ${host} but could not read its secret${statusLabel(getRes.status)}${why}`
			};
		}
		return {
			status: 'exists',
			sitekey: mine.sitekey,
			secret,
			detail: `reused the existing ${WIDGET_NAME} Turnstile widget for ${host}`
		};
	}

	// 2b. Create: no widget of ours yet.
	const createRes = await api(cfToken, `/accounts/${accountId}/challenges/widgets`, {
		method: 'POST',
		body: buildCreateBody(host)
	});
	const created = createRes.result as Widget | undefined;
	if (!createRes.ok || !created?.sitekey || !created?.secret) {
		// An ok create with no sitekey/secret is a partial body — the widget most
		// likely WAS created, so claim only what we know; the summary's re-run
		// line carries the remedy (step 1's name+host match finds and reuses it).
		const why = createRes.ok
			? '; the response carried no sitekey/secret, so the widget may exist but setup could not read its keys'
			: failureTail(createRes);
		return {
			status: 'error',
			detail: `failed to create the ${WIDGET_NAME} Turnstile widget for ${host}${statusLabel(createRes.status)}${why}`
		};
	}
	return {
		status: 'created',
		sitekey: created.sitekey,
		secret: created.secret,
		detail: `created the ${WIDGET_NAME} Turnstile widget for ${host} (${WIDGET_MODE} mode)`
	};
}
