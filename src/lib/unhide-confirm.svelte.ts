import type { ActionResult } from '@sveltejs/kit';

/**
 * The "make a private artist public?" step (SONA-236). An action that would
 * give a Keep private artist public work answers 409 with `confirmUnhide` (the
 * artists' names) unless the form carries confirmUnhide=1. Call take() from the
 * form's enhance result callback; when it returns true, render
 * UnhideArtistDialog with `names`, and confirm() resubmits the same form, from
 * the same button, with confirmUnhide=1.
 */
export function createUnhideConfirm() {
	let pending = $state<{ form: HTMLFormElement; submitter: HTMLElement | null; names: string[] } | null>(null);
	return {
		get names() {
			return pending?.names ?? null;
		},
		take(result: ActionResult, form: HTMLFormElement, submitter: HTMLElement | null): boolean {
			const names = result.type === 'failure' ? result.data?.confirmUnhide : undefined;
			if (!Array.isArray(names)) return false;
			pending = { form, submitter, names: names.map(String) };
			return true;
		},
		confirm() {
			const p = pending;
			pending = null;
			if (!p) return;
			// The enhance handler reads the form's fields when the submit event
			// fires, so the field only has to exist for requestSubmit.
			const field = document.createElement('input');
			field.type = 'hidden';
			field.name = 'confirmUnhide';
			field.value = '1';
			p.form.append(field);
			const submitter = p.submitter instanceof HTMLButtonElement && p.submitter.form === p.form ? p.submitter : undefined;
			p.form.requestSubmit(submitter);
			field.remove();
		},
		cancel() {
			pending = null;
		}
	};
}
