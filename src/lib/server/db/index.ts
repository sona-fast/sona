import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from './schema';

export function getDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

/**
 * Session constraint for D1 read replication.
 * - 'first-unconstrained': route to the nearest replica; reads may be slightly
 *   stale. Use for read-only public paths where that's fine.
 * - 'first-primary': route the first read to the primary (always latest). Use
 *   when the request must see the most recent writes.
 */
export type ReadConstraint = 'first-unconstrained' | 'first-primary';

/**
 * A read-optimized DB bound to a D1 read-replication session. When replication
 * is enabled on the database, reads can be served by the nearest replica,
 * cutting round-trip latency. When replication is NOT enabled, the Sessions API
 * still works — it transparently routes to the primary — so this is safe to ship
 * before flipping replication on, and is a no-op regression risk if it's off.
 *
 * Drizzle's D1 driver only calls `.prepare()` / `.batch()` on the client, both of
 * which a D1DatabaseSession provides, so the session stands in for a D1Database.
 */
export function getReadDb(d1: D1Database, constraint: ReadConstraint = 'first-unconstrained') {
	// Guard for older runtimes that predate the Sessions API.
	if (typeof (d1 as { withSession?: unknown }).withSession !== 'function') {
		return drizzle(d1, { schema });
	}
	const session = d1.withSession(constraint);
	return drizzle(session as unknown as D1Database, { schema });
}

export type Database = ReturnType<typeof getDb>;
