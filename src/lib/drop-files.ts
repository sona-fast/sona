import type { Attachment } from 'svelte/attachments';
import { isTextEditable } from './clipboard';

/**
 * Does a file satisfy an `accept` attribute string? Handles the three forms the
 * attribute allows: an extension (`.vrm`), an exact MIME type (`image/png`) and
 * a wildcard MIME type (`image/*`). Extensions match case-insensitively; an
 * empty accept string accepts everything.
 *
 * Pure so it can be unit-tested without a DOM.
 */
export function matchesAccept(file: { name: string; type: string }, accept: string): boolean {
	const patterns = accept
		.split(',')
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);
	if (!patterns.length) return true;
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return patterns.some((p) => {
		if (p.startsWith('.')) return name.endsWith(p);
		if (p.endsWith('/*')) return type.startsWith(p.slice(0, -1));
		return type === p;
	});
}

/** Whether a drag carries files at all. Dragged text or an image element also
 * fires dragover; a zone must not light up for those. A drag with no
 * DataTransfer, or none that lists 'Files', carries none. */
function carriesFiles(e: DragEvent): boolean {
	return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Did the drag land on a text field of the zone's own markup? That is the only
 * place a pass-through zone may leave a drag uncancelled: a link dragged from
 * another tab (`text/uri-list`, no `Files`) dropped on the zone's padding would
 * otherwise navigate the tab away from the form.
 *
 * Duck-typed rather than `instanceof HTMLElement` because these tests run in a
 * DOM-less node environment; `isTextEditable` only reads the three fields below.
 */
function droppedOnTextField(e: DragEvent): boolean {
	const t = e.target as Parameters<typeof isTextEditable>[0] | null;
	// The cast is a claim, not a check: an EventTarget can be the document or the
	// window, neither of which has a tagName.
	if (typeof t?.tagName !== 'string') return false;
	return isTextEditable(t);
}

/**
 * Window-level guard for the admin forms that host drop zones: a file dropped
 * anywhere the zones don't cover (the hint under a zone, a media row, blank
 * form) would otherwise navigate the tab to the file and lose the form. Leaves
 * an event a zone already handled alone, and ignores non-file drags. That is
 * narrower than the zones on purpose: a zone can cancel every drag because it
 * holds no text field, but this runs for the whole page, and cancelling a text
 * or link drag here would block dropping text into the form's own inputs.
 */
export function swallowStrayFileDrop(e: DragEvent) {
	if (e.defaultPrevented || !carriesFiles(e)) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
}

/** Split files into those an accept string admits and those it refuses. Used by
 * the drop handler and by the pickers, whose `accept` attribute is only a filter
 * the OS dialog can override. */
export function partitionByAccept(files: File[], accept: string): { accepted: File[]; rejected: File[] } {
	const accepted: File[] = [];
	const rejected: File[] = [];
	for (const f of files) (matchesAccept(f, accept) ? accepted : rejected).push(f);
	return { accepted, rejected };
}

/**
 * Drag-and-drop for an upload zone (SONA-216): highlights the element with
 * `drag-over` while a file is over it and hands the dropped files to `onFiles`.
 *
 * The `accept` attribute only constrains the file PICKER — a dropped file skips
 * it entirely — so files are partitioned here and the caller reports the
 * rejected ones without ever posting them.
 *
 * `passThroughNonFileDrags` is for a zone that CONTAINS text fields (the upload
 * page's tile grid holds the variant labels): a zone with no fields inside can
 * cancel every drag, but cancelling a text drag over this one would block
 * dropping a selection into a label. Off by default, and even when on it only
 * passes a drag through that landed ON one of those fields — leaving a drag
 * uncancelled is only safe where the field it hit will handle it.
 */
export function dropFiles(opts: {
	accept: string;
	onFiles: (files: File[], rejected: File[]) => void;
	disabled?: () => boolean;
	passThroughNonFileDrags?: boolean;
}): Attachment<HTMLElement> {
	return (node) => {
		// preventDefault on dragenter/dragover is what makes the element a drop
		// target at all; without it the browser opens the file instead. It runs
		// even while disabled, and for drags that carry no files (a dragged
		// thumbnail, a link from another tab), so nothing dropped on a zone ever
		// navigates the tab; only the highlight and cursor are reserved for files.
		// An event something else already cancelled is left alone so this zone
		// never overrides that handler's dropEffect.
		const over = (e: DragEvent) => {
			if (e.defaultPrevented) return;
			if (!carriesFiles(e)) {
				// Leave a non-file drag entirely alone where the zone wraps text
				// fields, so the browser's own text-drop handling still runs — but
				// only on the field itself. Anywhere else in the zone it is cancelled
				// like any other zone would.
				if (opts.passThroughNonFileDrags && droppedOnTextField(e)) return;
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
				return;
			}
			e.preventDefault();
			const off = opts.disabled?.() ?? false;
			if (e.dataTransfer) e.dataTransfer.dropEffect = off ? 'none' : 'copy';
			if (!off) node.classList.add('drag-over');
		};
		const leave = () => node.classList.remove('drag-over');
		const drop = (e: DragEvent) => {
			node.classList.remove('drag-over');
			if (e.defaultPrevented) return;
			// Same reason as `over`: a text drop on one of this zone's fields belongs
			// to that field, not here. A non-file drop anywhere else still gets
			// cancelled below.
			if (opts.passThroughNonFileDrags && !carriesFiles(e) && droppedOnTextField(e)) return;
			e.preventDefault();
			if (opts.disabled?.()) return;
			const files = [...(e.dataTransfer?.files ?? [])];
			if (!files.length) return;
			const { accepted, rejected } = partitionByAccept(files, opts.accept);
			opts.onFiles(accepted, rejected);
		};
		node.addEventListener('dragenter', over);
		node.addEventListener('dragover', over);
		node.addEventListener('dragleave', leave);
		node.addEventListener('drop', drop);
		return () => {
			node.removeEventListener('dragenter', over);
			node.removeEventListener('dragover', over);
			node.removeEventListener('dragleave', leave);
			node.removeEventListener('drop', drop);
		};
	};
}
