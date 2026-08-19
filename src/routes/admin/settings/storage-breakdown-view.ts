import type { BreakdownKind } from '$lib/server/storage/usage-breakdown';
import * as m from '$lib/paraglide/messages';

/**
 * Per-type rows for the storage breakdown table (SONA-192). Fixed order — the
 * bar's segment order is locked to the row order so the color mapping never
 * becomes color-only (WCAG 1.4.1). Must cover BREAKDOWN_KINDS exactly, in
 * order (guarded in storage-breakdown-view.test.ts — a type-only import keeps
 * the server module out of the client bundle).
 */
export const breakdownRows: readonly { kind: BreakdownKind; label: () => string }[] = [
	{ kind: 'artwork', label: m.admin_settings_breakdown_artwork },
	{ kind: 'vrVideo', label: m.admin_settings_breakdown_vr_videos },
	{ kind: 'vrModel', label: m.admin_settings_breakdown_vr_models },
	{ kind: 'sticker', label: m.admin_settings_breakdown_stickers },
	{ kind: 'vrImage', label: m.admin_settings_breakdown_vr_images },
	{ kind: 'fursuit', label: m.admin_settings_breakdown_fursuit },
	{ kind: 'other', label: m.admin_settings_breakdown_avatars_other }
];

/**
 * Share of USED bytes (the bar percentage is share of the limit — the column
 * header disambiguates). Whole percents from 1%, one decimal below it — the
 * two-tier precision is the approved-mock rendering, keep it.
 */
export function sharePct(bytes: number, total: number): string {
	if (total <= 0 || bytes <= 0) return '0%';
	const pct = (bytes / total) * 100;
	return pct >= 1 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/**
 * Usage-warning level for the bar header: 'full' above 95%, 'near' above 80%,
 * null otherwise. Applies in EVERY branch on purpose — gating it on the
 * breakdown would leave the fallback bar's fill color as the only signal, and
 * the worded suffix is what keeps the state readable without color
 * (WCAG 1.4.1). Drives BOTH the percentage's color classes and the suffix.
 */
export function usageWarning(pct: number): 'full' | 'near' | null {
	if (pct <= 80) return null;
	return pct > 95 ? 'full' : 'near';
}
