import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from './db';
import {
	recordMetric,
	recordError,
	recordJobRun,
	recordRequestOutcome,
	dayKey,
	routeClass,
	isAssetPath,
	ERROR_SAMPLE_CAP
} from './metrics';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses,
// same approach as the other server tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) return { results: stmt.all(...params), success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw')
			})
		};
	}
	return { prepare } as unknown as D1Database;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSqlite(): any {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE metric_rollup (
			day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '',
			count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim)
		);
		CREATE TABLE error_sample (
			id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, route TEXT NOT NULL,
			status INTEGER NOT NULL, message TEXT NOT NULL
		);
		CREATE TABLE job_run (
			name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT
		);
	`);
	return sqlite;
}

describe('metrics — pure helpers', () => {
	it('dayKey is the UTC YYYY-MM-DD prefix', () => {
		expect(dayKey(new Date('2026-07-06T23:59:59Z'))).toBe('2026-07-06');
	});

	it('routeClass buckets by prefix', () => {
		expect(routeClass('/admin/observability')).toBe('admin');
		expect(routeClass('/api/upload')).toBe('api');
		expect(routeClass('/gallery')).toBe('public');
	});

	it('isAssetPath matches _app and favicons only', () => {
		expect(isAssetPath('/_app/immutable/x.js')).toBe(true);
		expect(isAssetPath('/favicon.ico')).toBe(true);
		expect(isAssetPath('/gallery')).toBe(false);
	});
});

describe('recordMetric — bounded UPSERT', () => {
	it('increments the SAME (day, metric, dim) row instead of inserting a new one', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'public', 3); // explicit n

		const rows = sqlite.prepare('SELECT day, metric, dim, count FROM metric_rollup').all();
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(5);
		expect(rows[0].day).toBe(dayKey());
	});

	it('keeps different dims as separate rows', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'admin');
		await recordMetric(db, 'upload', 'ok');

		const rows = sqlite.prepare("SELECT count FROM metric_rollup WHERE metric='request'").all();
		expect(rows).toHaveLength(2);
		const total = sqlite.prepare('SELECT SUM(count) c FROM metric_rollup').get();
		expect(total.c).toBe(3);
	});
});

describe('recordError — capped ring', () => {
	it('stores route + status + a trimmed message and prunes beyond the cap', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// One well past the cap to force a prune.
		const n = ERROR_SAMPLE_CAP + 5;
		for (let i = 0; i < n; i++) {
			await recordError(db, { route: `/r/${i}`, status: 500, message: `err ${i}` });
		}

		const { c } = sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get();
		expect(c).toBe(ERROR_SAMPLE_CAP);
		// The oldest 5 were pruned; the newest survive (highest ids kept).
		const min = sqlite.prepare('SELECT MIN(id) m FROM error_sample').get();
		expect(min.m).toBe(6);
	});

	it('collapses whitespace and clamps very long messages', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, { route: 'upload', status: 413, message: 'line one\n\n   line two' });
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('line one line two');

		await recordError(db, { route: 'x', status: 500, message: 'z'.repeat(500) });
		const rows = sqlite.prepare('SELECT message FROM error_sample ORDER BY id DESC').all();
		expect(rows[0].message.length).toBeLessThanOrEqual(300);
	});
});

describe('recordRequestOutcome', () => {
	it('counts the request; on a 5xx also counts an error and drops one sample', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordRequestOutcome(db, { routeClass: 'public', status: 200, route: '/gallery' });
		await recordRequestOutcome(db, { routeClass: 'admin', status: 500, route: '/admin/images', message: 'boom' });

		const req = sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='request'").get();
		expect(req.c).toBe(2);
		const err = sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='error'").get();
		expect(err.c).toBe(1);
		const samples = sqlite.prepare('SELECT route, status FROM error_sample').all();
		expect(samples).toEqual([{ route: '/admin/images', status: 500 }]);
	});
});

describe('recordJobRun — heartbeat upsert', () => {
	it('keeps one row per job, overwriting with the latest run', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordJobRun(db, 'cleanup-orphans', 'ok', 'deleted 3');
		await recordJobRun(db, 'cleanup-orphans', 'failed', 'R2 error');

		const rows = sqlite.prepare('SELECT name, status, detail FROM job_run').all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'cleanup-orphans', status: 'failed', detail: 'R2 error' });
	});
});
