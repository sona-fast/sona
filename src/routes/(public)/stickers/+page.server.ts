import { getReadDb } from '$lib/server/db';
import { listPacks, findStickers, topEmojis, listStickerArtists } from '$lib/server/stickers';
import { emojiForKeyword, containsEmoji } from '$lib/server/emoji-keywords';
import { getMode } from '$lib/server/furtrack';
import { stickerPacks } from '$lib/server/db/schema';
import { inArray } from 'drizzle-orm';
import { vrTabEnabled } from '$lib/server/vr-gate';
import { fursuitPhotosExist } from '$lib/server/fursuit-import';
import { PROBE_TIMEOUT_MS } from '$lib/server/nav-gating';
import { withTimeout } from '$lib/server/timeout';
import type { PageServerLoad } from './$types';

// Cap free-text length before keyword expansion (cheap DoS guard).
const MAX_Q = 64;

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getReadDb(platform!.env.DB);

	const emojiParam = url.searchParams.get('emoji') ?? '';
	const artistParam = url.searchParams.get('artist') ?? '';
	const q = (url.searchParams.get('q') ?? '').slice(0, MAX_Q);

	const hasFilter = !!(emojiParam || artistParam || q);

	// Whether to show the Fursuit pill — gated on the FurTrack flag the same way
	// the gallery is, so both pages agree. The shared cached probe (bounded,
	// fail-closed like the gallery's — a false-open pill links to a view that
	// silently falls back) replaces the old per-request COUNT; the ternary
	// keeps it off the D1 hot path when the feature is off (the prod default).
	// VR Avatars pill mirrors the gallery's rule (shared vrTabEnabled probe):
	// visible only once a published avatar exists, so the tab bars never
	// disagree. Everything rides one Promise.all — this is a hot public page.
	const [topEmojiList, stickerArtists, vrEnabled, fursuitEnabled] = await Promise.all([
		topEmojis(db),
		listStickerArtists(db),
		vrTabEnabled(db),
		getMode(platform!.env) !== 'off'
			? withTimeout(fursuitPhotosExist(db), PROBE_TIMEOUT_MS, false)
			: Promise.resolve(false)
	]);

	if (hasFilter) {
		// Resolve emoji glyphs to filter on. A chip param is ALWAYS an exact glyph
		// (no keyword expansion, so text-presentation emoji like ❤️ match). Free-text
		// `q` is a pasted glyph if it contains one, else a keyword to expand.
		let emojis: string[] | undefined;
		if (emojiParam) {
			emojis = [emojiParam];
		} else if (q) {
			if (containsEmoji(q)) {
				emojis = [q];
			} else {
				const expanded = emojiForKeyword(q);
				// A keyword that maps to nothing → force empty results (sentinel).
				emojis = expanded.length > 0 ? expanded : ['__no_match__'];
			}
		}

		const artistId = artistParam ? (parseInt(artistParam, 10) || undefined) : undefined;

		const results = await findStickers(db, { emojis, artistId, publishedOnly: true });
		const packIds = [...new Set(results.map((s) => s.packId))];
		const packCount = packIds.length;

		// Fetch pack slugs so StickerCard can build correct URLs.
		let packSlugById: Record<number, string> = {};
		if (packIds.length > 0) {
			const packRows = await db
				.select({ id: stickerPacks.id, slug: stickerPacks.slug })
				.from(stickerPacks)
				.where(inArray(stickerPacks.id, packIds));
			for (const row of packRows) packSlugById[row.id] = row.slug;
		}

		return {
			mode: 'filtered' as const,
			stickers: results,
			packSlugById,
			packCount,
			topEmojis: topEmojiList,
			artists: stickerArtists,
			fursuitEnabled,
			vrEnabled,
			filters: { emoji: emojiParam, artist: artistParam, q }
		};
	}

	const packs = await listPacks(db, { publishedOnly: true });

	return {
		mode: 'packs' as const,
		packs,
		topEmojis: topEmojiList,
		artists: stickerArtists,
		fursuitEnabled,
		vrEnabled,
		filters: { emoji: '', artist: '', q: '' }
	};
};
