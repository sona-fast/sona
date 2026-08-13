import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearSupporterKeyStatusCache } from '$lib/server/settings';
import { EARLY_ACCESS } from '$lib/early-access';

import { load } from './+page.server';

// A real supporter key can't be minted in tests (the issuer's private key never
// leaves sona.fast), so verification is faked exactly as in the sibling VR
// suites: the literal token 'VALID' verifies, anything else is malformed.
vi.mock('$lib/server/supporter-key', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/supporter-key')>();
	return {
		...original,
		verifySupporterKey: vi.fn(async (token: string) =>
			token === 'VALID'
				? { valid: true, login: 'e2e', tier: 1, expiresAt: new Date('2999-01-01') }
				: { valid: false, reason: 'malformed' }
		)
	};
});

const NOW = '2026-01-01T00:00:00.000Z';

// The gating tests below drive the gate through the registry (same mutation
// pattern as early-access.test.ts) so they never depend on the wall clock.
const SHIPPED = { ...EARLY_ACCESS };
const FUTURE_GA = '2999-01-01';
const PAST_GA = '2000-01-01';
function restoreRegistry() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}
beforeEach(() => {
	restoreRegistry();
	// The gate memoizes the verified supporter key per isolate; every test builds
	// a fresh DB, so the previous test's key would otherwise answer for this one.
	clearSupporterKeyStatusCache();
});
afterEach(restoreRegistry);

// Only the tables the /admin/vr list load touches, columns limited to what its
// queries reference (same shape as the public vr page.server.test.ts).
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
			character_id INTEGER NOT NULL, model_url TEXT, model_format TEXT,
			model_size_bytes INTEGER, poster_image_id INTEGER, external_url TEXT,
			license TEXT, permission_source TEXT, downloadable INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			description TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE avatar_platforms (avatar_id INTEGER NOT NULL, platform TEXT NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			file_size INTEGER, nsfw INTEGER NOT NULL DEFAULT 0
		);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function addAvatar(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	opts: {
		slug: string;
		modelUrl?: string | null;
		modelFormat?: string | null;
		modelSizeBytes?: number | null;
		published?: number;
		nsfw?: number;
		posterImageId?: number | null;
	}
) {
	return sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, model_size_bytes, poster_image_id, published, nsfw, created_at)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.slug,
			opts.slug,
			opts.modelUrl ?? null,
			opts.modelFormat ?? null,
			opts.modelSizeBytes ?? null,
			opts.posterImageId ?? null,
			opts.published ?? 1,
			opts.nsfw ?? 0,
			NOW
		).lastInsertRowid as number;
}

type ListData = {
	publishingEnabled: boolean;
	gaDateDisplay: string | null;
	avatars: Array<{
		slug: string;
		published: boolean;
		platformCount: number;
		hasModel: boolean;
	}>;
	storage: { usedBytes: number; limitBytes: number };
};

async function loadData(platform: App.Platform): Promise<ListData> {
	return (await load({ platform } as never)) as ListData;
}

describe('/admin/vr list load', () => {
	it('lists ALL avatars (drafts included — reading is never gated) with platform counts', async () => {
		const { sqlite, platform } = makeDb();
		const live = addAvatar(sqlite, { slug: 'live' });
		addAvatar(sqlite, { slug: 'draft', published: 0 });
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(live, 'vrchat');
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(live, 'resonite');

		const data = await loadData(platform);
		expect(data.avatars.map((a) => a.slug).sort()).toEqual(['draft', 'live']);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug.live.platformCount).toBe(2);
		expect(bySlug.draft.platformCount).toBe(0);
	});

	it('sums the storage line from tracked image bytes PLUS model bytes (settings-gauge mechanism)', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, file_size) VALUES (?, NULL, ?)')
			.run('/img/a.png', 1000);
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, file_size) VALUES (?, NULL, ?)')
			.run('/img/b.png', 2000);
		addAvatar(sqlite, { slug: 'hosted', modelUrl: '/img/vr-models/a.vrm', modelFormat: 'vrm', modelSizeBytes: 500 });
		addAvatar(sqlite, { slug: 'external' }); // no model — contributes nothing

		const data = await loadData(platform);
		expect(data.storage.usedBytes).toBe(3500);
		expect(data.storage.limitBytes).toBe(10 * 1024 * 1024 * 1024);
	});

	it('is gated pre-GA without a key, and reports the GA date for the gate copy', async () => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(false);
		expect(data.gaDateDisplay).toBe('2999.01.01');
	});

	it('a malformed stored supporter key does not open the gate', async () => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)')
			.run('supporterKey', 'not-a-real-key');
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(false);
	});

	it('a valid key opens the gate for a DB the previous test never saw', async () => {
		// Ordered after the two no-key cases on purpose: the gate memoizes the
		// verified key per isolate, so this passes only because the beforeEach
		// clears it. Drop that clear and this test reads the earlier "no key"
		// answer — which is what made the malformed case above vacuous before.
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { sqlite, platform } = makeDb();
		sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run('supporterKey', 'VALID');
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(true);
	});

	it('is ungated once the GA date has passed', async () => {
		EARLY_ACCESS['vr-avatars'] = PAST_GA;
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(true);
	});

	it('marks a clean avatar Mature when its poster image is NSFW (effective public flag)', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, nsfw) VALUES (1, ?, 1)')
			.run('/img/mature-poster.png');
		addAvatar(sqlite, { slug: 'mature-poster-only', posterImageId: 1 });
		addAvatar(sqlite, { slug: 'own-flag', nsfw: 1 });
		addAvatar(sqlite, { slug: 'clean' });

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect((bySlug['mature-poster-only'] as { nsfw?: unknown }).nsfw).toBe(true);
		expect((bySlug['own-flag'] as { nsfw?: unknown }).nsfw).toBe(true);
		expect((bySlug.clean as { nsfw?: unknown }).nsfw).toBe(false);
		// The join column is server-side input only — the list ships the merged flag.
		expect(JSON.stringify(data.avatars)).not.toContain('posterNsfw');
	});

	it('flags nsfwFromPoster ONLY when the Mature state is poster-inherited (SONA-159)', async () => {
		// Truth table for the chip label: the poster-only case names the source so
		// the edit form's unchecked "Mark as NSFW" toggle doesn't read as broken.
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, nsfw) VALUES (1, ?, 1)')
			.run('/img/mature-poster.png');
		addAvatar(sqlite, { slug: 'poster-only', posterImageId: 1 });
		addAvatar(sqlite, { slug: 'own-flag', nsfw: 1 });
		addAvatar(sqlite, { slug: 'both', nsfw: 1, posterImageId: 1 });
		addAvatar(sqlite, { slug: 'clean' });

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		const flag = (slug: string) => (bySlug[slug] as { nsfwFromPoster?: unknown }).nsfwFromPoster;
		expect(flag('poster-only')).toBe(true);
		// Own flag set: the toggle explains the chip, no poster label needed.
		expect(flag('own-flag')).toBe(false);
		expect(flag('both')).toBe(false);
		expect(flag('clean')).toBe(false);
	});

	it('ships hasPermission as a boolean, never the recorded grant text (R2-S3)', async () => {
		// Only presence feeds the Download column; the permission_source prose
		// (names, dates, DM references) has no reason to reach the client.
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { slug: 'granted' });
		sqlite
			.prepare('UPDATE vr_avatars SET permission_source = ? WHERE id = ?')
			.run('Telegram DM 2026-08-01 with @artist', id);
		addAvatar(sqlite, { slug: 'ungranted' });

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect((bySlug.granted as { hasPermission?: unknown }).hasPermission).toBe(true);
		expect((bySlug.ungranted as { hasPermission?: unknown }).hasPermission).toBe(false);
		expect(JSON.stringify(data.avatars)).not.toContain('Telegram DM');
	});
});
