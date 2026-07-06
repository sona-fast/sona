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
		// account enumeration. requestPasswordReset never signals which case it hit.
		try {
			await requestPasswordReset(getDb(platform!.env.DB), platform?.env, url.origin, email);
		} catch {
			// Never leak internal state through the response.
		}
		return { sent: true };
	}
} satisfies Actions;
