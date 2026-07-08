import { getDb } from '$lib/server/db';
import { requestPasswordReset } from '$lib/server/password-reset';
import { sanitizeText } from '$lib/server/validate';
import type { Actions } from './$types';

export const actions = {
	default: async ({ request, platform, url }) => {
		const data = await request.formData();
		const email = sanitizeText(data.get('email') as string, 200);

		// Always the same generic response, regardless of whether the email matched,
		// whether adminEmail is set, or whether RESEND_API_KEY is configured — no
		// account enumeration. requestPasswordReset never signals which case it hit,
		// but a MATCH does real work (mint a token, write D1, call Resend) while a
		// non-match bails after one read — awaiting either inline here would leak
		// which one happened through response latency. Run it off the response path
		// via waitUntil so the response returns equally fast either way; fall back
		// to awaiting it only where waitUntil isn't available (e.g. local dev).
		const task = requestPasswordReset(getDb(platform!.env.DB), platform?.env, url.origin, email).catch((e) => {
			// Never leak internal state through the response (enumeration) — but a
			// deferred failure (e.g. a 2xx send followed by a D1 write failure, which
			// mails a dead reset link) must stay diagnosable, so log it distinctly.
			console.error('password-reset deferred task failed:', e instanceof Error ? e.message : e);
		});
		if (platform?.ctx) {
			platform.ctx.waitUntil(task);
		} else {
			await task;
		}
		return { sent: true };
	}
} satisfies Actions;
