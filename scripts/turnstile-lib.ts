/**
 * Cloudflare Turnstile widget provisioning for the admin-login bot check
 * (security finding F1). The public /admin/login POST is the one unauthenticated
 * write that guesses a password; a Turnstile challenge in front of it raises the
 * cost of a brute-force loop. This creates (or reuses) an account-level Turnstile
 * widget for the fork's domain and hands back its sitekey + secret so setup can
 * wire TURNSTILE_SITEKEY (a Pages var, public) and TURNSTILE_SECRET (a Pages
 * secret, server-only). The app side — the login form + `verifyTurnstile` — is a
 * separate change; enforcement is gated on BOTH keys being set, so a fork with no
 * Turnstile scope simply runs on the throttle + password alone.
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
import { cfApi, hostFromDomain } from './setup-lib.ts';

/**
 * Stable widget name we match on so re-runs find-and-reuse our widget (idempotent)
 * instead of appending a duplicate. Turnstile has no unique key or get-by-name, so
 * the reconciliation key is this name PLUS the fork's host — do not change the name
 * or old forks' widgets become unmatched and a fresh one is created alongside.
 *
 * The host half is not optional: one Cloudflare account can hold several forks (a
 * multi-fork operator), and every fork's widget carries this same name. Matching on
 * the name alone hands the SECOND fork the FIRST fork's sitekey — a widget scoped to
 * the wrong domain, so every Turnstile verify fails and (F1 being fail-closed) the
 * admin login locks. Wrong-domain reuse is strictly worse than a duplicate widget.
 */
export const WIDGET_NAME = 'sona-admin-login';

/**
 * Managed mode: Cloudflare picks the challenge from the visitor's signals and only
 * shows an interaction to suspected bots — the least-friction option for a login a
 * real operator hits daily. (Non-Interactive / Invisible are the other modes.)
 */
export const WIDGET_MODE = 'managed';

/** The token permission a fork operator must add, quoted verbatim in errors. */
const SCOPE_HINT = 'Account → Turnstile: Edit';

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
 *   1. GET /accounts/<acct>/challenges/widgets → list the account's widgets. A
 *      non-ok response (401/403 = no Turnstile scope, or a transient error) → a
 *      clear error naming the missing scope. No mutation.
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
 * Note on matching: the list is read with a generous page size, not paginated. A
 * fresh fork's account has at most a handful of widgets, so a single page finds
 * ours; the cost of the rare miss is a duplicate widget, never a crash. A miss is
 * the only acceptable failure direction here — see WIDGET_NAME on why matching must
 * never reuse a widget issued for a different host.
 */
export async function provisionTurnstileWidget(
	cfToken: string,
	accountId: string,
	domain: string,
	api: typeof cfApi = cfApi
): Promise<TurnstileResult> {
	const host = hostFromDomain(domain);
	if (!host) return { status: 'error', detail: 'no domain given' };

	// 1. List existing widgets; reconcile against ours by stable name.
	const listRes = await api(cfToken, `/accounts/${accountId}/challenges/widgets?per_page=50`);
	if (!listRes.ok) {
		return {
			status: 'error',
			detail: `could not list Turnstile widgets (HTTP ${listRes.status}); token needs ${SCOPE_HINT}`
		};
	}
	const widgets = (listRes.result as Widget[] | undefined) ?? [];
	const mine = widgets.find(
		(w) => w.name === WIDGET_NAME && w.sitekey && w.domains?.includes(host)
	);

	// 2a. Reuse: fetch the single widget so we read its secret from the authoritative
	// GET (matching `wrangler turnstile widget get`, which returns the secret).
	if (mine?.sitekey) {
		const getRes = await api(cfToken, `/accounts/${accountId}/challenges/widgets/${mine.sitekey}`);
		const secret = (getRes.result as Widget | undefined)?.secret;
		if (!getRes.ok || !secret) {
			return {
				status: 'error',
				detail: `found the ${WIDGET_NAME} widget for ${host} but could not read its secret (HTTP ${getRes.status}); token needs ${SCOPE_HINT}`
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
		return {
			status: 'error',
			detail: `failed to create the ${WIDGET_NAME} Turnstile widget for ${host} (HTTP ${createRes.status}); token needs ${SCOPE_HINT}`
		};
	}
	return {
		status: 'created',
		sitekey: created.sitekey,
		secret: created.secret,
		detail: `created the ${WIDGET_NAME} Turnstile widget for ${host} (${WIDGET_MODE} mode)`
	};
}
