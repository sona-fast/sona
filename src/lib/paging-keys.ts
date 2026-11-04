// Left/Right arrow paging for the detail pages (SONA-179): the art detail page
// steps through its grid, the VR detail page through one avatar's looks.
// Arrows already mean something in a text field, a select, a media player, a
// slider, a menu, a grid, a tree or a toolbar, so the shortcut stands down
// whenever focus is in one of those, and whenever a modifier is held (Alt+Left is browser Back, Shift+arrow
// extends a selection). A held arrow's auto-repeat is ignored too, so holding
// it steps once instead of racing through the set and downloading every hop.

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
	'[role="grid"]',
	'[role="treegrid"]',
	'[role="tree"]',
	'[role="toolbar"]',
	'[role="application"]',
	'[role="dialog"]',
	'dialog'
].join(', ');

/** Duck-typed so it runs under the node test environment too. */
interface Containing {
	contains?: (other: unknown) => boolean;
}

/**
 * The nearest arrow consumer around the focus target, unless it is the scope
 * (or an ancestor of it): a paging dialog is itself a `dialog`, and focus on a
 * button inside it should still page. A nearer consumer inside the scope, such
 * as a text field or a menu in the dialog, still blocks.
 */
function consumesArrows(target: EventTarget | null, scope?: unknown): boolean {
	const el = target as { closest?: (selector: string) => unknown } | null;
	if (typeof el?.closest !== 'function') return false;
	const hit = el.closest(KEY_CONSUMERS) as Containing | null;
	if (hit === null) return false;
	if (scope !== undefined && (hit === scope || hit.contains?.(scope) === true)) return false;
	return true;
}

/**
 * The paging step a keydown asks for: -1 for ArrowLeft, 1 for ArrowRight, or
 * null when the key isn't a bare arrow, is an auto-repeat, something else
 * already handled it, or focus is somewhere arrows already do something.
 *
 * `scope` is the element that does the paging when that element is itself an
 * arrow consumer, like the sticker modal's `<dialog>`. Without it, focus
 * anywhere in a dialog stands the shortcut down.
 */
export function pagingStep(
	e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented' | 'isComposing' | 'repeat' | 'target'>,
	scope?: Element
): -1 | 1 | null {
	if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return null;
	if (e.defaultPrevented || e.isComposing || e.repeat) return null;
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
	if (consumesArrows(e.target, scope)) return null;
	return e.key === 'ArrowLeft' ? -1 : 1;
}
