import * as m from '$lib/paraglide/messages';
import { earlyAccessLabelKey } from '$lib/early-access';

type MessageFn = (inputs?: Record<string, never>, options?: { locale?: 'en' | 'ja' }) => string;

/**
 * A flag's localized display label, resolved through the paraglide messages
 * module via the by-convention id (earlyAccessLabelKey). Falls back to the raw
 * flag slug when the message is missing — a registered flag without its label
 * messages fails early-access.test.ts, so the fallback should never render,
 * but a wrong lookup must degrade to something legible rather than throw.
 */
export function earlyAccessLabel(flag: string, options?: { locale?: 'en' | 'ja' }): string {
	const fn = (m as unknown as Record<string, MessageFn | undefined>)[earlyAccessLabelKey(flag)];
	return fn ? fn({}, options) : flag;
}
