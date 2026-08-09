import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { keyboardMoveTarget, dropTarget, hitTestIndex } from './drag-reorder.svelte';

// DragReorder ships REFACTORED sticker-row reordering plus the two new VR
// lists (R2-T3): the decision logic lives in pure helpers tested here (the
// runes class itself needs a Svelte compile, so it is pinned by source below —
// no component test runner in this repo, per the DownloadMenu precedent).

describe('keyboardMoveTarget', () => {
	it('moves one step up/down inside the bounds', () => {
		expect(keyboardMoveTarget('ArrowUp', 2, 5)).toBe(1);
		expect(keyboardMoveTarget('ArrowDown', 2, 5)).toBe(3);
	});

	it('no-ops at the boundaries (first row up, last row down)', () => {
		expect(keyboardMoveTarget('ArrowUp', 0, 5)).toBeNull();
		expect(keyboardMoveTarget('ArrowDown', 4, 5)).toBeNull();
		expect(keyboardMoveTarget('ArrowDown', 0, 1)).toBeNull();
	});

	it('ignores non-arrow keys', () => {
		for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft', 'ArrowRight', 'a']) {
			expect(keyboardMoveTarget(key, 2, 5)).toBeNull();
		}
	});
});

describe('dropTarget', () => {
	it('commits a mid-list move', () => {
		expect(dropTarget(1, 3)).toEqual({ from: 1, to: 3 });
		expect(dropTarget(3, 0)).toEqual({ from: 3, to: 0 });
	});

	it('no-ops when nothing is dragged, nothing is hovered, or from === to', () => {
		expect(dropTarget(null, 2)).toBeNull();
		expect(dropTarget(2, null)).toBeNull();
		expect(dropTarget(2, 2)).toBeNull();
	});
});

describe('hitTestIndex — scoped to the dragged row’s own list (R2-T7)', () => {
	// Minimal element stand-ins: only the surface the helper touches.
	function row(index: number, list: { contains: (el: unknown) => boolean }) {
		const el = {
			dataset: { reorderIndex: String(index) },
			closest: (sel: string) => (sel === '[data-reorder-index]' ? el : null)
		};
		return { el: el as unknown as Element, list };
	}
	function list(rows: unknown[] = []) {
		return { contains: (el: unknown) => rows.includes(el) };
	}

	it('resolves a row inside the drag’s own container', () => {
		const own = list();
		const r = row(2, own);
		(own as { contains: (el: unknown) => boolean }).contains = (el) => el === r.el;
		expect(hitTestIndex(r.el, own as unknown as Element)).toBe(2);
	});

	it('refuses a matching row in ANOTHER list on the same page', () => {
		// VrAvatarForm mounts credits AND media rows, both carrying
		// data-reorder-index — a credits drag hovering the media list must not
		// resolve the media row's index (the pre-fix document-wide hit test did).
		const creditsList = list([]);
		const mediaRow = row(0, creditsList);
		expect(hitTestIndex(mediaRow.el, creditsList as unknown as Element)).toBeNull();
	});

	it('returns null for no element, no row ancestor, or no container', () => {
		const own = list() as unknown as Element;
		expect(hitTestIndex(null, own)).toBeNull();
		const notARow = { closest: () => null } as unknown as Element;
		expect(hitTestIndex(notARow, own)).toBeNull();
		const r = row(1, list());
		expect(hitTestIndex(r.el, null)).toBeNull();
	});
});

describe('DragReorder wiring (source-pinned)', () => {
	const src = readFileSync(new URL('./drag-reorder.svelte.ts', import.meta.url), 'utf8');

	it('the class delegates to the tested helpers (not re-inlined logic)', () => {
		expect(src).toContain('keyboardMoveTarget(ev.key, i, this.#count())');
		expect(src).toContain('dropTarget(this.dragIndex, this.overIndex)');
		expect(src).toContain('hitTestIndex(');
	});

	it('captures the drag’s own list at pointerdown and clears it on reset', () => {
		expect(src).toContain("handle.closest('[data-reorder-index]')?.parentElement");
		expect(src).toMatch(/reset\(\)\s*\{[^}]*this\.#container = null/);
	});

	// Source-pin the hit-test attribute in EVERY consumer: the pointer path
	// resolves rows via [data-reorder-index], so a renamed or dropped attribute
	// kills drag silently while the keyboard path keeps passing.
	const consumers = [
		'./components/StickerPackForm.svelte',
		'./components/VrAvatarForm.svelte'
	];
	for (const rel of consumers) {
		it(`${rel} rows carry data-reorder-index={i}`, () => {
			const component = readFileSync(new URL(rel, import.meta.url), 'utf8');
			expect(component).toContain('data-reorder-index={i}');
		});
	}

	it('VrAvatarForm mounts BOTH reorderable lists (the scoping case is real)', () => {
		const component = readFileSync(new URL('./components/VrAvatarForm.svelte', import.meta.url), 'utf8');
		expect((component.match(/data-reorder-index=\{i\}/g) ?? []).length).toBe(2);
	});
});
