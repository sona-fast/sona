// Left/Right arrow paging for the detail pages (SONA-179): the art detail page
// steps through its grid, the VR detail page through one avatar's looks.
// Arrows already mean something in a text field, a select, a media player, a
// slider or a menu, so the shortcut stands down whenever focus is in one of
// those, and whenever a modifier is held (Alt+Left is browser Back, Shift+arrow
// extends a selection).

const KEY_CONSUMERS = [
	'input',
	'textarea',
	'select',
	'video',
	'audio',
	'[contenteditable]:not([contenteditable="false"])',
	'[role="textbox"]',
	'[role="combobox"]',
	'[role="listbox"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[role="menu"]',
	'[role="menubar"]',
	'[role="tablist"]',
	'[role="radiogroup"]',
	'[role="dialog"]',
	'dialog'
].join(', ');

/** Duck-typed so it runs under the node test environment too. */
function consumesArrows(target: EventTarget | null): boolean {
	const el = target as { closest?: (selector: string) => unknown } | null;
	return typeof el?.closest === 'function' && el.closest(KEY_CONSUMERS) !== null;
}

/**
 * The paging step a keydown asks for: -1 for ArrowLeft, 1 for ArrowRight, or
 * null when the key isn't a bare arrow, something else already handled it,
 * or focus is somewhere arrows already do something.
 */
export function pagingStep(
	e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented' | 'isComposing' | 'target'>
): -1 | 1 | null {
	if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return null;
	if (e.defaultPrevented || e.isComposing) return null;
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
	if (consumesArrows(e.target)) return null;
	return e.key === 'ArrowLeft' ? -1 : 1;
}
