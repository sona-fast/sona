import { describe, it, expect } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { syncSuccessToast, syncFailureToast } from './sync-toast-view';

describe('syncSuccessToast', () => {
	it('reports the counts on a clean run, with no warning clause', () => {
		const out = syncSuccessToast({ syncCounts: { refreshed: 2, linked: 1 } });
		expect(out).toBe('Sync complete: 2 refreshed, 1 newly linked.');
	});

	it('adds only the failure clause when nothing was rate limited', () => {
		const out = syncSuccessToast({
			syncCounts: { refreshed: 0, linked: 0 },
			syncDegraded: { failed: 1, rateLimited: 0 }
		});
		expect(out).toContain('1 registry call failed this run');
		expect(out).not.toContain('rate limited');
	});

	it('adds only the rate-limit clause when nothing failed', () => {
		const out = syncSuccessToast({
			syncCounts: { refreshed: 0, linked: 0 },
			syncDegraded: { failed: 0, rateLimited: 3 }
		});
		expect(out).toContain('3 registry calls were rate limited this run');
		expect(out).not.toContain('failed this run');
	});

	it('names a fault before back-pressure when a run had both', () => {
		const out = syncSuccessToast({
			syncCounts: { refreshed: 0, linked: 0 },
			syncDegraded: { failed: 2, rateLimited: 5 }
		});
		expect(out).toBe(
			'Sync complete: 0 refreshed, 0 newly linked. 2 registry calls failed this run, so these counts are incomplete. 5 registry calls were rate limited this run and did not complete.'
		);
	});

	// The fallback has no counts sentence to qualify and ends without a period, so a
	// clause stapled to it would read as one run-on sentence.
	it('falls back to the bare complete message with no clauses when counts are absent', () => {
		expect(syncSuccessToast({ syncDegraded: { failed: 2, rateLimited: 1 } })).toBe(
			m.admin_settings_sync_complete()
		);
		expect(syncSuccessToast(undefined)).toBe(m.admin_settings_sync_complete());
	});
});

describe('syncFailureToast', () => {
	// A refused key and an unreachable registry point the operator at different
	// things; the key wording must not be shown when the key is fine.
	it('uses the key wording for a refusal', () => {
		const out = syncFailureToast({ syncRefusedReason: 'invalid fork key' });
		expect(out).toContain("refused this site's key");
		expect(out).toContain('invalid fork key');
	});

	// Phase-neutral on purpose: the same field carries a blocked delta feed (refreshes
	// lost) and blocked lookups (links lost), so the wording claims neither.
	it('uses the unreachable-registry wording, naming no phase', () => {
		const out = syncFailureToast({ syncUpstreamReason: 'HTTP 403' });
		expect(out).toContain("Couldn't reach the shared registry");
		expect(out).toContain('this run is incomplete');
		expect(out).not.toContain("refused this site's key");
	});

	it('prefers the refusal wording when both reasons somehow arrive', () => {
		expect(syncFailureToast({ syncRefusedReason: 'bad key', syncUpstreamReason: 'HTTP 403' })).toContain(
			"refused this site's key"
		);
	});

	it('shows a plain error string when that is all there is', () => {
		expect(syncFailureToast({ error: 'Something went wrong' })).toBe('Something went wrong');
	});

	it('falls back to the generic failure message with no reason at all', () => {
		expect(syncFailureToast({})).toBe(m.admin_settings_sync_failed());
		expect(syncFailureToast(undefined)).toBe(m.admin_settings_sync_failed());
	});
});
