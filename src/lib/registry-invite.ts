/** The registry's two invite refusals, which the connect form shows on the token field. */
export const INVITE_REFUSALS = ['invite_used', 'invite_invalid'] as const;
export type InviteRefusal = (typeof INVITE_REFUSALS)[number];
