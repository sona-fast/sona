import { isAnimatedSource } from './img';

export { isAnimatedSource, rawFallback } from './img';

export function plural(count: number, singular: string, pluralForm?: string): string {
	const word = count === 1 ? singular : (pluralForm ?? singular + 's');
	return `${count} ${word}`;
}

/**
 * The one date format across the whole UI: dotted `YYYY.MM.DD` (e.g. 2027.01.08).
 * Every rendered date routes through this — no inline hand-formatting.
 * Date-only strings (YYYY-MM-DD) format directly (no Date parse, so no timezone
 * shift); ISO timestamps render their LOCAL calendar date.
 */
export function formatDate(dateStr: string): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr.slice(0, 10).replaceAll('-', '.');
	const date = new Date(dateStr);
	const mo = String(date.getMonth() + 1).padStart(2, '0');
	const da = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}.${mo}.${da}`;
}

/**
 * A start–end date range in the same dotted style. A single-day (or open) range
 * is just the start date; a same-year range trims the year off the end for
 * brevity (2026.09.12 → 09.14).
 */
export function formatDateRange(start: string, end: string | null | undefined): string {
	if (!end || end === start) return formatDate(start);
	const sameYear = start.slice(0, 4) === end.slice(0, 4);
	const endFmt = formatDate(end);
	return `${formatDate(start)} → ${sameYear ? endFmt.slice(5) : endFmt}`;
}

/**
 * Route an image URL through Cloudflare Image Transformations so grids
 * and thumbnails don't download multi-MB originals. In dev the CF edge
 * isn't available, so fall through to the raw URL.
 */
export function cdnImage(src: string | null | undefined, width = 800, quality = 75): string {
	if (!src) return '';
	if (import.meta.env.DEV) return src;
	// Animated GIFs bypass the transform: anim=false freezes them to frame 1,
	// and off-zone sources (UploadThing, non-resize R2) 403 the transform → broken img.
	if (isAnimatedSource(src)) return src;
	return `/cdn-cgi/image/width=${width},quality=${quality},fit=scale-down,format=auto,anim=false/${src}`;
}
