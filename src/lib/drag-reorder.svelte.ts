import * as m from '$lib/paraglide/messages';

/**
 * Shared row-reorder behavior for admin list forms (sticker rows, VR credits,
 * VR showcase media) — one implementation instead of per-form copies.
 *
 * Pointer path: implemented with pointer events (not HTML5 drag-and-drop,
 * which never fires on touch) so it works on mobile too. The handle captures
 * the pointer; its `touch-action: none` stops the page from scrolling
 * mid-drag, and the row under the pointer is resolved via elementFromPoint
 * against a `data-reorder-index` attribute (capture makes events target the
 * handle regardless of what's under the finger). `dragIndex` = the row being
 * dragged; `overIndex` = where it would drop (for the insertion highlight).
 * The drag only ever starts from the handle, so it doesn't fight other row
 * interactions.
 *
 * Keyboard path (a11y): the same handle answers ArrowUp/ArrowDown by swapping
 * the row one step, and `announcement` feeds an always-mounted polite live
 * region so the move is announced ("Moved to position 2 of 5").
 */
export class DragReorder {
	dragIndex = $state<number | null>(null);
	overIndex = $state<number | null>(null);
	/** Render inside an always-mounted aria-live="polite" element. */
	announcement = $state('');

	#count: () => number;
	#move: (from: number, to: number) => void;
	#onMoved?: () => void;

	constructor(opts: {
		/** Current number of rows. */
		count: () => number;
		/** Apply the reorder to the backing array (splice out `from`, insert at `to`). */
		move: (from: number, to: number) => void;
		/** Optional hook after any successful move (e.g. clear an index-keyed selection). */
		onMoved?: () => void;
	}) {
		this.#count = opts.count;
		this.#move = opts.move;
		this.#onMoved = opts.onMoved;
	}

	handlePointerDown(i: number, ev: PointerEvent) {
		if (ev.button !== 0) return; // primary button / touch only
		ev.preventDefault();
		(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
		this.dragIndex = i;
		this.overIndex = i;
	}

	handlePointerMove(ev: PointerEvent) {
		if (this.dragIndex === null) return;
		const row = document
			.elementFromPoint(ev.clientX, ev.clientY)
			?.closest<HTMLElement>('[data-reorder-index]');
		if (row) this.overIndex = Number(row.dataset.reorderIndex);
	}

	handlePointerUp() {
		const from = this.dragIndex;
		const to = this.overIndex;
		this.reset();
		if (from === null || to === null || from === to) return;
		this.#apply(from, to);
	}

	reset() {
		this.dragIndex = null;
		this.overIndex = null;
	}

	/** Arrow-key path on the drag handle: ArrowUp/ArrowDown move the row one step. */
	handleKeydown(i: number, ev: KeyboardEvent) {
		const to = ev.key === 'ArrowUp' ? i - 1 : ev.key === 'ArrowDown' ? i + 1 : null;
		if (to === null || to < 0 || to >= this.#count()) return;
		ev.preventDefault();
		this.#apply(i, to);
	}

	#apply(from: number, to: number) {
		this.#move(from, to);
		this.announcement = m.admin_reorder_moved({ position: to + 1, total: this.#count() });
		this.#onMoved?.();
	}
}
