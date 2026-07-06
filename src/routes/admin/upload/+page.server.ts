import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, collections, tags, images, imageTags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq, isNull, count as countFn } from 'drizzle-orm';
import { slugify } from '$lib/server/slugify';
import { sanitizeText, sanitizeUrl, sanitizeTag } from '$lib/server/validate';
import { variantAssignmentError, MAX_VARIANT_SET } from '$lib/server/variants';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	const [allArtists, allCollections, allTags, allCharacters, parentCandidates] = await Promise.all([
		db.select().from(artists).orderBy(artists.name),
		db.select().from(collections).orderBy(collections.name),
		db.select().from(tags).orderBy(tags.name),
		db.select().from(characters).orderBy(characters.name),
		// For "add as variants of an existing piece": parents only (one level).
		db
			.select({ id: images.id, title: images.title })
			.from(images)
			.where(isNull(images.parentImageId))
			.orderBy(images.title)
	]);

	// Only offer the "use as reference sheet" control when an owner character
	// exists (first, if several) — it carries the canonical reference image.
	const ownerCharacter = allCharacters.find((c) => c.isOwner) ?? null;

	return {
		artists: allArtists,
		collections: allCollections,
		tags: allTags,
		characters: allCharacters,
		parentCandidates,
		maxVariantSet: MAX_VARIANT_SET,
		ownerCharacter: ownerCharacter && { name: ownerCharacter.name }
	};
};

// Applies the shared tag/character rows to one inserted image.
async function attachTagsAndCharacters(
	db: ReturnType<typeof getDb>,
	imageId: number,
	tagNames: string,
	characterIds: string
) {
	if (tagNames) {
		const tagList = tagNames.split(',').map(sanitizeTag).filter(Boolean);
		for (const tagName of tagList) {
			let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
			if (!tag) {
				tag = await db.insert(tags).values({ name: tagName }).returning().get();
			}
			await db.insert(imageTags).values({ imageId, tagId: tag.id });
		}
	}

	if (characterIds) {
		const ids = characterIds.split(',').map((id) => Number(id.trim())).filter(Boolean);
		for (const charId of ids) {
			await db.insert(imageCharacters).values({ imageId, characterId: charId });
		}
	}
}

// A slug that's free both in the DB and within the current batch.
async function freeSlug(db: ReturnType<typeof getDb>, base: string, used: Set<string>) {
	let candidate = base;
	let n = 2;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const taken =
			used.has(candidate) ||
			(await db.select({ id: images.id }).from(images).where(eq(images.slug, candidate)).get());
		if (!taken) {
			used.add(candidate);
			return candidate;
		}
		candidate = `${base}-${n++}`;
	}
}

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const title = sanitizeText(data.get('title') as string, 200);
		const artistId = data.get('artistId') as string;
		const collectionId = data.get('collectionId') as string;
		const tagNames = sanitizeText(data.get('tags') as string, 500);
		const characterIds = (data.get('characters') as string)?.trim();
		const nsfw = data.get('nsfw') === 'on';
		const published = data.get('published') !== 'on';
		const sourcePostUrl = sanitizeUrl(data.get('sourcePostUrl') as string);
		const commissionedAt = (data.get('commissionedAt') as string)?.trim();

		// Batch fields: `count` tiles, each with indexed hidden inputs. `count` of 1
		// with no group target is the classic single upload.
		const count = Number(data.get('count')) || 1;
		const existingParentIdRaw = (data.get('existingParentId') as string)?.trim();
		const parentIndex = Number(data.get('parentIndex')) || 0;

		if (count < 1 || count > MAX_VARIANT_SET) {
			return fail(400, { error: `A variant set is 1–${MAX_VARIANT_SET} files` });
		}

		type Tile = {
			imageUrl: string;
			width: number | null;
			height: number | null;
			fileSize: number | null;
			label: string;
			nsfw: boolean;
		};
		const tiles: Tile[] = [];
		for (let i = 0; i < count; i++) {
			const imageUrl = sanitizeUrl(data.get(`imageUrl_${i}`) as string);
			if (!imageUrl) return fail(400, { error: 'Image URL is required' });
			tiles.push({
				imageUrl,
				width: Number(data.get(`width_${i}`)) || null,
				height: Number(data.get(`height_${i}`)) || null,
				fileSize: Number(data.get(`fileSize_${i}`)) || null,
				label: sanitizeText(data.get(`label_${i}`) as string, 100),
				nsfw: data.get(`nsfw_${i}`) === 'on' || nsfw
			});
		}

		// The New Artist dialog creates the artist up front (via /api/artists), so
		// the form always submits an existing artist id.
		const resolvedArtistId = Number(artistId);
		if (!resolvedArtistId) return fail(400, { error: 'Artist is required' });

		// Resolve the group target: an existing parent, a parent from this batch,
		// or none (single upload).
		let existingParent: { id: number; title: string } | null = null;
		if (existingParentIdRaw) {
			const existingParentId = Number(existingParentIdRaw);
			if (!Number.isInteger(existingParentId) || existingParentId <= 0) {
				return fail(400, { error: 'Invalid parent image' });
			}
			const parent = await db
				.select({ id: images.id, title: images.title, parentImageId: images.parentImageId })
				.from(images)
				.where(eq(images.id, existingParentId))
				.get();
			const variantError = variantAssignmentError({ selfId: null, parent });
			if (variantError === 'missing') return fail(400, { error: 'Parent image not found' });
			if (variantError === 'nested')
				return fail(400, { error: 'Variants cannot be nested — the chosen parent is itself a variant' });
			existingParent = { id: parent!.id, title: parent!.title };
		} else {
			if (!title) return fail(400, { error: 'Title is required' });
			if (count > 1 && (parentIndex < 0 || parentIndex >= count)) {
				return fail(400, { error: 'Pick which file is the parent' });
			}
		}

		const shared = {
			artistId: resolvedArtistId,
			collectionId: collectionId ? Number(collectionId) : null,
			published,
			sourcePostUrl: sourcePostUrl || null,
			commissionedAt: commissionedAt || null
		};
		const usedSlugs = new Set<string>();

		let parentDbId: number;
		let variantTiles: { tile: Tile; n: number }[];

		if (existingParent) {
			// All tiles become variants of the existing piece; fallback numbering
			// continues after the variants it already has.
			const existing = await db
				.select({ count: countFn() })
				.from(images)
				.where(eq(images.parentImageId, existingParent.id))
				.get();
			const offset = existing?.count ?? 0;
			parentDbId = existingParent.id;
			variantTiles = tiles.map((tile, i) => ({ tile, n: offset + i + 1 }));
		} else {
			const parentTile = tiles[parentIndex];
			const parentRow = await db
				.insert(images)
				.values({
					title,
					slug: await freeSlug(db, slugify(title), usedSlugs),
					imageUrl: parentTile.imageUrl,
					width: parentTile.width,
					height: parentTile.height,
					fileSize: parentTile.fileSize,
					nsfw: parentTile.nsfw,
					...shared
				})
				.returning({ id: images.id })
				.get();
			parentDbId = parentRow.id;
			await attachTagsAndCharacters(db, parentDbId, tagNames, characterIds);
			variantTiles = tiles.filter((_, i) => i !== parentIndex).map((tile, i) => ({ tile, n: i + 1 }));
		}

		const baseTitle = existingParent ? existingParent.title : title;
		for (const { tile, n } of variantTiles) {
			const variantTitle = sanitizeText(`${baseTitle} (${tile.label || `Variant ${n}`})`, 200);
			const variantRow = await db
				.insert(images)
				.values({
					title: variantTitle,
					slug: await freeSlug(db, slugify(variantTitle), usedSlugs),
					imageUrl: tile.imageUrl,
					width: tile.width,
					height: tile.height,
					fileSize: tile.fileSize,
					nsfw: tile.nsfw,
					parentImageId: parentDbId,
					variantLabel: tile.label || null,
					...shared
				})
				.returning({ id: images.id })
				.get();
			await attachTagsAndCharacters(db, variantRow.id, tagNames, characterIds);
		}

		// Optionally designate the primary (parent) image as the owner character's
		// reference sheet — same semantics as the edit-page control.
		if (data.get('useAsReference') === 'on') {
			const owner = await db.select({ id: characters.id }).from(characters).where(eq(characters.isOwner, true)).get();
			if (owner) {
				await db.update(characters).set({ referenceImageId: parentDbId }).where(eq(characters.id, owner.id));
			}
		}

		redirect(302, '/admin/images');
	}
} satisfies Actions;
