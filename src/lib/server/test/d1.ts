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
