import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { images, imageTags, tags, characters, artists } from '$lib/server/db/schema';
import { resolveRefImage, refImageSource, storedImageSource, refImageCredit } from './ref-image';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
			md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			source_post_url TEXT, artist_id INTEGER NOT NULL, collection_id INTEGER, commissioned_at TEXT,
			parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
			featured_order INTEGER, created_at TEXT NOT NULL);
		CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT,
			url TEXT, twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			furtrack_url TEXT, deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			avatar_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL);
	`);
	return drizzle(makeD1(sqlite), { schema });
}

type Db = ReturnType<typeof makeDb>;

async function addImage(
	db: Db,
	opts: {
		slug: string;
		url: string;
		published?: boolean;
		createdAt?: string;
		tagged?: boolean;
		parentId?: number;
	}
) {
	const row = await db
		.insert(images)
		.values({
			title: opts.slug,
			slug: opts.slug,
			imageUrl: opts.url,
			artistId: 1,
			published: opts.published ?? true,
			parentImageId: opts.parentId ?? null,
			createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z'
		})
		.returning({ id: images.id })
		.get();
	if (opts.tagged) {
		let tag = await db.select({ id: tags.id }).from(tags).get();
		if (!tag) tag = await db.insert(tags).values({ name: 'reference' }).returning({ id: tags.id }).get();
		await db.insert(imageTags).values({ imageId: row.id, tagId: tag!.id });
	}
	return row.id;
}

describe('resolveRefImage — same precedence as /art', () => {
	it('prefers the owner character’s designated reference image over a newer tagged one', async () => {
		const db = makeDb();
		const designated = await addImage(db, { slug: 'old-ref', url: 'https://cdn.x/old.png', createdAt: '2025-01-01' });
		await addImage(db, { slug: 'new-ref', url: 'https://cdn.x/new.png', createdAt: '2026-06-01', tagged: true });
		await db.insert(characters).values({ name: 'Taro', isOwner: true, referenceImageId: designated });

		expect(await resolveRefImage(db)).toEqual({ id: designated, imageUrl: 'https://cdn.x/old.png' });
	});

	it('falls back to the newest published reference-tagged image when the designated one is unpublished', async () => {
		const db = makeDb();
		const unpublished = await addImage(db, { slug: 'hidden', url: 'https://cdn.x/hidden.png', published: false });
		const older = await addImage(db, { slug: 'a', url: 'https://cdn.x/a.png', createdAt: '2025-01-01', tagged: true });
		const newer = await addImage(db, { slug: 'b', url: 'https://cdn.x/b.png', createdAt: '2026-01-01', tagged: true });
		await db.insert(characters).values({ name: 'Taro', isOwner: true, referenceImageId: unpublished });

		expect(older).not.toBe(newer);
		expect(await resolveRefImage(db)).toEqual({ id: newer, imageUrl: 'https://cdn.x/b.png' });
	});

	it('ignores unpublished tagged images in the fallback', async () => {
		const db = makeDb();
		await addImage(db, { slug: 'draft', url: 'https://cdn.x/draft.png', published: false, createdAt: '2026-06-01', tagged: true });
		const live = await addImage(db, { slug: 'live', url: 'https://cdn.x/live.png', createdAt: '2025-01-01', tagged: true });

		expect(await resolveRefImage(db)).toEqual({ id: live, imageUrl: 'https://cdn.x/live.png' });
	});

	// SONA-18: /art excludes variants from both paths, and the color picker
	// samples whatever this returns — a sheet the picker offers but /art refuses
	// would send the operator hunting for a mismatch that isn't theirs.
	it('falls through a designated variant to the tagged parent', async () => {
		const db = makeDb();
		const parent = await addImage(db, { slug: 'parent', url: 'https://cdn.x/parent.png', createdAt: '2025-01-01', tagged: true });
		const variant = await addImage(db, { slug: 'variant', url: 'https://cdn.x/variant.png', createdAt: '2026-06-01', parentId: parent });
		await db.insert(characters).values({ name: 'Taro', isOwner: true, referenceImageId: variant });

		expect(await resolveRefImage(db)).toEqual({ id: parent, imageUrl: 'https://cdn.x/parent.png' });
	});

	it('ignores a reference-tagged variant in the fallback', async () => {
		const db = makeDb();
		const parent = await addImage(db, { slug: 'parent', url: 'https://cdn.x/parent.png', createdAt: '2025-01-01', tagged: true });
		// Newer, so it would win createdAt DESC without the exclusion.
		await addImage(db, { slug: 'variant', url: 'https://cdn.x/variant.png', createdAt: '2026-06-01', tagged: true, parentId: parent });

		expect(await resolveRefImage(db)).toEqual({ id: parent, imageUrl: 'https://cdn.x/parent.png' });
	});

	it('returns null when no reference sheet exists at all', async () => {
		const db = makeDb();
		await addImage(db, { slug: 'plain', url: 'https://cdn.x/plain.png' }); // untagged, undesignated

		expect(await resolveRefImage(db)).toBeNull();
	});
});

describe('refImageSource — client canvas-loading strategy', () => {
	const opts = { origin: 'https://taro.surf', r2PublicUrl: 'https://cdn.taro.surf', dev: false };

	it('uses root-relative and same-origin URLs as-is, no crossorigin', () => {
		expect(refImageSource({ id: 1, imageUrl: '/images/ref.png' }, opts)).toEqual({
			src: '/images/ref.png',
			crossorigin: false
		});
		expect(refImageSource({ id: 1, imageUrl: 'https://taro.surf/images/ref.png' }, opts)).toEqual({
			src: 'https://taro.surf/images/ref.png',
			crossorigin: false
		});
	});

	it('routes an R2-owned URL through the same-origin lossless size-capped PNG transform in prod', () => {
		expect(refImageSource({ id: 1, imageUrl: 'https://cdn.taro.surf/ref.png' }, opts)).toEqual({
			src: '/cdn-cgi/image/format=png,width=1600,fit=scale-down/https://cdn.taro.surf/ref.png',
			crossorigin: false
		});
	});

	it('falls back to the by-ID proxy for R2 URLs in dev (no CF edge locally)', () => {
		expect(refImageSource({ id: 7, imageUrl: 'https://cdn.taro.surf/ref.png' }, { ...opts, dev: true })).toEqual({
			src: '/api/admin/ref-image?id=7',
			crossorigin: false
		});
	});

	it('loads UploadThing URLs directly with crossorigin (UT serves ACAO: *)', () => {
		expect(refImageSource({ id: 1, imageUrl: 'https://abc12.ufs.sh/f/key' }, opts)).toEqual({
			src: 'https://abc12.ufs.sh/f/key',
			crossorigin: true
		});
		expect(refImageSource({ id: 1, imageUrl: 'https://utfs.io/f/key' }, opts)).toEqual({
			src: 'https://utfs.io/f/key',
			crossorigin: true
		});
	});

	it('does not treat lookalike hosts as UploadThing', () => {
		expect(refImageSource({ id: 3, imageUrl: 'https://evilufs.sh/f/key' }, opts)).toEqual({
			src: '/api/admin/ref-image?id=3',
			crossorigin: false
		});
	});

	it('sends anything else (incl. protocol-relative URLs) to the by-ID proxy', () => {
		expect(refImageSource({ id: 9, imageUrl: 'https://i.example.com/ref.png' }, opts)).toEqual({
			src: '/api/admin/ref-image?id=9',
			crossorigin: false
		});
		expect(refImageSource({ id: 9, imageUrl: '//i.example.com/ref.png' }, opts)).toEqual({
			src: '/api/admin/ref-image?id=9',
			crossorigin: false
		});
	});
});

describe('storedImageSource — the strategy without the ref-sheet proxy', () => {
	const opts = { origin: 'https://taro.surf', r2PublicUrl: 'https://cdn.taro.surf', dev: false };

	it('answers for the URLs the page can read, exactly as refImageSource does', () => {
		// The con card's avatar shares the branches but not the fallback: the
		// by-ID proxy serves ref images only.
		expect(storedImageSource('/img/avatars/owner/face.jpg', opts)?.src).toBe(
			'/img/avatars/owner/face.jpg'
		);
		expect(storedImageSource('https://cdn.taro.surf/face.png', opts)?.src).toBe(
			'/cdn-cgi/image/format=png,width=1600,fit=scale-down/https://cdn.taro.surf/face.png'
		);
		expect(storedImageSource('https://abc12.ufs.sh/f/key', opts)).toEqual({
			src: 'https://abc12.ufs.sh/f/key',
			crossorigin: true
		});
	});

	it('is null for a URL the page has no way to read', () => {
		// A hotlink we never re-hosted. The caller decides what that means: the
		// ref sheet proxies it, the con card falls back to the name's initial.
		expect(storedImageSource('https://cdn.bsky.app/img/avatar/plain/x', opts)).toBeNull();
		expect(storedImageSource('//i.example.com/ref.png', opts)).toBeNull();
	});
});

describe('refImageCredit — current identity only', () => {
	// A card is printed once. In this community a rename is often a transition or
	// a move away from harassment, so a former handle on paper is a harm no later
	// fix reaches. The aliases column exists for old ?artist= links and must never
	// reach the credit.
	it('credits the current name and handle, never a former identity', async () => {
		const db = makeDb();
		await db
			.insert(artists)
			.values({
				name: 'Nori',
				blueskyUrl: 'https://bsky.app/profile/nori.example',
				aliases: JSON.stringify([
					{ displayName: 'OldName', socials: { bluesky: 'https://bsky.app/profile/oldname.example' } }
				]),
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
		await addImage(db, { slug: 'ref', url: '/img/ref.png' });

		const credit = await refImageCredit(db, 1);
		expect(credit).toEqual({ name: 'Nori', handle: '@nori.example' });
		expect(JSON.stringify(credit)).not.toContain('OldName');
		expect(JSON.stringify(credit)).not.toContain('oldname');
	});
});
