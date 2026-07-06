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

/** Input types whose paste should stay a text paste, never an image hijack. */
const TEXT_INPUT_TYPES = new Set([
	'text',
	'search',
	'url',
	'email',
	'password',
	'tel',
	'number'
]);

/** File extension for an image mime type, falling back to its subtype. */
export function extFromType(type: string): string {
	return IMAGE_EXT[type] ?? (type.split('/')[1] || 'png');
}

/**
 * Browsers name pasted bitmaps generically ("image.png"). We give those a unique
 * timestamped name so the queue reads clearly and repeated pastes don't clash.
 * Tradeoff: a unique name means the fileName+size duplicate check can no longer
 * recognize a paste as a re-upload of existing content — pasted images always
 * read as new. A real filename (pasted from a file manager) is kept so its
 * dedupe still works.
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
	const date = now();
	const files = Array.from(items)
		.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
		.map((it) => it.getAsFile())
		.filter((f): f is File => f !== null);
	// The -N suffix numbers only the renamed files, so a lone generic file next
	// to a real-named one stays unsuffixed rather than jumping to "-2".
	const renameCount = files.filter((f) => needsRename(f.name)).length;
	let renamed = 0;
	return files.map((f) => {
		if (!needsRename(f.name)) return f;
		renamed += 1;
		const name = pastedFileName(date, extFromType(f.type), renameCount > 1 ? renamed : undefined);
		return new File([f], name, { type: f.type });
	});
}

/**
 * Whether an element receiving focus accepts a text paste (TEXTAREA,
 * contenteditable, or a text-like INPUT). Checkboxes/radios/selects/buttons
 * do not, so an image paste while one is focused should still upload.
 */
export function isTextEditable(el: {
	tagName: string;
	type?: string;
	isContentEditable?: boolean;
}): boolean {
	if (el.isContentEditable) return true;
	if (el.tagName === 'TEXTAREA') return true;
	if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has(el.type ?? 'text');
	return false;
}

/**
 * Whether a paste carrying image(s) should be routed to the uploader. We never
 * hijack a paste while a text-editable field is focused — the user pastes an
 * image by clicking off the field first (standard editor behavior).
 */
export function shouldHandleImagePaste(o: { imageCount: number; focusInEditable: boolean }): boolean {
	if (o.imageCount === 0) return false;
	if (o.focusInEditable) return false;
	return true;
}
