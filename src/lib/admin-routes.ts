/**
 * Admin routes reachable without a session: sign-in, the first-run setup wizard,
 * and the password-recovery pair. Single-sourced (SONA-119) because two places
 * act on it and they must agree — hooks.server.ts decides who gets past the
 * session check, and the admin layout decides which pages render bare chrome and
 * write no operator cookies. A route the layout treated as signed-in while the
 * hooks let it through anonymously would plant an operator cookie on a stranger.
 */
export const ADMIN_AUTH_EXEMPT = [
	'/admin/login',
	'/admin/setup',
	'/admin/forgot',
	'/admin/reset'
] as const;

/** Prefix match, so a child route (/admin/reset/[token]) is exempt with its
 * parent rather than silently becoming a signed-in page. */
export function isAdminAuthExempt(pathname: string): boolean {
	return ADMIN_AUTH_EXEMPT.some((route) => pathname.startsWith(route));
}
