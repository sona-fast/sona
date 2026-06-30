import { getReadDb } from '$lib/server/db';
import { getPackBySlug } from '$lib/server/stickers';
import { emojiForKeyword, containsEmoji } from '$lib/server/emoji-keywords';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { StickerView } from '$lib/server/stickers';

const MAX_Q = 64;

export const load: PageServerLoad = async ({ platform, params, url }) => {
	const db = getReadDb(platform!.env.DB);
	const pack = await getPackBySlug(db, params.slug, { publishedOnly: true });
	if (!pack) error(404, 'Pack not found');

	const emojiParam = url.searchParams.get('emoji') ?? '';
	// Multi-select artist filter: repeated `?artist=` params. Each value is an
	// artist id, or the `unassigned` sentinel for null-artist (unattributed) stickers.
	const artistParams = url.searchParams.getAll('artist').filter((v) => v !== '');
	const q = (url.searchParams.get('q') ?? '').slice(0, MAX_Q);

	// Filter this pack's stickers (in load) by emoji / artist params. A chip param
	// is an exact glyph; free-text `q` is a pasted glyph or a keyword to expand.
	let stickers: StickerView[] = pack.stickers;

	if (emojiParam) {
		stickers = stickers.filter((s) => s.emojis.includes(emojiParam));
	} else if (q) {
		if (containsEmoji(q)) {
			stickers = stickers.filter((s) => s.emojis.includes(q));
		} else {
			const expanded = emojiForKeyword(q);
			stickers = expanded.length > 0
				? stickers.filter((s) => s.emojis.some((e) => expanded.includes(e)))
				: [];
		}
	}

	if (artistParams.length > 0) {
		// OR within the artist selection: keep a sticker if its artist is any of the
		// selected ids, or if `unassigned` is selected and the sticker has no artist.
		const selected = new Set(artistParams);
		stickers = stickers.filter((s) =>
			s.artist ? selected.has(String(s.artist.id)) : selected.has('unassigned')
		);
	}

	const hasFilter = !!(emojiParam || artistParams.length > 0 || q);

	return {
		pack,
		stickers,
		hasFilter,
		filters: { emoji: emojiParam, artist: artistParams, q }
	};
};
