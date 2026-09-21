import * as m from '$lib/paraglide/messages';

/** What the syncNow action returns on a run that finished. */
export interface SyncSuccessData {
	syncCounts?: { refreshed: number; linked: number };
	syncDegraded?: { failed: number; rateLimited: number };
}

/** What it returns on a run that didn't. */
export interface SyncFailureData {
	syncRefusedReason?: string;
	syncUpstreamReason?: string;
	error?: string;
}

/**
 * The "Sync now" success toast, built from localized parts: the action returns
 * counts, not a sentence, so a ja operator doesn't get an English summary with a
 * Japanese warning stapled to it. A run that finished with failed or rate-limited
 * registry calls did less than the counts suggest — say how much, rather than
 * reporting a clean "0 and 0". The two causes stay separate: one is a fault, one is
 * back-pressure.
 *
 * The clauses ride on the counts sentence only. The fallback "Sync complete" ends
 * without a period, so a clause appended to it reads as one run-on sentence.
 */
export function syncSuccessToast(data: SyncSuccessData | undefined): string {
	const counts = data?.syncCounts;
	if (!counts) return m.admin_settings_sync_complete();
	const parts = [m.admin_settings_sync_summary(counts)];
	const degraded = data?.syncDegraded;
	if (degraded?.failed) parts.push(m.admin_settings_sync_degraded({ count: degraded.failed }));
	if (degraded?.rateLimited)
		parts.push(m.admin_settings_sync_rate_limited({ count: degraded.rateLimited }));
	return parts.join(' ');
}

/**
 * The failure toast. A refusal comes back as a reason, not a message: the wording is
 * localized here and only the registry's own text is interpolated. A refused KEY and
 * an unreachable registry get different wording — the first points at this site's
 * connection, the second at nothing the operator can fix.
 */
export function syncFailureToast(data: SyncFailureData | undefined): string {
	if (data?.syncRefusedReason)
		return m.admin_settings_sync_refused({ reason: data.syncRefusedReason });
	if (data?.syncUpstreamReason)
		return m.admin_settings_sync_upstream_failed({ reason: data.syncUpstreamReason });
	return data?.error ?? m.admin_settings_sync_failed();
}
