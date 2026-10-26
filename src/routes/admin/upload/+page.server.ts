import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, collections, tags, images, characters } from '$lib/server/db/schema';
import { eq, isNull, sql, count as countFn } from 'drizzle-orm';
import { slugify } from '$lib/server/slugify';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { variantAssignmentError, MAX_VARIANT_SET } from '$lib/server/variants';
import { checkUnhide, clearKeepPrivate } from '$lib/server/artist-visibility';
import {
	MAX_IMAGE_TAGS,
	MAX_TAGS_INPUT_LENGTH,
	readTagInput,
	replaceImageTags
} from '$lib/server/image-tags';
import * as m from '$lib/paraglide/messages';
import { resolveFuzzysearchKey } from '$lib/server/fuzzysearch';
import { parseId } from '$lib/server/commissions';
import { commissionGateView } from '$lib/server/commission-gate';
import { isCalendarDate } from '$lib/commissions';
import {
	checkCommissionUpload,
	insertLinkedPiece,
	loadUploadPrefill
} from '$lib/server/commission-gallery';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	// Add to gallery from a commission entry (SONA-236): the prefill carries only
	// what loadUploadPrefill allows. An id that names no entry is a dead link.
	const commissionParam = url.searchParams.get('commission');
	let prefill = null;
	let commissionGate = null;
	if (commissionParam !== null) {
		const id = parseId(commissionParam);
		prefill = id === null ? null : await loadUploadPrefill(db, id);
		if (!prefill) error(404, 'Entry not found');
		// While the gate is closed the save refuses, so the page says so before
		// any file goes up, instead of after.
		commissionGate = await commissionGateView(db, platform?.env);
	}

	const [allArtists, allCollections, allTags, allCharacters, parentCandidates, lookupKey] =
		await Promise.all([
			db.select().from(artists).orderBy(artists.name),
			db.select().from(collections).orderBy(collections.name),
			db.select().from(tags).orderBy(tags.name),
			db.select().from(characters).orderBy(characters.name),
			// For "add as variants of an existing piece": parents only (one level).
			db
				.select({ id: images.id, title: images.title })
				.from(images)
				.where(isNull(images.parentImageId))
				.orderBy(images.title),
			// In the batch, not after it: a fork without the deploy secret reads the
			// stored key from D1, and awaited below this it cost a serial round trip
			// on every page load.
			resolveFuzzysearchKey(db, platform?.env)
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
		// Presence only — the key itself never leaves the server. Without one,
		// "Look up artist" is not offered at all (SONA-156). An upload from an
		// entry doesn't offer it either: the entry already names the artist, and
		// the lookup sends the image to FuzzySearch.
		lookupEnabled: !!lookupKey && !prefill,
		prefill,
		commissionGate,
		ownerCharacter: ownerCharacter && {
			name: ownerCharacter.name,
			// A designation already exists on some image — checking the box replaces it.
			hasReference: ownerCharacter.referenceImageId != null
		}
	};
};

// Applies the shared tag/character rows to one inserted image.
async function attachTagsAndCharacters(
	db: ReturnType<typeof getDb>,
	imageId: number,
	tagNames: string,
	characterIds: string
) {
	// The same write the edit form and the Suggest tags page use, so all three
	// paths dedupe and sanitize identically. An upload with an empty Tags field
	// skips the call: the image was just inserted, so the delete that write opens
	// with would run against a fresh row, once per tile in a variant set. The
	// edit form still calls it with an empty field, where the delete is the point.
	if (tagNames) await replaceImageTags(db, imageId, tagNames);

	if (characterIds) {
		const ids = characterIds.split(',').map((id) => Number(id.trim())).filter(Boolean);
		// One statement that links only the characters that still exist. A
		// character deleted in another tab since the form loaded is skipped, rather
		// than failing the foreign key after the piece (and, from an entry, its
		// link) is already saved. The ids ride in as one bound JSON array, as in
		// image-tags.ts, so a long selection stays one parameter.
		if (ids.length > 0) {
			await db.run(
				sql`INSERT INTO image_characters (image_id, character_id)
					SELECT ${imageId}, id FROM characters WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
			);
		}
	}
}

/** Whether a write failed because another save took the image's slug. */
function slugTaken(e: unknown): boolean {
	for (let c: unknown = e; c instanceof Error; c = c.cause) {
		if (/UNIQUE constraint failed: images\.slug/.test(c.message)) return true;
	}
	return false;
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
		// Read raw and checked below before anything shortens it: the 500-character
		// cut this field used to take ran BEFORE the count guard, so a hundred
		// ordinary names lost their tail mid-word and the fragment uploaded as a
		// success.
		const tagsRaw = String(data.get('tags') ?? '');
		const characterIds = (data.get('characters') as string)?.trim();
		const nsfw = data.get('nsfw') === 'on';
		const published = data.get('published') !== 'on';
		const sourcePostUrl = sanitizeUrl(data.get('sourcePostUrl') as string);
		const commissionedAt = (data.get('commissionedAt') as string)?.trim();

		// Batch fields: `count` tiles, each with indexed hidden inputs. `count` of 1
		// with no group target is the classic single upload.
		const count = Number(data.get('count')) || 1;
		const existingParentIdRaw = (data.get('existingParentId') as string)?.trim();
		// Set when the upload comes from a commission entry (Add to gallery).
		const commissionIdRaw = (data.get('commissionId') as string | null)?.trim() ?? '';
		const parentIndex = Number(data.get('parentIndex')) || 0;

		if (count < 1 || count > MAX_VARIANT_SET) {
			return fail(400, { error: `A variant set is 1–${MAX_VARIANT_SET} files` });
		}

		// Refused, not truncated, and before anything is inserted: an upload that
		// silently dropped tags would report success without them.
		const tagInput = readTagInput(tagsRaw);
		if (tagInput.problem === 'too_long') {
			return fail(400, { error: m.admin_field_tags_too_long({ max: MAX_TAGS_INPUT_LENGTH }) });
		}
		if (tagInput.problem === 'too_many') {
			return fail(400, { error: m.admin_field_tags_too_many({ max: MAX_IMAGE_TAGS }) });
		}
		const tagNames = tagInput.value;

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

		// Before anything is written: the entry exists, the gate is open, its
		// status allows it, and the group target matches the entry.
		let entry: { id: number; imageId: number | null } | null = null;
		if (commissionIdRaw) {
			const check = await checkCommissionUpload(
				db,
				platform?.env,
				commissionIdRaw,
				existingParent ? existingParent.id : null
			);
			if (!check.ok) return fail(check.status, check.data);
			entry = check.entry;
		}

		// A new published piece by a Keep private artist makes them public, so ask
		// first (SONA-236). Variants added to an existing piece aren't public work
		// on their own.
		const willPublish = entry ? data.get('commissionVisibility') === 'public' : published;
		const { refusal, unhide } = await checkUnhide(db, data, willPublish && !existingParent ? [resolvedArtistId] : []);
		if (refusal) return refusal;

		const shared = {
			artistId: resolvedArtistId,
			collectionId: collectionId ? Number(collectionId) : null,
			// From an entry the piece stays private unless the form says public in so
			// many words: artists often ask clients to wait until they post first, and
			// a form that lost its checkbox shouldn't publish.
			published: willPublish,
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
			const parentValues = {
				title,
				slug: await freeSlug(db, slugify(title), usedSlugs),
				imageUrl: parentTile.imageUrl,
				width: parentTile.width,
				height: parentTile.height,
				fileSize: parentTile.fileSize,
				nsfw: parentTile.nsfw,
				...shared
			};
			if (entry) {
				// One batch inserts the piece and links the entry; a save that lost a
				// race with another inserts nothing.
				// The browser's own date, for an empty Delivered date (open question
				// Q17, built as drawn). Anything that isn't a date is ignored.
				const sentDate = data.get('commissionDeliveredOn');
				const deliveredOn = typeof sentDate === 'string' && isCalendarDate(sentDate) ? sentDate : null;
				let linkedId: number | null;
				try {
					linkedId = await insertLinkedPiece(db, entry.id, parentValues, deliveredOn);
				} catch (e) {
					if (!slugTaken(e)) throw e;
					// Another upload took the slug after freeSlug looked. The batch rolled
					// back whole, so nothing was written: one more try with a fresh slug.
					// A 409 would tell the owner the entry was added when it wasn't.
					parentValues.slug = await freeSlug(db, slugify(title), usedSlugs);
					linkedId = await insertLinkedPiece(db, entry.id, parentValues, deliveredOn);
				}
				if (linkedId === null) {
					// The entry changed between the checks and the batch: the same checks,
					// run again, say how. Passing them now can only mean the batch lost a
					// race the checks didn't see, so it answers as a second save would.
					const again = await checkCommissionUpload(db, platform?.env, String(entry.id), null);
					return again.ok ? fail(409, { commission: 'just_added', imageId: null }) : fail(again.status, again.data);
				}
				parentDbId = linkedId;
			} else {
				const parentRow = await db.insert(images).values(parentValues).returning({ id: images.id }).get();
				parentDbId = parentRow.id;
			}

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
			await clearKeepPrivate(db, unhide);
			await attachTagsAndCharacters(db, parentDbId, tagNames, characterIds);
			variantTiles = tiles.filter((_, i) => i !== parentIndex).map((tile, i) => ({ tile, n: i + 1 }));
		}

		const baseTitle = existingParent ? existingParent.title : title;
		const variantIds: number[] = [];
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
			variantIds.push(variantRow.id);
		}

		// Optionally designate the primary (parent) image as the owner character's
		// reference sheet — same semantics as the edit-page control.
		if (data.get('useAsReference') === 'on') {
			// first owner by name — must match the loads' find() over name-ordered characters
			const owner = await db.select({ id: characters.id }).from(characters).where(eq(characters.isOwner, true)).orderBy(characters.name).get();
			if (owner) {
				await db.update(characters).set({ referenceImageId: parentDbId }).where(eq(characters.id, owner.id));
			}
		}

		// From an entry, back to the ledger, whose notice reads what was saved.
		if (entry) {
			const variants = existingParent ? `&variants=${variantIds.join(',')}` : '';
			redirect(302, `/admin/commissions?added=${entry.id}${variants}`);
		}
		redirect(302, '/admin/images');
	}
} satisfies Actions;
