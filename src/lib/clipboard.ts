// Pure helpers for the upload page's paste-from-clipboard support. The DOM
// paste event lives in the component; everything here is testable in isolation.

/** Minimal shape of a `DataTransferItem` we depend on. */
export type ClipboardItemLike = {
	kind: string;
	type: string;
	getAsFile(): File | null;
};

const IMAGE_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

/** File extension for an image mime type, falling back to its subtype. */
export function extFromType(type: string): string {
	return IMAGE_EXT[type] ?? (type.split('/')[1] || 'png');
}

/**
 * Browsers name pasted bitmaps generically ("image.png"), which collides on the
 * duplicate check and reads poorly in the queue. Only those get renamed; a real
 * filename pasted from a file manager is kept.
 */
export function needsRename(name: string): boolean {
	return !name || /^image\.\w+$/i.test(name);
}

/** `pasted-YYYYMMDD-HHMMSS[-N].ext` for a pasted image. */
export function pastedFileName(date: Date, ext = 'png', index?: number): string {
	const p = (n: number) => String(n).padStart(2, '0');
	const stamp =
		`${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
		`-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
	const suffix = index === undefined ? '' : `-${index}`;
	return `pasted-${stamp}${suffix}.${ext}`;
}

/** Pull image files out of clipboard items, giving generic names a distinct one. */
export function extractImageFiles(
	items: Iterable<ClipboardItemLike>,
	now: () => Date = () => new Date()
): File[] {
	const imageItems = Array.from(items).filter(
		(it) => it.kind === 'file' && it.type.startsWith('image/')
	);
	const date = now();
	const files: File[] = [];
	imageItems.forEach((it, i) => {
		const file = it.getAsFile();
		if (!file) return;
		if (needsRename(file.name)) {
			const name = pastedFileName(date, extFromType(file.type), imageItems.length > 1 ? i + 1 : undefined);
			files.push(new File([file], name, { type: file.type }));
		} else {
			files.push(file);
		}
	});
	return files;
}

/**
 * Whether a paste carrying image(s) should be routed to the uploader. When the
 * cursor is in a text field and the clipboard also has text, we defer to the
 * normal text paste rather than hijacking it.
 */
export function shouldHandleImagePaste(o: {
	imageCount: number;
	hasText: boolean;
	focusInEditable: boolean;
}): boolean {
	if (o.imageCount === 0) return false;
	if (o.focusInEditable && o.hasText) return false;
	return true;
}
