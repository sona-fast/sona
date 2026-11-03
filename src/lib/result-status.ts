/**
 * The text of the screen-reader status regions on the gallery and sticker
 * pages. Filter changes keep focus on the control, so this text is how a
 * screen reader hears that the results changed: the count, then each active
 * filter, so a change that keeps the count still changes the text.
 */
import * as m from '$lib/paraglide/messages';
import type { GallerySort } from '$lib/gallery';

type Options = { locale?: 'en' | 'ja' };

/** Joins status parts with the locale's list separator (", " or "、"). */
export function statusList(parts: string[], options: Options = {}): string {
	return parts.join(m.status_list_separator({}, options));
}

/** "Label: value" when the value is set, nothing when it isn't. */
function pair(label: string, value: string, options: Options): string[] {
	return value ? [m.gallery_status_filter({ label, value }, options)] : [];
}

const sortLabels: Record<GallerySort, (inputs: object, options: Options) => string> = {
	newest: m.gallery_sort_newest,
	oldest: m.gallery_sort_oldest,
	'commissioned-newest': m.gallery_sort_commissioned_newest,
	'commissioned-oldest': m.gallery_sort_commissioned_oldest
};

export type GalleryStatusInput = (
	| { view: 'fursuit'; count: number; photographer: string; event: string }
	| {
			view: 'artwork';
			count: number;
			search: string;
			tag: string;
			artist: string;
			character: string;
			sort: GallerySort;
	  }
) & { degraded?: boolean };

/**
 * Gallery: the count, each active filter, then the sort (artwork view only; the
 * fursuit view has no sort). A degraded load (the database timed out) says the
 * gallery couldn't load rather than reading the empty fallback as "0 artworks".
 */
export function galleryStatus(input: GalleryStatusInput, options: Options = {}): string {
	if (input.degraded) return m.gallery_status_unavailable({}, options);
	if (input.view === 'fursuit') {
		return statusList(
			[
				m.gallery_count_fursuit({ count: input.count }, options),
				...pair(m.gallery_filter_photographer({}, options), input.photographer, options),
				...pair(m.gallery_filter_event({}, options), input.event, options)
			],
			options
		);
	}
	return statusList(
		[
			m.gallery_count_artwork({ count: input.count }, options),
			...pair(m.gallery_status_search({}, options), input.search, options),
			...pair(m.gallery_filter_tag({}, options), input.tag, options),
			...pair(m.gallery_filter_artist({}, options), input.artist, options),
			...pair(m.gallery_filter_character({}, options), input.character, options),
			m.gallery_status_filter(
				{ label: m.gallery_filter_sort({}, options), value: sortLabels[input.sort]({}, options) },
				options
			)
		],
		options
	);
}

export type StickersStatusInput =
	| { filtered: false; packs: number }
	| { filtered: true; stickers: number; emoji: string; artist: string; packs: number };

/** /stickers: the pack count unfiltered; filtered, the sticker count, the emoji and artist, and the pack count. */
export function stickersStatus(input: StickersStatusInput, options: Options = {}): string {
	if (!input.filtered) return m.stickers_pack_count({ count: input.packs }, options);
	return statusList(
		[
			m.stickers_count({ count: input.stickers }, options),
			...pair(m.stickers_emojis_label({}, options), input.emoji, options),
			...pair(m.stickers_artist_label({}, options), input.artist, options),
			m.stickers_across_packs({ packs: input.packs }, options)
		],
		options
	);
}

/**
 * A pack page: the sticker count, then the emoji and the selected artists.
 * `null` in `artists` is the Unassigned group. The artists are joined with
 * " / " rather than a list format: the status parts are already joined with
 * commas (or 、), so "Alice, Bob, and Carol" would read as separate filters,
 * and in Japanese the list format's 、 is identical to the part separator.
 * A screen reader says "slash", which keeps the names one value.
 */
export function packStatus(
	input: { stickers: number; emoji: string; artists: (string | null)[] },
	options: Options = {}
): string {
	const names = input.artists.map((name) => name ?? m.stickers_artist_unassigned({}, options));
	const artists = names.join(' / ');
	return statusList(
		[
			m.stickers_count({ count: input.stickers }, options),
			...pair(m.stickers_emojis_label({}, options), input.emoji, options),
			...pair(m.stickers_artist_label({}, options), artists, options)
		],
		options
	);
}
