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
 * handle regardless of what's under the finger). The hit test is SCOPED to the
 * dragged row's own list: VrAvatarForm mounts TWO reorderable lists on one
 * page, and an unscoped test resolved the foreign list's index (R2-T7).
 * `dragIndex` = the row being dragged; `overIndex` = where it would drop (for
 * the insertion highlight). The drag only ever starts from the handle, so it
 * doesn't fight other row interactions.
 *
 * Keyboard path (a11y): the same handle answers ArrowUp/ArrowDown by swapping
 * the row one step, and `announcement` feeds an always-mounted polite live
 * region so the move is announced ("Moved to position 2 of 5").
 */

/** Keyboard move target for `key` on row `i` of `count` rows, or null for a
 * non-arrow key / an out-of-bounds step. Pure — unit-tested directly. */
export function keyboardMoveTarget(key: string, i: number, count: number): number | null {
	const to = key === 'ArrowUp' ? i - 1 : key === 'ArrowDown' ? i + 1 : null;
	return to === null || to < 0 || to >= count ? null : to;
}

/** The move a pointer-up commits, or null for the no-op cases (no drag in
 * flight, no target row, dropped on itself). Pure — unit-tested directly. */
export function dropTarget(
	from: number | null,
	to: number | null
): { from: number; to: number } | null {
	return from === null || to === null || from === to ? null : { from, to };
}

/** Row index under the pointer, scoped to `container` (the dragged row's own
 * list) — a matching row in ANOTHER list on the page resolves to null instead
 * of a foreign index (R2-T7). Pure over the element surface it touches. */
export function hitTestIndex(el: Element | null, container: Element | null): number | null {
	const row = el?.closest<HTMLElement>('[data-reorder-index]') ?? null;
	if (!row || !container || !container.contains(row)) return null;
	return Number(row.dataset.reorderIndex);
}

export class DragReorder {
	dragIndex = $state<number | null>(null);
	overIndex = $state<number | null>(null);
	/** Render inside an always-mounted aria-live="polite" element. */
	announcement = $state('');

	#count: () => number;
	#move: (from: number, to: number) => void;
	#onMoved?: () => void;
	/** The dragged row's list element, captured at pointerdown — scopes the
	 * hit test to this instance's rows. */
	#container: Element | null = null;

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
		const handle = ev.currentTarget as HTMLElement;
		handle.setPointerCapture(ev.pointerId);
		this.#container = handle.closest('[data-reorder-index]')?.parentElement ?? null;
		this.dragIndex = i;
		this.overIndex = i;
	}

	handlePointerMove(ev: PointerEvent) {
		if (this.dragIndex === null) return;
		const idx = hitTestIndex(
			document.elementFromPoint(ev.clientX, ev.clientY),
			this.#container
		);
		if (idx !== null) this.overIndex = idx;
	}

	handlePointerUp() {
		const drop = dropTarget(this.dragIndex, this.overIndex);
		this.reset();
		if (drop) this.#apply(drop.from, drop.to);
	}

	reset() {
		this.dragIndex = null;
		this.overIndex = null;
		this.#container = null;
	}

	/** Arrow-key path on the drag handle: ArrowUp/ArrowDown move the row one step. */
	handleKeydown(i: number, ev: KeyboardEvent) {
		const to = keyboardMoveTarget(ev.key, i, this.#count());
		if (to === null) return;
		ev.preventDefault();
		this.#apply(i, to);
	}

	#apply(from: number, to: number) {
		this.#move(from, to);
		this.announcement = m.admin_reorder_moved({ position: to + 1, total: this.#count() });
		this.#onMoved?.();
	}
}
