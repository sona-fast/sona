import { describe, it, expect } from 'vitest';
import { pagingStep } from './paging-keys';

// SONA-179: the arrow shortcut must page only from a bare arrow with focus
// outside anything that already uses arrows. The e2e covers a real text input;
// this pins the rest of the guard list without a browser.

/** A focus target whose closest() answers from a fixed list of matching selectors. */
function target(matches: string[]) {
	return {
		closest: (selector: string) =>
			selector.split(', ').some((s) => matches.includes(s)) ? {} : null
	};
}

function key(overrides: Partial<Parameters<typeof pagingStep>[0]> = {}) {
	return {
		key: 'ArrowRight',
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		defaultPrevented: false,
		isComposing: false,
		repeat: false,
		target: target([]) as unknown as EventTarget,
		...overrides
	};
}

describe('pagingStep', () => {
	it('pages back on ArrowLeft and forward on ArrowRight', () => {
		expect(pagingStep(key({ key: 'ArrowLeft' }))).toBe(-1);
		expect(pagingStep(key({ key: 'ArrowRight' }))).toBe(1);
	});

	it('ignores other keys', () => {
		for (const k of ['ArrowUp', 'ArrowDown', 'Enter', 'a', ' ']) expect(pagingStep(key({ key: k }))).toBeNull();
	});

	it('stands down while any modifier is held', () => {
		for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
			expect(pagingStep(key({ [mod]: true }))).toBeNull();
		}
	});

	it('stands down when something else already handled the key, or mid-IME composition', () => {
		expect(pagingStep(key({ defaultPrevented: true }))).toBeNull();
		expect(pagingStep(key({ isComposing: true }))).toBeNull();
	});

	it('stands down on auto-repeat, so a held arrow pages once instead of racing through the set', () => {
		expect(pagingStep(key({ repeat: true }))).toBeNull();
		expect(pagingStep(key({ key: 'ArrowLeft', repeat: true }))).toBeNull();
	});

	it('stands down while focus is in a field, player, or arrow-driven widget', () => {
		for (const sel of [
			'input',
			'textarea',
			'select',
			'video',
			'[contenteditable]:not([contenteditable="false"])',
			'[role="slider"]',
			'[role="listbox"]',
			'dialog'
		]) {
			expect(pagingStep(key({ target: target([sel]) as unknown as EventTarget })), sel).toBeNull();
		}
	});

	it('stands down inside composite widgets that move focus with arrows (grid, tree, toolbar, application)', () => {
		for (const sel of [
			'[role="grid"]',
			'[role="treegrid"]',
			'[role="tree"]',
			'[role="toolbar"]',
			'[role="application"]'
		]) {
			expect(pagingStep(key({ target: target([sel]) as unknown as EventTarget })), sel).toBeNull();
		}
	});

	it('pages when the target is a plain element, or not an element at all (window)', () => {
		expect(pagingStep(key({ target: target(['a']) as unknown as EventTarget }))).toBe(1);
		expect(pagingStep(key({ target: {} as EventTarget }))).toBe(1);
		expect(pagingStep(key({ target: null }))).toBe(1);
	});
});

// The sticker modal pages from inside its own <dialog>, which is on the
// consumer list. With the dialog passed as the scope, a plain control inside it
// pages; a text field or a menu inside it still keeps its arrows.
describe('pagingStep with a scope', () => {
	// A tiny tree: dialog > (button, input, menu). closest() walks up from the
	// node and returns the first one whose kind the selector names.
	type Node = { kind: string; parent: Node | null };
	const dialog: Node = { kind: 'dialog', parent: null };
	const node = (kind: string): Node => ({ kind, parent: dialog });
	const SELECTOR_FOR: Record<string, string> = { dialog: 'dialog', input: 'input', menu: '[role="menu"]' };
	function at(n: Node) {
		return {
			closest(selector: string) {
				const wanted = selector.split(', ');
				for (let cur: Node | null = n; cur; cur = cur.parent) {
					if (SELECTOR_FOR[cur.kind] && wanted.includes(SELECTOR_FOR[cur.kind])) return cur;
				}
				return null;
			}
		} as unknown as EventTarget;
	}
	const scope = dialog as unknown as Element;

	it('pages from a button inside the scoped dialog', () => {
		expect(pagingStep(key({ target: at(node('button')) }), scope)).toBe(1);
		expect(pagingStep(key({ key: 'ArrowLeft', target: at(node('button')) }), scope)).toBe(-1);
	});

	it('still stands down without the scope, as the detail pages expect', () => {
		expect(pagingStep(key({ target: at(node('button')) }))).toBeNull();
	});

	it('stands down in a text field or a menu inside the scoped dialog', () => {
		expect(pagingStep(key({ target: at(node('input')) }), scope)).toBeNull();
		expect(pagingStep(key({ target: at(node('menu')) }), scope)).toBeNull();
	});

	it('stands down in a dialog other than the scope', () => {
		const other: Node = { kind: 'dialog', parent: null };
		const inOther: Node = { kind: 'button', parent: other };
		expect(pagingStep(key({ target: at(inOther) }), scope)).toBeNull();
	});
});
