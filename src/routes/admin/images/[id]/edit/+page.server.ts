import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { images, artists, collections, tags, imageTags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq, and, isNull, ne } from 'drizzle-orm';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { getSettings } from '$lib/server/settings';
import { sanitizeText, sanitizeUrl, sanitizeTag } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import { variantAssignmentError, REFERENCE_BECOMES_VARIANT_ERROR } from '$lib/server/variants';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = getDb(platform!.env.DB);
	const id = Number(params.id);

	const image = await db
		.select()
		.from(images)
		.where(eq(images.id, id))
		.get();

	if (!image) error(404, 'Image not found');

	const imageTagRows = await db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, id));

	const imageCharacterRows = await db
		.select({ id: characters.id })
		.from(imageCharacters)
		.innerJoin(characters, eq(imageCharacters.characterId, characters.id))
		.where(eq(imageCharacters.imageId, id));

	const [allArtists, allCollections, allTags, allCharacters, parentCandidates, firstVariant] =
		await Promise.all([
			db.select().from(artists).orderBy(artists.name),
			db.select().from(collections).orderBy(collections.name),
			db.select().from(tags).orderBy(tags.name),
			db.select().from(characters).orderBy(characters.name),
			// Parent-eligible = images that are not variants themselves (one level only).
			db
				.select({ id: images.id, title: images.title })
				.from(images)
				.where(and(isNull(images.parentImageId), ne(images.id, id)))
				.orderBy(images.title),
			db.select({ id: images.id }).from(images).where(eq(images.parentImageId, id)).get()
		]);

	// The site's owner character (first, if several) carries the canonical
	// reference image. Only then do we offer the "use as reference" control.
	const ownerCharacter = allCharacters.find((c) => c.isOwner) ?? null;

	return {
		image,
		imageTags: imageTagRows.map((t) => t.name),
		imageCharacterIds: imageCharacterRows.map((c) => c.id),
		artists: allArtists,
		collections: allCollections,
		tags: allTags,
		characters: allCharacters,
		parentCandidates,
		// An image that already has variants is a parent — it can't also be a variant.
		hasVariants: !!firstVariant,
		ownerCharacter: ownerCharacter && {
			name: ownerCharacter.name,
			isReference: ownerCharacter.referenceImageId === image.id,
			// A designation already exists, but on a different image — setting this
			// one replaces it.
			replacesOther:
				ownerCharacter.referenceImageId != null && ownerCharacter.referenceImageId !== image.id
		}
	};
};

export const actions = {
	save: async ({ params, request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const id = Number(params.id);
		const data = await request.formData();

		const title = sanitizeText(data.get('title') as string, 200);
		const artistId = data.get('artistId') as string;
		const artistName = sanitizeText(data.get('artistName') as string, 200);
		const collectionId = data.get('collectionId') as string;
		const tagNames = sanitizeText(data.get('tags') as string, 500);
		const characterIds = (data.get('characters') as string)?.trim();
		const nsfw = data.get('nsfw') === 'on';
		const published = data.get('published') !== 'on';
		const featured = data.get('featured') === 'on';
		// Empty input = no explicit order (NULL → sorts last). Otherwise coerce to a
		// non-negative integer, clamped to a sane range so a stray decimal, negative,
		// or absurdly large value can't silently vanish or break the D1 write / sort.
		const featuredOrderRaw = (data.get('featuredOrder') as string)?.trim();
		const featuredOrderNum = featuredOrderRaw ? Number(featuredOrderRaw) : NaN;
		const featuredOrder = Number.isFinite(featuredOrderNum)
			? Math.min(Math.max(Math.trunc(featuredOrderNum), 0), 100000)
			: null;
		const sourcePostUrl = sanitizeUrl(data.get('sourcePostUrl') as string);
		const commissionedAt = (data.get('commissionedAt') as string)?.trim();
		const parentImageIdRaw = (data.get('parentImageId') as string)?.trim();
		const variantLabel = sanitizeText(data.get('variantLabel') as string, 100);

		// Artist social links (for new artists)
		const twitterUrl = normalizeSocialUrl('twitter', data.get('twitter') as string) || null;
		const blueskyUrl = normalizeSocialUrl('bluesky', data.get('bluesky') as string) || null;
		const telegramUrl = normalizeSocialUrl('telegram', data.get('telegram') as string) || null;
		const furAffinityUrl = normalizeSocialUrl('furaffinity', data.get('furaffinity') as string) || null;
		const deviantArtUrl = normalizeSocialUrl('deviantart', data.get('deviantart') as string) || null;
		const patreonUrl = normalizeSocialUrl('patreon', data.get('patreon') as string) || null;
		const instagramUrl = normalizeSocialUrl('instagram', data.get('instagram') as string) || null;

		if (!title) return fail(400, { error: 'Title is required' });

		// Variant link: validate before writing anything.
		let parentImageId: number | null = null;
		if (parentImageIdRaw) {
			parentImageId = Number(parentImageIdRaw);
			if (!Number.isInteger(parentImageId) || parentImageId <= 0) {
				return fail(400, { error: 'Invalid parent image' });
			}
			const [parent, firstVariant, current] = await Promise.all([
				db
					.select({ id: images.id, parentImageId: images.parentImageId })
					.from(images)
					.where(eq(images.id, parentImageId))
					.get(),
				db.select({ id: images.id }).from(images).where(eq(images.parentImageId, id)).get(),
				db
					.select({ parentImageId: images.parentImageId })
					.from(images)
					.where(eq(images.id, id))
					.get()
			]);
			const variantError = variantAssignmentError({
				selfId: id,
				parent,
				selfHasVariants: !!firstVariant
			});
			if (variantError === 'self') return fail(400, { error: 'An image cannot be a variant of itself' });
			if (variantError === 'missing') return fail(400, { error: 'Parent image not found' });
			if (variantError === 'nested')
				return fail(400, { error: 'Variants cannot be nested — the chosen parent is itself a variant' });
			if (variantError === 'has_variants')
				return fail(400, { error: 'This image has variants of its own and cannot become a variant' });

			// Only a row that is BECOMING a variant is refused. A row designated
			// before this rule can already be both, and it still has to be editable
			// — resubmitting its unchanged parent must not lock the whole form.
			if (current?.parentImageId == null) {
				const owner = await db
					.select({ referenceImageId: characters.referenceImageId })
					.from(characters)
					.where(eq(characters.isOwner, true))
					// first owner by name — must match the loads' find() over name-ordered characters
					.orderBy(characters.name)
					.get();
				if (owner?.referenceImageId === id)
					return fail(400, { error: REFERENCE_BECOMES_VARIANT_ERROR });
			}
		}

		// Resolve or create artist
		let resolvedArtistId: number;
		if (artistId && artistId !== 'new') {
			resolvedArtistId = Number(artistId);
		} else if (artistName) {
			// Resolve + re-host to our own CDN so the avatar can't rot to a 404.
			const settings = await getSettings(db);
			const avatarUrl = await resolveAvatarUrl(
				{ blueskyUrl, twitterUrl, furAffinityUrl, patreonUrl },
				{ env: platform?.env, settings, origin: url.origin, keyHint: artistName }
			);
			const newArtist = await db
				.insert(artists)
				.values({
					name: artistName,
					avatarUrl,
					avatarResolvedAt: avatarUrl ? new Date().toISOString() : null,
					twitterUrl,
					blueskyUrl,
					telegramUrl,
					furAffinityUrl,
					deviantArtUrl,
					patreonUrl,
					instagramUrl
				})
				.returning({ id: artists.id })
				.get();
			resolvedArtistId = newArtist.id;
		} else {
			return fail(400, { error: 'Artist is required' });
		}

		// Update image
		await db
			.update(images)
			.set({
				title,
				artistId: resolvedArtistId,
				collectionId: collectionId ? Number(collectionId) : null,
				nsfw,
				published,
				featured,
				featuredOrder,
				sourcePostUrl: sourcePostUrl || null,
				commissionedAt: commissionedAt || null,
				parentImageId,
				// Clearing the variant link clears the label with it.
				variantLabel: parentImageId ? variantLabel || null : null
			})
			.where(eq(images.id, id));

		// Update tags: remove old, add new
		await db.delete(imageTags).where(eq(imageTags.imageId, id));

		if (tagNames) {
			const tagList = tagNames.split(',').map(sanitizeTag).filter(Boolean);
			for (const tagName of tagList) {
				let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
				if (!tag) {
					tag = await db.insert(tags).values({ name: tagName }).returning().get();
				}
				await db.insert(imageTags).values({ imageId: id, tagId: tag.id });
			}
		}

		// Update characters: remove old, add new
		await db.delete(imageCharacters).where(eq(imageCharacters.imageId, id));

		if (characterIds) {
			const ids = characterIds.split(',').map((cid) => Number(cid.trim())).filter(Boolean);
			for (const charId of ids) {
				await db.insert(imageCharacters).values({ imageId: id, characterId: charId });
			}
		}

		redirect(302, '/admin/images');
	},

	// Toggle this image as the owner character's canonical reference image.
	// `clear` un-sets it (only offered when this image is the current ref).
	reference: async ({ params, request, platform }) => {
		const db = getDb(platform!.env.DB);
		const id = Number(params.id);
		const data = await request.formData();
		const clear = data.get('clear') === 'on';

		if (!clear) {
			const image = await db
				.select({ id: images.id, parentImageId: images.parentImageId })
				.from(images)
				.where(eq(images.id, id))
				.get();
			if (!image) return fail(404, { error: 'Image not found' });
			// /art excludes variants from both ref-sheet paths (SONA-18), so storing
			// this would be a designation nothing ever honors. Refuse it here rather
			// than let the admin report a reference sheet the public page ignores.
			if (image.parentImageId != null)
				return fail(400, {
					error: 'This image is a variant, so it cannot be the reference sheet. Use its parent image instead.'
				});
		}

		const owner = await db
			.select({ id: characters.id })
			.from(characters)
			.where(eq(characters.isOwner, true))
			// first owner by name — must match the loads' find() over name-ordered characters
			.orderBy(characters.name)
			.get();
		if (!owner) return fail(400, { error: 'No owner character' });

		await db
			.update(characters)
			.set({ referenceImageId: clear ? null : id })
			.where(eq(characters.id, owner.id));

		return { referenceCleared: clear };
	}
} satisfies Actions;
