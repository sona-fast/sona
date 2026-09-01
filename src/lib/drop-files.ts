import type { Attachment } from 'svelte/attachments';

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
 */
export function dropFiles(opts: {
	accept: string;
	onFiles: (files: File[], rejected: File[]) => void;
	disabled?: () => boolean;
}): Attachment<HTMLElement> {
	return (node) => {
		// preventDefault on dragenter/dragover is what makes the element a drop
		// target at all; without it the browser opens the file instead. It runs
		// even while disabled so a drop on a busy zone is swallowed, not navigated.
		// A nested drop target (the Replace button inside the model card) handles
		// the event first; an outer swallow-only instance must not then override
		// its dropEffect, so an already-handled event is left alone.
		const over = (e: DragEvent) => {
			if (e.defaultPrevented) return;
			e.preventDefault();
			const off = opts.disabled?.() ?? false;
			if (e.dataTransfer) e.dataTransfer.dropEffect = off ? 'none' : 'copy';
			if (!off) node.classList.add('drag-over');
		};
		const leave = () => node.classList.remove('drag-over');
		const drop = (e: DragEvent) => {
			if (e.defaultPrevented) return;
			e.preventDefault();
			node.classList.remove('drag-over');
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
