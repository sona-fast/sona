import { expect, type Page } from '@playwright/test';

// Shared admin-login step for the E2E specs. The e2e env configures Turnstile
// with Cloudflare's always-pass TEST keys (see wrangler.e2e*.toml), so the login
// action ENFORCES a token. By default the specs do NOT load the real widget:
// stubTurnstile() intercepts api.js and serves a tiny stand-in that injects the
// hidden `cf-turnstile-response` input (the real widget owns that input — the
// app only renders the empty `.turnstile` container) and fires the callback
// synchronously. The TEST secret verifies ANY token as success, so the login
// action still runs the full enforced path — real server-side siteverify
// included — without the flaky browser round-trip to challenges.cloudflare.com
// that used to time this wait out on CI runners.
//
// csp-check.spec.ts opts OUT via `{ realTurnstile: true }`: the challenge
// iframe of the real widget is the only thing exercising the
// `frame-src challenges.cloudflare.com` CSP directive, so that one spec keeps
// the genuine script. Everything under `realTurnstile` still depends on
// outbound access to challenges.cloudflare.com — a network-restricted CI hangs
// there, which is exactly why the stub is the default everywhere else.
//
// We gate on the SSR-rendered `.turnstile` container div, which is in the initial
// HTML whenever a sitekey is configured — NOT on the `cf-turnstile-response` input,
// which turnstile.render() injects client-side only after api.js loads async (a
// count() on it can run before it exists and wrongly skip the wait). toHaveValue
// then auto-waits for that input to appear and populate.

// Serves in place of turnstile/v0/api.js. Mirrors the real widget's contract as
// the login page uses it (src/routes/admin/login/+page.svelte): render() injects
// the hidden response input into the container and fires `callback`; reset()
// re-issues a fresh token (the page calls it after every submit via use:enhance,
// so a no-op here would strand a retrying spec with a disabled submit button).
// Tokens are unique per issue so nothing ever hinges on the TEST secret
// tolerating token reuse.
const TURNSTILE_STUB = `window.turnstile = (() => {
	const widgets = {};
	let widgetSeq = 0;
	let tokenSeq = 0;
	const issue = (w) => {
		w.input.value = 'e2e-stub-token-' + ++tokenSeq;
		if (w.opts && w.opts.callback) w.opts.callback(w.input.value);
	};
	return {
		render(el, opts) {
			let input = el.querySelector('input[name="cf-turnstile-response"]');
			if (!input) {
				input = document.createElement('input');
				input.type = 'hidden';
				input.name = 'cf-turnstile-response';
				el.appendChild(input);
			}
			const id = 'stub-' + widgetSeq++;
			widgets[id] = { input, opts };
			issue(widgets[id]);
			return id;
		},
		reset(id) {
			const w = id === undefined ? Object.values(widgets)[0] : widgets[id];
			if (w) issue(w);
		},
		remove(id) {
			delete widgets[id];
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
	await page.route('**/challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
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
		await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
			timeout: 15_000
		});
	}
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/admin\/images/);
}
