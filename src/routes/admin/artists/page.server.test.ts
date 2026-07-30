import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';

// submitToRegistry's registry call is the one thing we don't want to hit for real;
// stub just that export and keep the rest of the module (isRegistryEnabled,
// resolveRegistryEnv, …) intact so load's tests still exercise the real code.
const { mockRegistrySubmit } = vi.hoisted(() => ({ mockRegistrySubmit: vi.fn() }));
vi.mock('$lib/server/registry', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/registry')>()),
	registrySubmit: mockRegistrySubmit
}));

import { load, actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
	);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);
	CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function loadEvent(platform: App.Platform, q?: string) {
	const url = new URL('http://localhost/admin/artists');
	if (q !== undefined) url.searchParams.set('q', q);
	return { platform, url } as never;
}

// The registry itself must never be hit from tests: fail every fetch so the
// client's graceful-degradation fallbacks (empty submissions/catalog) apply.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// Route registry HTTP calls by URL substring so the REAL client code runs
// against canned responses; anything unrouted still fails like the default stub.
function stubRegistryFetch(routes: Record<string, unknown>) {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL) => {
			const url = String(input);
			for (const [needle, body] of Object.entries(routes)) {
				if (url.includes(needle)) return Promise.resolve(new Response(JSON.stringify(body)));
			}
			return Promise.reject(new Error('offline'));
		})
	);
}

describe('admin artists load — registry enablement', () => {
	it('reports registryEnabled with a D1-stored fork key and no env secret', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: true });
	});

	it('reports registry disabled when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: false });
	});
});

describe('admin artists load — former names (aliases)', () => {
	it('exposes parsed alias display names as formerly, skipping the current name', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({
			name: 'Zaps',
			aliases: JSON.stringify([
				{ displayName: 'Boltie', socials: {} },
				// Identical to the current display name (case-insensitively) — must be skipped.
				{ displayName: 'zaps', socials: {} }
			])
		});

		// load's SvelteKit signature admits void; the cast narrows to the data shape.
		const result = (await load(loadEvent(platform))) as { artists: Array<{ formerly: string[] }> };
		expect(result.artists).toHaveLength(1);
		expect(result.artists[0].formerly).toEqual(['Boltie']);
	});

	it('exposes an empty formerly for artists without aliases or with malformed JSON', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({ name: 'NoAka' });
		await db.insert(schema.artists).values({ name: 'BadJson', aliases: 'not-json{' });

		const result = (await load(loadEvent(platform))) as { artists: Array<{ formerly: string[] }> };
		expect(result.artists.map((a) => a.formerly)).toEqual([[], []]);
	});
});

describe('admin artists load — server-side search matches AKA names', () => {
	// Zaps was formerly "Boltie"; the alias JSON also carries a social URL we must
	// NOT match on. Nova is an unrelated artist used to prove the search narrows.
	async function seedRenamedArtist(db: ReturnType<typeof makeDb>['db']) {
		await db.insert(schema.artists).values({
			name: 'Zaps',
			aliases: JSON.stringify([{ displayName: 'Boltie', socials: { twitter: 'https://x.com/boltie' } }])
		});
		await db.insert(schema.artists).values({ name: 'Nova' });
	}

	it('finds an artist by a former (alias) display name', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);

		const result = (await load(loadEvent(platform, 'boltie'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Zaps']);
		// Count query shares the widened where — it must reflect the alias hit too.
		expect(result.total).toBe(1);
	});

	it('does NOT match on a URL buried inside the aliases JSON (precision)', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);

		const result = (await load(loadEvent(platform, 'x.com'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists).toHaveLength(0);
		expect(result.total).toBe(0);
	});

	it('still matches on the current name, and tolerates NULL/malformed aliases', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);
		// A malformed-JSON aliases row must not make json_each throw for the query.
		await db.insert(schema.artists).values({ name: 'BadJson', aliases: 'not-json{' });

		const result = (await load(loadEvent(platform, 'zaps'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Zaps']);
		expect(result.total).toBe(1);
	});

	// Valid-JSON shapes that json_extract would throw on (bare scalar element,
	// top-level scalar, top-level object) if the query drilled into them
	// unguarded — each must return cleanly with no match and no 500.
	it.each([
		['bare-string array element', '["Boltie"]'],
		['top-level string scalar', '"Boltie"'],
		['array mixing an object and a bare string', '[{"displayName":"Nope"},"Boltie"]'],
		['top-level object with a nested displayName', '{"foo":{"displayName":"Boltie"}}']
	])('does not throw or match on a %s', async (_label, aliases) => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({ name: 'Odd', aliases });

		const result = (await load(loadEvent(platform, 'boltie'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists).toHaveLength(0);
		expect(result.total).toBe(0);
	});

	it('returns one row when q matches both the current name and an alias', async () => {
		const { db, platform } = makeDb();
		// "Bolt" appears in both the current name and the former name — the OR must
		// not double-count the row.
		await db.insert(schema.artists).values({
			name: 'Boltz',
			aliases: JSON.stringify([{ displayName: 'Boltie', socials: {} }])
		});

		const result = (await load(loadEvent(platform, 'bolt'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Boltz']);
		expect(result.total).toBe(1);
	});

	it('matches when only the SECOND of multiple aliases is the hit', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({
			name: 'Zaps',
			aliases: JSON.stringify([
				{ displayName: 'Alpha', socials: {} },
				{ displayName: 'Boltie', socials: {} }
			])
		});

		const result = (await load(loadEvent(platform, 'boltie'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Zaps']);
		expect(result.total).toBe(1);
	});
});

describe('admin artists load — approved-submission linking stamps registry_version (#71)', () => {
	// An approved CREATE submission (matched by display name) whose approval
	// linked it to g-1 — the aliased/AKA approval shape looks the same to the fork.
	const approvedSub = {
		id: 5,
		kind: 'create',
		targetGlobalId: null,
		payload: JSON.stringify({ displayName: 'Nyx' }),
		matchedGlobalId: 'g-1',
		status: 'approved',
		reviewerNote: null,
		createdAt: '2026-01-01T00:00:00Z',
		decidedAt: '2026-01-02T00:00:00Z'
	};
	const catalogEntry = {
		globalId: 'g-1',
		displayName: 'Nyx',
		avatarUrl: null,
		bio: null,
		socials: {},
		status: 'active',
		mergedInto: null,
		version: 7,
		updatedAt: '2026-01-02T00:00:00Z'
	};

	it('stamps registryVersion alongside globalId when the catalog has the entry', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		await db.insert(schema.artists).values({ name: 'Nyx' });
		stubRegistryFetch({
			'/v1/submissions/mine': { submissions: [approvedSub] },
			'/v1/artists?': { artists: [catalogEntry], nextCursor: null }
		});

		await load(loadEvent(platform));

		const row = await db.select().from(schema.artists).get();
		expect(row!.globalId).toBe('g-1');
		expect(row!.registryVersion).toBe(7); // the next share submits baseVersion 7
	});

	it('still links (version null) when the catalog entry carries a non-numeric version', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		await db.insert(schema.artists).values({ name: 'Nyx' });
		// A malformed catalog response must not stamp garbage into the integer column.
		stubRegistryFetch({
			'/v1/submissions/mine': { submissions: [approvedSub] },
			'/v1/artists?': { artists: [{ ...catalogEntry, version: '7' }], nextCursor: null }
		});

		await load(loadEvent(platform));

		const row = await db.select().from(schema.artists).get();
		expect(row!.globalId).toBe('g-1');
		expect(row!.registryVersion).toBeNull();
	});

	it('still links (version null) when the catalog fetch fails — the submit backstop heals it', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		await db.insert(schema.artists).values({ name: 'Nyx' });
		// Only the submissions endpoint responds; the delta/catalog fetch stays offline.
		stubRegistryFetch({ '/v1/submissions/mine': { submissions: [approvedSub] } });

		await load(loadEvent(platform));

		const row = await db.select().from(schema.artists).get();
		expect(row!.globalId).toBe('g-1');
		expect(row!.registryVersion).toBeNull();
	});
});

describe('admin artists load — alias-linked share guard (#71)', () => {
	// Survivor "Funereal" absorbed "CinnamonServal" as an AKA: the local row keeps
	// the alias name but is linked to the survivor's globalId.
	const survivor = {
		globalId: 'g-1',
		displayName: 'Funereal',
		avatarUrl: null,
		bio: null,
		socials: {},
		aliases: [{ displayName: 'CinnamonServal', socials: {} }],
		status: 'active',
		mergedInto: null,
		version: 3,
		updatedAt: '2026-01-02T00:00:00Z'
	};

	async function seedLinked(db: ReturnType<typeof makeDb>['db'], name: string) {
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		await db.insert(schema.artists).values({ name, globalId: 'g-1', registryVersion: 3 });
	}

	it('marks aliasLinked (with the registry name) when the local name matches an alias, case-insensitively', async () => {
		const { db, platform } = makeDb();
		await seedLinked(db, 'cinnamonserval');
		stubRegistryFetch({
			'/v1/submissions/mine': { submissions: [] },
			'/v1/artists?': { artists: [survivor], nextCursor: null }
		});

		const result = (await load(loadEvent(platform))) as {
			artists: Array<{ id: number }>;
			aliasLinked: Record<number, string>;
		};
		expect(result.aliasLinked).toEqual({ [result.artists[0].id]: 'Funereal' });
	});

	it('does NOT mark a direct-linked artist renamed locally (name is not an alias)', async () => {
		const { db, platform } = makeDb();
		await seedLinked(db, 'Graveside'); // legit local rename → shareable update proposal
		stubRegistryFetch({
			'/v1/submissions/mine': { submissions: [] },
			'/v1/artists?': { artists: [survivor], nextCursor: null }
		});

		const result = (await load(loadEvent(platform))) as { aliasLinked: Record<number, string> };
		expect(result.aliasLinked).toEqual({});
	});

	it('fails open (no marks) when the catalog is unreachable', async () => {
		const { db, platform } = makeDb();
		await seedLinked(db, 'CinnamonServal');
		// Default beforeEach stub: every fetch is offline.

		const result = (await load(loadEvent(platform))) as { aliasLinked: Record<number, string> };
		expect(result.aliasLinked).toEqual({});
	});
});

describe('admin artists load — catalog refusal is surfaced, not silently empty', () => {
	it('sets registryError (and still lists local artists) when the delta feed 401s', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stale-key' });
		await db.insert(schema.artists).values({ name: 'Nyx', globalId: 'g-1' });
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('/v1/artists?')
					? Promise.resolve(
							new Response(JSON.stringify({ error: 'invalid fork key' }), { status: 401 })
						)
					: Promise.resolve(new Response(JSON.stringify({ submissions: [] })))
			)
		);

		const result = (await load(loadEvent(platform))) as {
			artists: unknown[];
			registryError: string | null;
		};
		// The registry's own words lead, the protocol status trails.
		expect(result.registryError).toBe('invalid fork key (HTTP 401)');
		expect(result.artists).toHaveLength(1);
	});

	// Registry text is untrusted cross-tenant input: a long message must not blow out
	// the page's error line.
	it('caps the registry reason at 300 characters', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stale-key' });
		await db.insert(schema.artists).values({ name: 'Nyx', globalId: 'g-1' });
		const long = 'x'.repeat(1000);
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('/v1/artists?')
					? Promise.resolve(new Response(JSON.stringify({ error: long }), { status: 401 }))
					: Promise.resolve(new Response(JSON.stringify({ submissions: [] })))
			)
		);

		const result = (await load(loadEvent(platform))) as { registryError: string | null };
		expect(result.registryError).toBe('x'.repeat(300) + ' (HTTP 401)');
	});

	it('leaves registryError null on a transient outage (unchanged fail-soft behaviour)', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		await db.insert(schema.artists).values({ name: 'Nyx', globalId: 'g-1' });
		// Default beforeEach stub: every fetch is offline.

		const result = (await load(loadEvent(platform))) as { registryError: string | null };
		expect(result.registryError).toBeNull();
	});
});

describe('submitToRegistry action — surfaces the registry outcome', () => {
	// Enable the registry via a stored fork key (same path the load tests use) and
	// seed the artist row the action reads, then return its id.
	async function seedEnabledArtist(
		db: ReturnType<typeof makeDb>['db'],
		extra: Partial<typeof schema.artists.$inferInsert> = {}
	) {
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const row = await db.insert(schema.artists).values({ name: 'Nyx', ...extra }).returning({ id: schema.artists.id }).get();
		return row.id;
	}

	function submitEvent(platform: App.Platform, id: number) {
		const body = new FormData();
		body.append('id', String(id));
		return {
			platform,
			url: new URL('http://localhost/admin/artists'),
			request: new Request('http://localhost/admin/artists', { method: 'POST', body })
		} as never;
	}

	beforeEach(() => mockRegistrySubmit.mockReset());

	it('returns fail(409) carrying the registry’s own reason when the submission is refused', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ error: 'This artist was removed from the registry and cannot be resubmitted.', httpStatus: 409 });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 409 });
		expect((result as { data: { error: string } }).data.error).toMatch(/removed from the registry/i);
	});

	it('passes a non-conflict refusal status through (429 rate-limit, not a blanket 409)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ error: 'Too many submissions — slow down.', httpStatus: 429 });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 429 });
		expect((result as { data: { error: string } }).data.error).toMatch(/too many/i);
	});

	it('truncates an over-long registry refusal message before surfacing it', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ error: 'x'.repeat(500), httpStatus: 400 });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect((result as { data: { error: string } }).data.error).toHaveLength(300);
	});

	it('returns fail(502) when the registry is unreachable (null result)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue(null);

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 502 });
		expect((result as { data: { error: string } }).data.error).toMatch(/unreachable/i);
	});

	it('returns success on a clean submission', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
	});

	it('submits an update with the stored registryVersion as baseVersion (unchanged path)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db, { globalId: 'g-9', registryVersion: 3 });
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
		expect(mockRegistrySubmit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 'update', targetGlobalId: 'g-9', baseVersion: 3 })
		);
	});

	it('resolves + persists a missing registryVersion before submitting an update (#71)', async () => {
		const { db, platform } = makeDb();
		// Linked but never version-stamped — the exact state issue #71 describes.
		const id = await seedEnabledArtist(db, { globalId: 'g-9' });
		stubRegistryFetch({
			'/v1/artists/g-9': {
				globalId: 'g-9',
				displayName: 'Nyx',
				avatarUrl: null,
				bio: null,
				socials: {},
				status: 'active',
				mergedInto: null,
				version: 4,
				updatedAt: '2026-01-02T00:00:00Z'
			}
		});
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
		// The update went out with a NUMERIC baseVersion, not undefined.
		expect(mockRegistrySubmit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 'update', targetGlobalId: 'g-9', baseVersion: 4 })
		);
		// And the resolved version was persisted so the next share skips the lookup.
		const row = await db.select().from(schema.artists).get();
		expect(row!.registryVersion).toBe(4);
	});

	// The registry artist "Funereal" carrying "CinnamonServal" as an alias — the
	// shape registryGetArtist returns for the alias-guard checks below.
	const survivorEntry = {
		globalId: 'g-1',
		displayName: 'Funereal',
		avatarUrl: null,
		bio: null,
		socials: {},
		aliases: [{ displayName: 'CinnamonServal', socials: {} }],
		status: 'active',
		mergedInto: null,
		version: 3,
		updatedAt: '2026-01-02T00:00:00Z'
	};

	it('refuses (400, no submit) sharing a row whose name is an alias of its linked registry artist (#71)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db, { name: 'CinnamonServal', globalId: 'g-1', registryVersion: 3 });
		stubRegistryFetch({ '/v1/artists/g-1': survivorEntry });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/AKA of Funereal/);
		expect(mockRegistrySubmit).not.toHaveBeenCalled();
	});

	it('still submits a direct-linked local rename as an update (#71 guard must not overblock)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db, { name: 'Graveside', globalId: 'g-1', registryVersion: 3 });
		stubRegistryFetch({ '/v1/artists/g-1': survivorEntry });
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
		expect(mockRegistrySubmit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: 'update',
				targetGlobalId: 'g-1',
				payload: expect.objectContaining({ displayName: 'Graveside' })
			})
		);
	});

	it('fails open when the registry is unreachable: the alias check is skipped and the share proceeds (#71)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db, { name: 'CinnamonServal', globalId: 'g-1', registryVersion: 3 });
		// Default beforeEach stub: the registryGetArtist lookup is offline.
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
	});

	it('fails 502 (and never submits) when the missing version cannot be resolved (#71)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db, { globalId: 'g-9' });
		// Default beforeEach stub: every fetch (incl. the version lookup) is offline.

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 502 });
		expect((result as { data: { error: string } }).data.error).toMatch(/registry version/i);
		expect(mockRegistrySubmit).not.toHaveBeenCalled();
	});
});

describe('update action — avatar clobber guard (#187)', () => {
	function updateEvent(platform: App.Platform, fields: Record<string, string>) {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.append(k, v);
		return {
			platform,
			url: new URL('http://localhost/admin/artists'),
			request: new Request('http://localhost/admin/artists', { method: 'POST', body })
		} as never;
	}

	// The default beforeEach stub fails every fetch, so re-resolution comes back null.
	it('keeps the existing avatar when re-resolution fails during an edit', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(schema.artists)
			.values({ name: 'Nyx', avatarUrl: 'https://cdn.test/avatars/nyx/good.jpg', blueskyUrl: 'nyx.bsky.social' })
			.returning({ id: schema.artists.id })
			.get();

		// Edit just the name; the bluesky field is still present so resolve runs (and fails).
		const result = await actions.update(updateEvent(platform, { id: String(row.id), name: 'Nyx Prime', bluesky: 'nyx.bsky.social' }));
		expect(result).toEqual({ success: true });

		const after = await db.select().from(schema.artists).get();
		expect(after!.name).toBe('Nyx Prime');
		expect(after!.avatarUrl).toBe('https://cdn.test/avatars/nyx/good.jpg'); // not clobbered to null
	});

	// Downgrade guard: the profile resolves but the re-host download fails, so
	// resolveAvatarUrl falls back to the SOURCE hotlink — writing that over an
	// avatar we host would re-rot a good stored copy.
	it('keeps an owned re-hosted avatar when re-resolution falls back to a source hotlink', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(schema.artists)
			// Root-relative '/img/…' is ours by definition (no-CDN R2 shape).
			.values({ name: 'Nyx', avatarUrl: '/img/avatars/nyx/owned.jpg', blueskyUrl: 'nyx.bsky.social' })
			.returning({ id: schema.artists.id })
			.get();
		// Profile lookup succeeds; the CDN download stays offline → hotlink fallback.
		stubRegistryFetch({
			'public.api.bsky.app': { avatar: 'https://cdn.bsky.app/img/avatar/plain/rot.jpg' }
		});

		const result = await actions.update(updateEvent(platform, { id: String(row.id), name: 'Nyx', bluesky: 'nyx.bsky.social' }));
		expect(result).toEqual({ success: true });

		const after = await db.select().from(schema.artists).get();
		expect(after!.avatarUrl).toBe('/img/avatars/nyx/owned.jpg'); // not downgraded to the hotlink
		expect(after!.avatarResolvedAt).toBeNull(); // not stamped — the cron may still retry it
	});

	// Clearing every avatar-capable social is a deliberate removal — with nothing
	// left to resolve from, the guard must not pin a wrong avatar forever.
	it('clears the avatar when every avatar-capable social is posted empty', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(schema.artists)
			.values({ name: 'Nyx', avatarUrl: '/img/avatars/nyx/owned.jpg', blueskyUrl: 'https://bsky.app/profile/nyx.bsky.social' })
			.returning({ id: schema.artists.id })
			.get();

		const result = await actions.update(updateEvent(platform, { id: String(row.id), name: 'Nyx', bluesky: '' }));
		expect(result).toEqual({ success: true });

		const after = await db.select().from(schema.artists).get();
		expect(after!.avatarUrl).toBeNull(); // deliberate removal, not kept
		expect(after!.blueskyUrl).toBeNull();
		expect(after!.avatarResolvedAt).toBeNull(); // nothing was resolved
	});

	// Efficiency: identical avatar socials + an already-ours avatar → nothing the
	// resolve could change, so the action must not re-fetch/re-host at all.
	it('skips re-resolution when avatar socials are unchanged and the avatar is already ours', async () => {
		const { db, platform } = makeDb();
		const fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
		vi.stubGlobal('fetch', fetchSpy);
		const row = await db
			.insert(schema.artists)
			.values({
				name: 'Nyx',
				avatarUrl: '/img/avatars/nyx/owned.jpg',
				// Stored in normalized form, as the action itself would have written it.
				blueskyUrl: 'https://bsky.app/profile/nyx.bsky.social'
			})
			.returning({ id: schema.artists.id })
			.get();

		const result = await actions.update(
			updateEvent(platform, { id: String(row.id), name: 'Nyx Prime', bluesky: 'nyx.bsky.social' })
		);
		expect(result).toEqual({ success: true });
		expect(fetchSpy).not.toHaveBeenCalled(); // no profile lookup, no re-host

		const after = await db.select().from(schema.artists).get();
		expect(after!.name).toBe('Nyx Prime');
		expect(after!.avatarUrl).toBe('/img/avatars/nyx/owned.jpg');
		expect(after!.avatarResolvedAt).toBeNull(); // untouched — nothing was written
	});
});

describe('refreshAvatars action — backfill (#187)', () => {
	function refreshEvent(platform: App.Platform) {
		return {
			platform,
			url: new URL('http://localhost/admin/artists'),
			request: new Request('http://localhost/admin/artists', { method: 'POST' })
		} as never;
	}

	// Offline stub → resolution fails, so this exercises the bounded scan + stamping
	// + clobber-safety without hitting the network. (Owned-vs-hotlinked filtering and
	// successful re-hosting are covered in avatar.test.ts against a fake bucket.)
	it('processes social rows, skips social-less ones, and reports counts', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values([
			{ name: 'Hotlinked', blueskyUrl: 'a.bsky.social', avatarUrl: 'https://pbs.twimg.com/x_400x400.jpg' },
			{ name: 'NoSocial', avatarUrl: null }
		]);

		const result = await actions.refreshAvatars(refreshEvent(platform));
		// NoSocial can never resolve, so it's left out of the queue entirely. Hotlinked
		// resolves to null offline, so it's not re-hosted, but it's still processed (and
		// stamped) so it won't churn every run.
		expect(result).toEqual({ success: true, avatarRefresh: { processed: 1, refreshed: 0, remaining: 0 } });

		const hot = await db.select().from(schema.artists).where(eq(schema.artists.name, 'Hotlinked')).get();
		expect(hot!.avatarUrl).toBe('https://pbs.twimg.com/x_400x400.jpg'); // preserved (clobber-safe)
		expect(hot!.avatarResolvedAt).toBeTruthy();
		const noSocial = await db.select().from(schema.artists).where(eq(schema.artists.name, 'NoSocial')).get();
		expect(noSocial!.avatarResolvedAt).toBeNull(); // untouched
	});
});
