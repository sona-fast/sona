import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { clearSettingsCache } from '$lib/server/settings';
import { URL_COLUMNS } from '$lib/server/storage/referenced-urls';
import * as schema from '$lib/server/db/schema';
import { actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

const CDN = 'https://cdn.example.com';
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
});

// REGRESSION: clearCache once computed "referenced" as only images.imageUrl and
// then treated the ENTIRE bucket as candidates — pressing the button would have
// deleted every sticker file+thumbnail, image thumbnail, avatar and cover as an
// "orphan". This seeds all of those and asserts only a true orphan is deleted.
describe('settings clearCache action', () => {
	it('deletes ONLY true orphans — stickers, thumbnails, avatars, covers and settings avatar survive', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
		// Minimal URL-column-only tables, generated from the collector's source list.
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
			const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
			sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
		}
		const seedSetting = sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
		seedSetting.run('storageProvider', 'r2');
		seedSetting.run('r2PublicUrl', CDN);
		seedSetting.run('adminAvatarUrl', `${CDN}/avatars/admin.png`);
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, source_post_url) VALUES (?, ?, ?)')
			.run(`${CDN}/img.png`, `${CDN}/img.thumb.webp`, null);
		sqlite
			.prepare('INSERT INTO stickers (image_url, thumbnail_url) VALUES (?, ?)')
			.run(`${CDN}/stickers/s1.webp`, `${CDN}/stickers/s1.thumb.webp`);
		sqlite.prepare('INSERT INTO artists (avatar_url) VALUES (?)').run(`${CDN}/avatars/a1.png`);
		sqlite.prepare('INSERT INTO collections (cover_image_url) VALUES (?)').run(`${CDN}/covers/c1.png`);

		// The bucket holds every referenced object plus one true orphan (old
		// enough to pass the 1h gate) and one fresh orphan (an in-flight upload —
		// must be protected by the gate).
		const old = new Date(Date.now() - 10 * HOUR);
		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({
				objects: [
					{ key: 'img.png', uploaded: old },
					{ key: 'img.thumb.webp', uploaded: old },
					{ key: 'stickers/s1.webp', uploaded: old },
					{ key: 'stickers/s1.thumb.webp', uploaded: old },
					{ key: 'avatars/a1.png', uploaded: old },
					{ key: 'avatars/admin.png', uploaded: old },
					{ key: 'covers/c1.png', uploaded: old },
					{ key: 'true-orphan.png', uploaded: old },
					{ key: 'in-flight-upload.png', uploaded: new Date() }
				],
				truncated: false
			}))
		};
		const platform = { env: { DB: makeD1(sqlite), IMAGES: bucket } } as unknown as App.Platform;

		const result = await actions.clearCache({ platform } as never);

		expect(result).toEqual({ success: true, message: 'Deleted 1 orphaned file.' });
		expect(bucket.delete).toHaveBeenCalledTimes(1);
		expect(bucket.delete).toHaveBeenCalledWith(['true-orphan.png']);
	});

	// REGRESSION: a configured provider failing mid-cleanup used to be swallowed
	// as "not configured" — the admin was told success while nothing was cleaned.
	it('surfaces a provider failure as fail(500) instead of a false success', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
			const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
			sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
		}
		const seedSetting = sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
		seedSetting.run('storageProvider', 'r2');
		seedSetting.run('r2PublicUrl', CDN);

		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => {
				throw new Error('R2 list timed out');
			})
		};
		const platform = { env: { DB: makeD1(sqlite), IMAGES: bucket } } as unknown as App.Platform;

		const result = await actions.clearCache({ platform } as never);

		expect(result).toMatchObject({ status: 500 });
		expect((result as { data: { error: string } }).data.error).toContain('r2: R2 list timed out');
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});

// REGRESSION: the backup export once silently omitted content tables (v1 lacked
// conventions, fursuit photos, and the stickers tables). Pin the export at v2 AND
// derive the expected content-table set from the live schema minus the tables we
// deliberately exclude — so a future table someone forgets to export makes this
// fail rather than shipping an incomplete backup.
describe('settings export action', () => {
	// Auth tokens (sessions) and regenerable telemetry (observability tables) are
	// intentionally not part of a content backup; site_settings is exported as the
	// mapped `settings` object, not a raw table dump.
	const EXCLUDED_TABLES = new Set([
		'site_settings',
		'sessions',
		'metric_rollup',
		'error_sample',
		'job_run'
	]);
	const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

	// Build the full schema by replaying every migration, so `db.select().from(t)`
	// finds real columns for each content table (empty rows are fine here).
	function buildFullDb() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sqlite: any = new Database(':memory:');
		const dir = new URL('../../../../drizzle/', import.meta.url);
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
			const sql = readFileSync(new URL(file, dir), 'utf8');
			for (const stmt of sql.split('--> statement-breakpoint')) sqlite.exec(stmt);
		}
		return sqlite;
	}

	it('exports version 2 with every content table (minus the deliberate exclusions)', async () => {
		const sqlite = buildFullDb();
		const platform = { env: { DB: makeD1(sqlite) } } as unknown as App.Platform;

		const result = await actions.export({ platform } as never);
		const backup = JSON.parse((result as { export: string }).export);

		expect(backup.version).toBe(2);

		const expectedContentKeys = Object.values(schema)
			.filter((v) => is(v, SQLiteTable))
			.map((t) => getTableName(t as SQLiteTable))
			.filter((name) => !EXCLUDED_TABLES.has(name))
			.map(snakeToCamel)
			.sort();
		const contentKeys = Object.keys(backup)
			.filter((k) => !['version', 'exportedAt', 'settings'].includes(k))
			.sort();

		expect(contentKeys).toEqual(expectedContentKeys);
	});
});

// Feed key lifecycle (SONA-172). The key is a bearer credential for the adult
// feed, so when it is minted and when it is REPLACED are the whole security
// story: a mint on every save would break every subscribed reader silently.
describe('RSS feed key', () => {
	function settingsDb() {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
		return {
			sqlite,
			platform: { env: { DB: makeD1(sqlite) } } as unknown as App.Platform,
			read: (key: string) =>
				(sqlite.prepare('SELECT value FROM site_settings WHERE key = ?').get(key) as
					| { value: string }
					| undefined)?.value
		};
	}

	/** Post the site form with only the RSS fields a real submission carries. */
	async function saveSite(platform: App.Platform, fields: Record<string, string>) {
		const data = new FormData();
		for (const [k, v] of Object.entries(fields)) data.append(k, v);
		return actions.saveSite({
			platform,
			request: new Request('https://taro.surf/admin/settings?/saveSite', {
				method: 'POST',
				body: data
			}),
			url: new URL('https://taro.surf/admin/settings')
		} as never);
	}

	it('mints a key on the save that first enables the NSFW feed', async () => {
		const { platform, read } = settingsDb();
		await saveSite(platform, {
			rssFeedEnabledPresent: '1',
			rssFeedEnabled: 'on',
			rssNsfwEnabledPresent: '1',
			rssNsfwEnabled: 'on'
		});
		expect(read('rssNsfwEnabled')).toBe('true');
		expect(read('rssNsfwKey')).toMatch(/^[0-9a-f]{32}$/);
	});

	it('keeps the same key across later saves', async () => {
		// A re-mint per save would silently break every reader already subscribed.
		const { platform, read } = settingsDb();
		const on = { rssNsfwEnabledPresent: '1', rssNsfwEnabled: 'on' };
		await saveSite(platform, on);
		const first = read('rssNsfwKey');
		await saveSite(platform, on);
		expect(read('rssNsfwKey')).toBe(first);
	});

	it('mints nothing while the NSFW feed stays off', async () => {
		const { platform, read } = settingsDb();
		await saveSite(platform, { rssNsfwEnabledPresent: '1' });
		expect(read('rssNsfwEnabled')).toBe('false');
		expect(read('rssNsfwKey')).toBeUndefined();
	});

	it('keeps the key when the NSFW feed is turned back off', async () => {
		// An owner who toggles it off and on again keeps the address they already
		// gave their reader; only Regenerate replaces it.
		const { platform, read } = settingsDb();
		await saveSite(platform, { rssNsfwEnabledPresent: '1', rssNsfwEnabled: 'on' });
		const minted = read('rssNsfwKey');
		await saveSite(platform, { rssNsfwEnabledPresent: '1' });
		expect(read('rssNsfwEnabled')).toBe('false');
		expect(read('rssNsfwKey')).toBe(minted);
	});

	it('leaves the toggle alone when the form does not carry it', async () => {
		// The absent-means-unmanaged rule (#60): the NSFW row is only rendered
		// while the master toggle is on, so turning the feed off must not read as
		// "the owner also revoked the NSFW opt-in".
		const { platform, read } = settingsDb();
		await saveSite(platform, { rssNsfwEnabledPresent: '1', rssNsfwEnabled: 'on' });
		await saveSite(platform, { rssFeedEnabledPresent: '1' });
		expect(read('rssFeedEnabled')).toBe('false');
		expect(read('rssNsfwEnabled')).toBe('true');
	});

	it('replaces the key on regenerate, killing the old address', async () => {
		const { platform, read } = settingsDb();
		await saveSite(platform, { rssNsfwEnabledPresent: '1', rssNsfwEnabled: 'on' });
		const before = read('rssNsfwKey');

		const result = await actions.regenerateFeedKey({ platform } as never);
		const after = read('rssNsfwKey');
		expect(after).toMatch(/^[0-9a-f]{32}$/);
		expect(after).not.toBe(before);
		// The key rides back in the result: the page shows the new address from
		// this value instead of reloading its data. Drop it and the address on
		// screen silently keeps pointing at the address that just died.
		expect(result).toEqual({ success: true, feedKey: after });
	});

	// Regenerate must not rerun the load. The load feeds a $effect that reassigns
	// every Site-tab field from the server, so an owner who types a new site name
	// and then regenerates the key would watch the name revert with no warning.
	it('shows the new address without reloading the page data', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const handler = src.split('<form id="regenerate-feed-key"')[1]?.split('</form>')[0] ?? '';
		expect(handler).toContain('use:enhance');
		// Neither route back into the load: update() reruns it, invalidateAll is
		// the same thing spelled out.
		expect(handler).not.toContain('update(');
		expect(handler).not.toContain('invalidateAll');
		// The success arm takes the minted key from the result instead of reloading.
		expect(handler).toMatch(/result\.type === 'success'/);
		expect(handler).toContain('result.data?.feedKey');
		expect(handler).toMatch(/regeneratedKey = key/);
		// Everything else still has to be handed to applyAction by hand: skipping
		// update() also skips the applyAction it would have run, so a failed D1
		// write (`error`) and an expired session (`redirect`) would both vanish and
		// the button would look inert while the leaked key stayed live.
		expect(handler).toMatch(/else\s*\{[\s\S]*?applyAction\(result\)/);
		expect(src).toMatch(/import \{[^}]*\bapplyAction\b[^}]*\} from '\$app\/forms'/);
		// And the displayed address prefers that key over the loaded one.
		expect(src).toMatch(/regeneratedKey \?\? data\.settings\.rssNsfwKey/);
		// Until a load actually completes: the resync effect drops the local key so
		// a key another tab has already replaced can't outlive its own data.
		const resync = src.split('// Sync from server when data changes')[1]?.split('});')[0] ?? '';
		expect(resync).toMatch(/regeneratedKey = null/);
	});

	// The Regenerate control destroys a working address, so it must never be what
	// Enter in a Site-tab text field triggers. Associating it with a separate form
	// by id is what keeps it out of the site form's default-submit position;
	// switching it back to formaction would silently make it the default again.
	it('keeps the regenerate button out of the site form default submit', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(src).toMatch(/<form id="regenerate-feed-key"[^>]*action="\?\/regenerateFeedKey"/);
		expect(src).toMatch(/type="submit"\s+form="regenerate-feed-key"/);
		// No formaction anywhere: that is the shape that would re-break it.
		expect(src).not.toContain('formaction');
	});

	// The two nested {#if}s are the UI half of the gate. Nothing executes them in
	// a unit test, and flattening either one shows an owner a control that cannot
	// work — an NSFW checkbox for a feed that 404s, or a key row before the save
	// that mints the key.
	it('nests the NSFW row inside the master toggle, and the key row inside both', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const section = src.split('{m.admin_settings_rss_heading()}')[1]?.split('</section>')[0] ?? '';
		// Order in the source is the nesting: master opens, then the NSFW row, then
		// the key gate.
		const master = section.search(/\{#if\s+rssFeedEnabled\}/);
		const nsfwRow = section.search(/name="rssNsfwEnabled"/);
		const keyGate = section.search(/\{#if\s+feedKeyVisible\}/);
		expect(master).toBeGreaterThan(-1);
		expect(nsfwRow).toBeGreaterThan(master);
		expect(keyGate).toBeGreaterThan(nsfwRow);
		// That gate reads the STORED setting, not the checkbox: the key is minted
		// by the save. One derived feeds both it and the describedby wiring below,
		// so the two can't drift into describing an element that isn't rendered.
		expect(src).toMatch(
			/feedKeyVisible = \$derived\([\s\S]{0,40}data\.settings\.rssNsfwEnabled && feedKeyUrl/
		);
		// And the key row is what sits inside that innermost gate.
		expect(section.search(/<CopyCommand/)).toBeGreaterThan(keyGate);
		// The pre-save arm: ticked but nothing minted yet. Without it the section
		// looks inert, and nothing else in the suite would notice it going.
		const pendingArm = section.search(/\{:else if\s+rssNsfwEnabled\}/);
		expect(pendingArm).toBeGreaterThan(keyGate);
		expect(section.search(/m\.admin_settings_rss_key_pending\(\)/)).toBeGreaterThan(pendingArm);
		// The master hint changes tense with the toggle. Collapsing the ternary to
		// either arm leaves an owner reading about a feed that is not in the state
		// the text describes.
		const hint = section.match(/\{rssFeedEnabled\s*\?([\s\S]*?)\}/)?.[0] ?? '';
		expect(hint).toContain('m.admin_settings_rss_enabled_hint()');
		expect(hint).toContain('m.admin_settings_rss_enabled_hint_off()');
	});

	// A sighted owner who ticks the box sees the "save to create the address"
	// line appear; a screen-reader user only meets it if the checkbox points at
	// it. Both sides are plain strings, so renaming one alone leaves the pointer
	// dangling and nothing else in the suite notices.
	it('announces the pre-save line with the NSFW checkbox that produced it', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const section = src.split('{m.admin_settings_rss_heading()}')[1]?.split('</section>')[0] ?? '';
		expect(section).toMatch(/<p class="feed-key-pending" id="rssNsfwEnabled-pending">/);
		const describedBy = section.match(/aria-describedby=\{([^}]*)\}/)?.[1] ?? '';
		expect(describedBy).toContain('rssNsfwEnabled-desc');
		expect(describedBy).toContain('rssNsfwEnabled-pending');
		// Every id it can name has to resolve to an element in this same section.
		const ids = [...describedBy.matchAll(/'([^']*)'/g)]
			.flatMap((mm) => mm[1].split(/\s+/))
			.filter(Boolean);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(section, `aria-describedby names a missing id: ${id}`).toContain(`id="${id}"`);
	});
});
