import { expect, type Page } from '@playwright/test';

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
// `frame-src challenges.cloudflare.com` CSP directive (src/csp-config.test.ts:68
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

export async function adminLogin(
	page: Page,
	password: string,
	opts: { realTurnstile?: boolean } = {}
) {
	if (!opts.realTurnstile) await stubTurnstile(page);
	await page.goto('/admin/login');
	await page.fill('input[name="password"]', password);
	if (await page.locator('.turnstile').count()) {
		// The stub prefix doubles as proof the stub is actually in effect: the real
		// widget can never mint an `e2e-stub-token-` value, so a broken route glob
		// or a dropped stubTurnstile() call fails loudly here instead of silently
		// reverting to the flaky real widget.
		await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(
			opts.realTurnstile ? /.+/ : new RegExp('^' + STUB_TOKEN_PREFIX),
			{ timeout: 15_000 }
		);
	}
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
}
