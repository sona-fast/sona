/**
 * Progress across the two REQUIRED steps for admin password-reset email:
 * the `RESEND_API_KEY` secret and a recovery email address. The optional
 * `RESEND_FROM` custom-sender step is deliberately excluded from the count —
 * password reset works without it (with the default `onboarding@resend.dev`
 * sender), so it never blocks the "ready" state.
 */
export function resendSetupProgress(state: {
	resendKeySet: boolean;
	adminEmailSet: boolean;
}): { done: number; total: number; ready: boolean } {
	const total = 2;
	const done = (state.resendKeySet ? 1 : 0) + (state.adminEmailSet ? 1 : 0);
	return { done, total, ready: done === total };
}
