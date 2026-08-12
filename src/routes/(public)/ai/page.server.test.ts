import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { load } from './+page.server';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache } from '$lib/server/settings';

// The /ai disclosure page's toggle gate (SONA-167). The rule the page itself
// claims — visibility decided in the server load, a disabled page
// indistinguishable from a nonexistent one — must hold for the page too. The
// override text is returned by THIS load rather than the shared layout, so a
// disabled fork never ships its retired text to every visitor.

function makePlatform(rows: { key: string; value: string }[] = []) {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	for (const r of rows) {
		sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(r.key, r.value);
	}
	const d1 = makeD1(sqlite);
	return { env: { DB: d1 } } as unknown as App.Platform;
}

function loadWith(aiPageEnabled: boolean, rows: { key: string; value: string }[] = []) {
	return load({
		parent: async () => ({ settings: { aiPageEnabled } }),
		platform: makePlatform(rows)
	} as never);
}

// getSettings caches per isolate; each case seeds its own rows.
beforeEach(() => clearSettingsCache());

describe('/ai load', () => {
	it('serves the page when the toggle is on (the fleet default)', async () => {
		await expect(loadWith(true)).resolves.toMatchObject({ aiPageText: '', aiPageUpdatedAt: '' });
	});

	it('404s the route when a fork turned the page off', async () => {
		await expect(loadWith(false)).rejects.toMatchObject({ status: 404 });
	});

	it("returns the owner's override text and its save stamp", async () => {
		const data = await loadWith(true, [
			{ key: 'aiPageText', value: 'My own words.' },
			{ key: 'aiPageUpdatedAt', value: '2026-08-12' }
		]);
		expect(data).toMatchObject({ aiPageText: 'My own words.', aiPageUpdatedAt: '2026-08-12' });
	});

	// The override is the whole reason this load exists rather than the shared
	// layout: a disabled page must not keep shipping its text anywhere.
	it('never returns override text for a disabled page', async () => {
		await expect(
			loadWith(false, [{ key: 'aiPageText', value: 'Retired copy.' }])
		).rejects.toMatchObject({ status: 404 });
	});

	// The gate re-reads the raw row instead of trusting the parent's flag,
	// because getSettings swallows D1 errors and returns DEFAULTS — where this
	// is the one default-ON boolean. Trusting it would publish an owner's
	// first-person claims on a site that declined them, on any read blip.
	it('fails CLOSED when the settings read throws', async () => {
		const brokenDb = {
			prepare() {
				throw new Error('D1_ERROR: no such table: site_settings');
			}
		} as unknown as App.Platform['env']['DB'];

		await expect(
			load({
				parent: async () => ({ settings: { aiPageEnabled: true } }),
				platform: { env: { DB: brokenDb } } as unknown as App.Platform
			} as never)
		).rejects.toMatchObject({ status: 404 });
	});

	// An explicit stored 'false' outranks the parent flag even when the cached
	// settings object disagrees (a stale isolate, or a fallback to DEFAULTS).
	it('404s on an explicit stored false even if the parent flag says on', async () => {
		await expect(loadWith(true, [{ key: 'aiPageEnabled', value: 'false' }])).rejects.toMatchObject(
			{ status: 404 }
		);
	});
});
