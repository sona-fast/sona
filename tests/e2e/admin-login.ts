import { expect, test, type Locator, type Page } from '@playwright/test';

// Shared admin-login step for the E2E specs. The e2e env configures Turnstile
// with Cloudflare's always-pass TEST keys (see wrangler.e2e*.toml), so the login
// action ENFORCES a token. By default the specs do NOT load the real widget:
// stubTurnstile() intercepts api.js and serves a tiny stand-in that injects the
// hidden `cf-turnstile-response` input (the real widget owns that input — the
// app only renders the empty `.turnstile` container) and fires the callback
// synchronously. The stub removes only the BROWSER-side widget round-trip — the
// api.js load + challenge solve that used to time this wait out on CI runners.
// The login action still runs the full enforced path: the server-side siteverify
// POST to challenges.cloudflare.com happens on EVERY login, stubbed or not, so
// outbound access is still required. The TEST secret verifies ANY token as
// success.
//
// csp-check.spec.ts's first test opts OUT via `{ realTurnstile: true }`: the
// real widget's challenge iframe is the only RUNTIME coverage of the
// `frame-src challenges.cloudflare.com` CSP directive (src/csp-config.test.ts:75
// already guards the directive declaratively). That one test therefore keeps the
// genuine script — and its dependence on a reachable challenges.cloudflare.com,
// which is exactly why the stub is the default everywhere else.
//
// We gate on the SSR-rendered `.turnstile` container div, which is in the initial
// HTML whenever a sitekey is configured — NOT on the `cf-turnstile-response` input,
// which turnstile.render() injects client-side only after api.js loads async (a
// count() on it can run before it exists and wrongly skip the wait). toHaveValue
// then auto-waits for that input to appear and populate.

// The one place the stub token shape is defined — the stub mints tokens with
// this prefix, and the assertions in adminLogin and login-retry.spec.ts match
// against it.
export const STUB_TOKEN_PREFIX = 'e2e-stub-token-';

// Serves in place of turnstile/v0/api.js. Mirrors the real widget's contract as
// the login page uses it (src/routes/admin/login/+page.svelte): render() injects
// the hidden response input into the container and fires `callback`; reset()
// re-issues a fresh token (the page calls it after every submit via use:enhance —
// siteverify consumes the single-use token, so the wrong-password retry in
// login-retry.spec.ts needs a fresh one to re-enable the submit button).
// Tokens are unique per issue so nothing ever hinges on the TEST secret
// tolerating token reuse.
const TURNSTILE_STUB = `window.turnstile = (() => {
	let widget;
	let tokenSeq = 0;
	const issue = (w) => {
		w.input.value = '${STUB_TOKEN_PREFIX}' + ++tokenSeq;
		if (w.opts && w.opts.callback) w.opts.callback(w.input.value);
	};
	return {
		render(el, opts) {
			// Reuse an existing input rather than appending a duplicate: paraglide HMR
			// has been observed remounting the login page repeatedly with the container
			// element persisting, and stacked hidden inputs would shadow each other.
			let input = el.querySelector('input[name="cf-turnstile-response"]');
			if (!input) {
				input = document.createElement('input');
				input.type = 'hidden';
				input.name = 'cf-turnstile-response';
				el.appendChild(input);
			}
			widget = { input, opts };
			// No sitekey, no token: leave the input empty so adminLogin's toHaveValue
			// wait fails legibly instead of masking broken sitekey wiring in
			// +page.server.ts. Presence-only on purpose — no hardcoded key here.
			// A reused input is cleared explicitly — a stale token left over from a
			// previous render would otherwise satisfy that wait anyway.
			if (opts && opts.sitekey) issue(widget);
			else widget.input.value = '';
			return 'stub';
		},
		reset() {
			// Ignores its id argument and targets the latest render() — matching the
			// real widget's no-arg reset, which acts on the most recent widget.
			if (widget) issue(widget);
		}
	};
})();`;

// Route interception (rather than addInitScript) on purpose: the page's
// <script src=".../api.js?render=explicit"> request is still MADE and still
// evaluated against the CSP `script-src` allowance for challenges.cloudflare.com
// — we only substitute the response — and the page's normal `onload → render`
// path runs unchanged. Pre-defining window.turnstile would take the login page's
// early-return branch and quietly skip both.
export async function stubTurnstile(page: Page) {
	await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
		route.fulfill({ contentType: 'application/javascript', body: TURNSTILE_STUB })
	);
}

/** Per-step caps for one bounded login attempt. The Turnstile token wait is
 * capped at `token` in every login, bounded or not. The worst case of one
 * attempt is the sum, 65s, so LOGIN_BUDGET below fits two attempts: toPass
 * abandons an attempt still running at its deadline, so a second attempt has to
 * be able to start and finish. */
export const LOGIN_ATTEMPT = {
	goto: 20_000,
	fill: 2_500,
	token: 15_000,
	click: 2_500,
	url: 25_000
};
export const LOGIN_ATTEMPT_MAX = Object.values(LOGIN_ATTEMPT).reduce((a, b) => a + b, 0);
/** Two worst-case attempts plus 5s for toPass's own pauses between them. */
export const LOGIN_BUDGET = 2 * LOGIN_ATTEMPT_MAX + 5_000;

export async function adminLogin(
	page: Page,
	password: string,
	// bounded caps every step at LOGIN_ATTEMPT, for a caller that retries.
	// Unset, the goto, fill, click and landing wait each get whatever is left of
	// the test's own budget.
	opts: { realTurnstile?: boolean; bounded?: boolean } = {}
) {
	const cap = opts.bounded ? LOGIN_ATTEMPT : undefined;
	if (!opts.realTurnstile) await stubTurnstile(page);
	await page.goto('/admin/login', { timeout: cap?.goto });
	await page.fill('input[name="password"]', password, { timeout: cap?.fill });
	if (await page.locator('.turnstile').count()) {
		// The stub prefix doubles as proof the stub is actually in effect: the real
		// widget can never mint an `e2e-stub-token-` value, so a broken route glob
		// or a dropped stubTurnstile() call fails loudly here instead of silently
		// reverting to the flaky real widget.
		await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(
			opts.realTurnstile ? /.+/ : new RegExp('^' + STUB_TOKEN_PREFIX),
			{ timeout: LOGIN_ATTEMPT.token }
		);
	}
	await page.click('button[type="submit"]', { timeout: cap?.click });
	await page.waitForURL(/\/admin\/images/, { timeout: cap?.url });
}

/** adminLogin, retried. A cold run occasionally bounces back to /admin/login
 * inside adminLogin's own waitForURL, and the spec then fails before it has done
 * anything. The login step navigates to the form itself and is idempotent, so it
 * is retried here rather than in adminLogin, which every other spec depends on.
 *
 * The retry budget is longer than Playwright's 30s per-test default, so the test
 * gets its own budget raised above it first: without that, a cold start dies at
 * 30s with a bare timeout and no second attempt. The 120_000 in
 * playwright.config.ts is the webServer boot timeout, not the per-test one.
 * The toPass budget is LOGIN_BUDGET, 135s: a full run boots six dev servers at
 * once, and a 60s budget once ran out on a box that was compiling five other
 * projects' pages at the same time. Each attempt is capped at LOGIN_ATTEMPT,
 * 65s at worst, so the budget always leaves room for a second full attempt.
 * When an attempt fails inside its caps, toPass reports that attempt's error,
 * so a genuine login failure still reads as itself. If the second attempt is
 * still running at 135s, toPass abandons it and reports the first attempt's
 * error followed by its own timeout line, so the report names the first
 * failure but says nothing about what the second attempt was stuck on.
 * The test timeout raised on the first line of the function is the budget plus
 * 45s for the spec's own work. */
export async function loginRetrying(page: Page, password: string) {
	test.setTimeout(LOGIN_BUDGET + 45_000);
	await expect(async () => {
		// Each attempt starts from a signed-out browser. An attempt that set the
		// session cookie and then lost its own waitForURL would otherwise leave the
		// next one filling a password field that is not there: /admin/login 302s to
		// /admin/images once the cookie exists, so the retry would fail on the form
		// rather than on the login.
		await page.context().clearCookies();
		await adminLogin(page, password, { bounded: true });
	}).toPass({ timeout: LOGIN_BUDGET });
}

/** adminLogin resolves as soon as the login navigation commits, so the admin
 * page it lands on can still be settling — a goto issued into that lands as
 * net::ERR_ABORTED. Wait for the landed page, then navigate, retrying the
 * navigation if the abort still wins the race. */
export async function gotoAfterLogin(page: Page, path: string) {
	await page.waitForLoadState('load');
	await gotoRetrying(page, path);
}

/** The retry alone, for a navigation issued mid-test rather than straight after
 * a login: the admin pages run client-side work after every load, and a goto
 * that races it aborts the same way. */
export async function gotoRetrying(page: Page, path: string) {
	await expect(async () => {
		await page.goto(path);
	}).toPass({ timeout: 15_000 });
}

/** Wait until the page a goto just loaded has hydrated.
 *
 * The admin shell and the public layouts mount the bottom nav (MobileNav),
 * which writes --mobile-nav-height onto <html> from a ResizeObserver. The
 * server never renders that property, and the observer first reports after
 * Svelte has mounted the whole tree, so once it is there every click handler
 * and every use:enhance on the page is attached. It is published even while
 * the nav is hidden on a wide screen, as 0px.
 *
 * Wait on this once instead of clicking a client-only control in a retry
 * loop. That loop spends its budget re-clicking, and each click that lands
 * before use:enhance on a form posts natively and reloads the page, which
 * starts hydration over again.
 *
 * Only a gate for a fresh document: after a client-side navigation the old
 * value is still on <html>, but then the app was hydrated already. The login
 * page has no bottom nav; adminLogin waits for the Turnstile token instead,
 * which that page also only issues once it has mounted.
 *
 * waitForNavHeight (site-chrome-helpers.ts) reads the same property to measure
 * the bar, not to gate on hydration. */
export async function waitForHydration(page: Page, timeout = 30_000) {
	await expect
		.poll(
			() =>
				page
					.evaluate(
						() => document.documentElement.style.getPropertyValue('--mobile-nav-height') !== ''
					)
					// A navigation in progress destroys the context mid-evaluate; that is
					// "not yet", not a failure.
					.catch(() => false),
			{ message: 'the page hydrates (MobileNav publishes --mobile-nav-height)', timeout }
		)
		.toBe(true);
}

/** Open the Site tab of /admin/settings once the page has hydrated. The wait
 * is mostly for the caller's next step: an unhydrated form submits as a real
 * navigation, and that aborts the caller's next goto. */
export async function openSiteTab(page: Page) {
	await waitForHydration(page);
	await page.getByRole('tab', { name: 'Site', exact: true }).click();
}

/** Open the Connections tab of /admin/settings once the page has hydrated.
 * The tab is a client-side swap: `shown` is in the DOM but hidden until the tab
 * handler runs, so after the wait one click shows it. The click is capped at
 * clickTimeout so a caller can add the whole step into its own budget. */
export async function openConnectionsTab(
	page: Page,
	shown: Locator,
	hydrationTimeout?: number,
	clickTimeout = 2_500
) {
	await waitForHydration(page, hydrationTimeout);
	await page.getByRole('tab', { name: 'Connections', exact: true }).click({ timeout: clickTimeout });
	await expect(shown).toBeVisible();
}
