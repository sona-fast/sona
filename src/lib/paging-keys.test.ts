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

	it('pages when the target is a plain element, or not an element at all (window)', () => {
		expect(pagingStep(key({ target: target(['a']) as unknown as EventTarget }))).toBe(1);
		expect(pagingStep(key({ target: {} as EventTarget }))).toBe(1);
		expect(pagingStep(key({ target: null }))).toBe(1);
	});
});
