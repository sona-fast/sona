// Which download formats a sticker can offer. Shared by the detail page (to
// render the DownloadMenu entries) and the download endpoint (to validate the
// ?format= query) so the two can never disagree about what's convertible.
//
// The rules mirror the storage model:
//   - 'video' rows are .webm, 'animated' rows are Lottie .json — native only.
//   - Static-raster rows ('png' | 'webp' format) serve their ORIGINAL file
//     (which may be .webp, .png, or .gif — GIFs are stored under format 'png'
//     because the schema enum has no 'gif').
//   - A PNG conversion is offered only when the original is a raster that is
//     not already PNG and does not animate (isAnimated=false): converting an
//     animated WebP/GIF through the image transform would flatten it to one
//     frame, so the option is omitted entirely rather than disabled.

export interface StickerDownloadInfo {
	format: 'png' | 'webp' | 'animated' | 'video';
	imageUrl: string;
	isAnimated: boolean;
}

export interface StickerDownloadOption {
	/** Value for the endpoint's ?format= query; 'original' maps to no query. */
	kind: 'original' | 'png';
	/** File extension the download will carry — drives the visible label. */
	ext: string;
}

/** Extension of the stored original file, from the storage rules above. */
export function originalExt(sticker: StickerDownloadInfo): string {
	if (sticker.format === 'video') return 'webm';
	if (sticker.format === 'animated') return 'json';
	const path = (() => {
		try {
			return new URL(sticker.imageUrl).pathname;
		} catch {
			return sticker.imageUrl;
		}
	})();
	const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match?.[1] ?? (sticker.format === 'png' ? 'png' : 'webp');
}

/** Options in menu order; index 0 is the primary (always the original). */
export function stickerDownloadOptions(sticker: StickerDownloadInfo): StickerDownloadOption[] {
	const ext = originalExt(sticker);
	const options: StickerDownloadOption[] = [{ kind: 'original', ext }];
	const isRaster = sticker.format === 'png' || sticker.format === 'webp';
	if (isRaster && !sticker.isAnimated && ext !== 'png') {
		options.push({ kind: 'png', ext: 'png' });
	}
	return options;
}
