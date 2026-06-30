import { describe, it, expect, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { getReadDb } from './index';

// getReadDb routes reads through a D1 read-replication session. Two assumptions
// must hold for it to be safe to ship BEFORE replication is enabled:
//  1. It asks for the right session constraint (so public reads hit a replica).
//  2. If the runtime predates the Sessions API (no withSession), it falls back
//     to the primary instead of throwing — i.e. it degrades, never breaks.

/** A D1 stub exposing only what Drizzle's d1 driver touches: prepare + batch. */
function primaryStub() {
	return { prepare: vi.fn(), batch: vi.fn() };
}

/** A D1 stub that also supports the Sessions API. */
function replicatedStub() {
	const session = { prepare: vi.fn(), batch: vi.fn() };
	const withSession = vi.fn(() => session);
	return { prepare: vi.fn(), batch: vi.fn(), withSession };
}

describe('getReadDb', () => {
	it('opens a session with first-unconstrained by default (nearest replica)', () => {
		const d1 = replicatedStub();
		const db = getReadDb(d1 as unknown as D1Database);
		expect(db).toBeDefined();
		expect(d1.withSession).toHaveBeenCalledTimes(1);
		expect(d1.withSession).toHaveBeenCalledWith('first-unconstrained');
	});

	it('honours an explicit first-primary constraint (read-your-writes)', () => {
		const d1 = replicatedStub();
		getReadDb(d1 as unknown as D1Database, 'first-primary');
		expect(d1.withSession).toHaveBeenCalledWith('first-primary');
	});

	it('falls back to the primary when withSession is unavailable', () => {
		const d1 = primaryStub();
		// Must not throw, and must still return a usable db.
		const db = getReadDb(d1 as unknown as D1Database);
		expect(db).toBeDefined();
	});
});
