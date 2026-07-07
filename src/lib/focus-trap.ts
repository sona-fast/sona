// Focus management for modal dialogs (WCAG 2.4.3 / ARIA dialog pattern),
// shared by SetupDialog and RefSheetPicker: move focus into the panel on open,
// keep Tab cycling inside it, close on Escape from anywhere, and return focus
// to the invoker when the dialog is destroyed.
//
// Svelte action — apply to the dialog panel: `<div use:focusTrap={onclose}>`
// (the panel should carry tabindex="-1" so it can receive the initial focus).
export function focusTrap(node: HTMLElement, onclose: () => void) {
	const invoker = document.activeElement as HTMLElement | null;
	node.focus();

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
			return;
		}
		if (e.key !== 'Tab') return;
		const focusable = node.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === node)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	window.addEventListener('keydown', onKeydown);
	return {
		update(next: () => void) {
			onclose = next;
		},
		destroy() {
			window.removeEventListener('keydown', onKeydown);
			invoker?.focus?.();
		}
	};
}
