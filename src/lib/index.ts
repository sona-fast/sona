export function plural(count: number, singular: string, pluralForm?: string): string {
	const word = count === 1 ? singular : (pluralForm ?? singular + 's');
	return `${count} ${word}`;
}

/**
 * Format a date string for display, avoiding timezone shift issues.
 * Date-only strings (YYYY-MM-DD) are parsed as local time.
 * ISO timestamps are parsed normally.
 */
export function formatDate(
	dateStr: string,
	opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string {
	// Date-only string (e.g., "2025-08-29") — append T00:00:00 to parse as local time
	const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
		? new Date(dateStr + 'T00:00:00')
		: new Date(dateStr);
	return date.toLocaleDateString('en-US', opts);
}

/**
 * Route an image URL through Cloudflare Image Transformations so grids
 * and thumbnails don't download multi-MB originals. In dev the CF edge
 * isn't available, so fall through to the raw URL.
 */
export function cdnImage(src: string | null | undefined, width = 800, quality = 75): string {
	if (!src) return '';
	if (import.meta.env.DEV) return src;
	return `/cdn-cgi/image/width=${width},quality=${quality},fit=scale-down,format=auto,anim=false/${src}`;
}
