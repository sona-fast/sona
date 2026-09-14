import type { D1Database } from '@cloudflare/workers-types';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses
// (client.prepare().bind().run()/all()/raw(), plus batch() in a transaction with
// D1's all-or-nothing semantics). Shared by the *.test.ts suites so the shim
// lives in one place instead of being copy-pasted per file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeD1(sqlite: any): D1Database {
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
		return {
			results: [],
			success: true,
			meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) }
		};
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw'),
				_run: () => exec(sql, params, 'run')
			})
		};
	}
	async function batch(statements: Array<{ _run: () => unknown }>) {
		return sqlite.transaction((stmts: Array<{ _run: () => unknown }>) =>
			stmts.map((s) => s._run())
		)(statements);
	}
	return { prepare, batch } as unknown as D1Database;
}

/**
 * The same D1 with every site_settings read failing. A page load that resolves
 * the FuzzySearch key reads that table, and asking what the load does when the
 * read fails is otherwise only answerable by mocking the module the key comes
 * from. Every other table still answers, so what the test sees is the key read
 * failing and not a database that is gone.
 */
export function withFailingSettingsRead(d1: D1Database): D1Database {
	const real = d1 as unknown as {
		prepare: (sql: string) => unknown;
		batch: (...args: unknown[]) => unknown;
	};
	function prepare(sql: string) {
		if (!sql.includes('site_settings')) return real.prepare(sql);
		const fail = () => {
			throw new Error('D1_ERROR: settings read failed');
		};
		// The terminals sit beside bind, not only behind it. A settings read with
		// no parameters calls them straight off the statement, and a stub that
		// only answers bind throws a TypeError there — which a test asserting on
		// the D1 failure would either miss or credit to the wrong cause.
		const terminals = { run: fail, all: fail, raw: fail, first: fail, _run: fail };
		return { bind: () => terminals, ...terminals };
	}
	// Forwarded rather than handed out directly: passing the method itself
	// detaches it from the D1 it belongs to, so a caller batching statements gets
	// a `this` error instead of a batch.
	return { prepare, batch: (...args: unknown[]) => real.batch(...args) } as unknown as D1Database;
}
