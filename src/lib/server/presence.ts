import { and, eq, inArray } from 'drizzle-orm';
import { characters, images, imageTags, siteSettings, tags } from './db/schema';
import { getSettings, parseSonaColors, parseLines, type SiteSettings } from './settings';
import type { Database } from './db';

/**
 * Content-presence predicates (#42), shared by the /art and /share page loads
 * (which 404 when their content is absent) and the threePath splash (which
 * hides a card whose target page would 404). Keeping both sides on the same
 * predicate is the point: a card never links to a 404, and a reachable page
 * always has its card.
 */

// The reference sheet is the most recent published gallery image tagged this.
export const REFERENCE_TAG = 'reference';

/** The sona-details block the /art page renders, derived from settings. */
export function sonaDetails(settings: SiteSettings) {
	return {
		species: settings.sonaSpecies,
		build: settings.sonaBuild,
		keyFeatures: settings.sonaKeyFeatures,
		colors: parseSonaColors(settings.sonaColors),
		dos: parseLines(settings.sonaDos),
		donts: parseLines(settings.sonaDonts)
	};
}

/**
 * Content-presence predicate for /art (#42): present unless every content
 * source the page renders is absent — no ref sheet, no recent art, and no
 * sona details at all. Pure function over already-loaded data so the /art
 * load can reuse the rows it fetches for rendering without re-querying;
 * callers without those rows use probeArtContent instead.
 */
export function artHasContent(
	sona: ReturnType<typeof sonaDetails>,
	refSheet: unknown | null,
	recentArt: unknown[]
): boolean {
	return (
		refSheet !== null ||
		recentArt.length > 0 ||
		Boolean(sona.species || sona.build || sona.keyFeatures) ||
		sona.colors.length > 0 ||
		sona.dos.length > 0 ||
		sona.donts.length > 0
	);
}

/**
 * EXISTS-style evaluation of artHasContent for pages that don't render /art's
 * data (the splash card): settings first (cached per-isolate, usually zero
 * round-trips), then minimal limit-1 probes of the same three image sources
 * the /art load reads — designated ref sheet, reference-tag fallback, recent
 * SFW art — short-circuiting on the first hit.
 */
export async function probeArtContent(db: Database): Promise<boolean> {
	if (artHasContent(sonaDetails(await getSettings(db)), null, [])) return true;

	// Designated ref sheet: the first owner character by name — must match the
	// /art load's precedence query.
	const owner = await db
		.select({ referenceImageId: characters.referenceImageId })
		.from(characters)
		.where(eq(characters.isOwner, true))
		.orderBy(characters.name)
		.get();
	if (owner?.referenceImageId != null) {
		const designated = await db
			.select({ id: images.id })
			.from(images)
			.where(and(eq(images.id, owner.referenceImageId), eq(images.published, true)))
			.get();
		if (designated) return true;
	}

	const taggedRef = await db
		.select({ id: images.id })
		.from(images)
		.innerJoin(imageTags, eq(imageTags.imageId, images.id))
		.innerJoin(tags, eq(tags.id, imageTags.tagId))
		.where(and(eq(tags.name, REFERENCE_TAG), eq(images.published, true)))
		.limit(1)
		.get();
	if (taggedRef) return true;

	const recentArt = await db
		.select({ id: images.id })
		.from(images)
		.where(and(eq(images.published, true), eq(images.nsfw, false)))
		.limit(1)
		.get();
	return recentArt !== undefined;
}

/**
 * Content-presence predicate for /share (#42): /share's only dynamic content
 * sources are the contact rows — Telegram and email (the guidelines/tag copy
 * is static). With neither configured the page has no way to actually share
 * anything. Either source alone counts as present.
 *
 * Reads the two rows directly rather than via getSettings(): getSettings
 * swallows D1 errors into empty defaults, which would turn a transient DB blip
 * into a false absence. A direct select throws on failure instead, so each
 * caller picks its failure mode — the /share load lets the error surface
 * (→ 500 "retry" semantics, not a false 404 on a configured fork); the splash
 * catches it and fails open.
 */
export async function shareHasContent(db: Database): Promise<boolean> {
	const rows = await db
		.select({ value: siteSettings.value })
		.from(siteSettings)
		.where(inArray(siteSettings.key, ['contactEmail', 'telegramUrl']));
	return rows.some((r) => r.value);
}
