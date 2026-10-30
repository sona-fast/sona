// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { isRedirect } from '@sveltejs/kit';
import { EARLY_ACCESS } from '$lib/early-access';
import { makeD1 } from './d1';

// Shared by the commission ledger route suites (SONA-236). Every migration,
// applied in order with foreign keys on as D1 runs them, so the actions write
// against the shipped schema rather than hand-written tables.

const dir = new URL('../../../../drizzle/', import.meta.url);

export type Sqlite = {
	prepare: (sql: string) => {
		run: (...args: unknown[]) => { lastInsertRowid: number | bigint };
		get: (...args: unknown[]) => unknown;
		all: (...args: unknown[]) => unknown[];
	};
	exec: (sql: string) => void;
	pragma: (sql: string) => unknown;
};

/** A migrated DB seeded with two artists (1, 2) and two characters (1, 2). */
export function ledgerDb(): { sqlite: Sqlite; platform: App.Platform } {
	const sqlite = new Database(':memory:') as Sqlite;
	sqlite.pragma('foreign_keys = ON');
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		for (const stmt of readFileSync(new URL(name, dir), 'utf8').split('--> statement-breakpoint')) sqlite.exec(stmt);
	}
	sqlite.exec(`
		INSERT INTO artists (id, name, created_at) VALUES (1, 'Artist A', '2026-10-01'), (2, 'Artist B', '2026-10-01');
		INSERT INTO characters (id, name, created_at) VALUES (1, 'Kit', '2026-10-01'), (2, 'Pip', '2026-10-01');
	`);
	return { sqlite, platform: { env: { DB: makeD1(sqlite) } } as unknown as App.Platform };
}

/** Inserts an entry straight into the table and returns its id. */
export function seedEntry(
	sqlite: Sqlite,
	fields: Partial<{
		artistId: number;
		title: string;
		status: string;
		payment: string;
		notes: string | null;
		requestedOn: string | null;
		acceptedOn: string | null;
		deliveredOn: string | null;
		priceMinor: number | null;
		currency: string | null;
		updatedAt: string;
		characterIds: number[];
	}> = {}
): number {
	const stamp = fields.updatedAt ?? '2026-10-01T00:00:00.000Z';
	const id = Number(
		sqlite
			.prepare(
				`INSERT INTO commissions (artist_id, title, status, payment, notes, requested_on, accepted_on, delivered_on,
					price_minor, currency, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				fields.artistId ?? 1,
				fields.title ?? 'Ref sheet update',
				fields.status ?? 'applied',
				fields.payment ?? 'unpaid',
				fields.notes ?? null,
				fields.requestedOn ?? null,
				fields.acceptedOn ?? null,
				fields.deliveredOn ?? null,
				fields.priceMinor ?? null,
				fields.currency ?? null,
				stamp,
				stamp
			).lastInsertRowid
	);
	for (const characterId of fields.characterIds ?? []) {
		sqlite.prepare('INSERT INTO commission_characters (commission_id, character_id) VALUES (?, ?)').run(id, characterId);
	}
	return id;
}

export function rows(sqlite: Sqlite, sql: string, ...args: unknown[]) {
	return sqlite.prepare(sql).all(...args);
}

/** Every row of both ledger tables, to compare before and after a refused write. */
export function ledgerSnapshot(sqlite: Sqlite) {
	return {
		commissions: rows(sqlite, 'SELECT * FROM commissions ORDER BY id'),
		links: rows(sqlite, 'SELECT * FROM commission_characters ORDER BY commission_id, character_id')
	};
}

/** A form with every field valid; overrides replace fields, and `undefined`
 * drops one. `characterId` takes an array for the multi-value field. */
export function entryForm(overrides: Record<string, string | string[] | undefined> = {}): FormData {
	const values: Record<string, string | string[] | undefined> = {
		artistId: '1',
		title: 'Ref sheet update',
		kind: 'Ref sheet',
		sourceUrl: 'https://t.me/artist_a/412',
		characterId: ['1'],
		status: 'applied',
		payment: 'unpaid',
		price: '120.00',
		currency: 'USD',
		notes: 'Two outfits, front and back views.',
		requestedOn: '2026-10-02',
		acceptedOn: '',
		deliveredOn: '',
		...overrides
	};
	const form = new FormData();
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) continue;
		for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
	}
	return form;
}

/** Runs a form action and reports its status (200 for data returned on
 * success), 'redirected', and any data. */
export async function runAction(
	action: (event: never) => unknown,
	{ platform, id, form }: { platform: App.Platform; id?: string; form?: FormData }
): Promise<{ status: number | 'redirected'; data: Record<string, unknown> }> {
	const url = new URL(`http://localhost/admin/commissions/${id ?? 'new'}`);
	const request = new Request(url, { method: 'POST', body: form ?? new FormData() });
	try {
		const result = (await action({ request, platform, params: id === undefined ? {} : { id }, url } as never)) as
			| { status: number; data: Record<string, unknown> }
			| Record<string, unknown>
			| undefined;
		// A refusal is an ActionFailure; a success that returns data answers 200.
		if (result && 'status' in result && 'data' in result) {
			return { status: result.status as number, data: result.data as Record<string, unknown> };
		}
		return result ? { status: 200, data: result } : { status: 'redirected', data: {} };
	} catch (e) {
		if (isRedirect(e)) return { status: 'redirected', data: {} };
		throw e;
	}
}

const SHIPPED = { ...EARLY_ACCESS };
const LABEL = () => 'Commission ledger';

/** Puts the ledger's GA date in the future (gate closed without a key) or the
 * past (open to everyone), so no test depends on the wall clock. */
export function setLedgerGa(when: 'future' | 'past') {
	EARLY_ACCESS['commission-ledger'] = { gaDate: when === 'future' ? '2999-01-01' : '2000-01-01', label: LABEL };
}

export function restoreRegistry() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}
