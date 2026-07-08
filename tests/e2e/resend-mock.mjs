// E2E-only interceptor for the Resend send in the password-recovery flow.
//
// The forgot action's send runs SERVER-SIDE (src/lib/server/password-reset.ts
// calls the global `fetch` to https://api.resend.com/emails from inside the dev
// server process), so Playwright's `page.route` — which only sees the browser's
// own requests — can NOT intercept it. Instead this module is preloaded into the
// dev-server Node process via NODE_OPTIONS=--import (wired in playwright.config.ts)
// and monkeypatches the process-global `fetch`: the route resolves the bare
// `fetch` identifier to globalThis.fetch at call time, so replacing it here is
// honoured. Resend POSTs are answered with a 200 (so requestPasswordReset treats
// the send as succeeded and persists the token), and the reset link is extracted
// from the request body and appended to a capture file the spec polls
// (SONA_E2E_RESEND_CAPTURE). Every other request passes through untouched.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CAPTURE = process.env.SONA_E2E_RESEND_CAPTURE;
const RESEND_URL = 'https://api.resend.com/emails';

const realFetch = globalThis.fetch;

function urlOf(input) {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (input && typeof input.url === 'string') return input.url; // Request
	return String(input);
}

globalThis.fetch = async function patchedFetch(input, init) {
	if (CAPTURE && urlOf(input).startsWith(RESEND_URL)) {
		try {
			const body = JSON.parse((init && init.body) || '{}');
			// The plaintext part carries "...: <link>"; the reset link is the only
			// /admin/reset?token=… URL in the payload.
			const match = String(body.text || body.html || '').match(
				/https?:\/\/[^\s"'<>]*\/admin\/reset\?token=[^\s"'<>&]+/
			);
			if (match) {
				mkdirSync(path.dirname(CAPTURE), { recursive: true });
				appendFileSync(CAPTURE, match[0] + '\n');
			}
		} catch {
			/* best-effort capture — a parse failure just yields no link for the spec */
		}
		// Mimic a Resend 2xx so the caller persists the freshly minted token.
		return new Response(JSON.stringify({ id: 'e2e-resend-mock' }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	return realFetch(input, init);
};
