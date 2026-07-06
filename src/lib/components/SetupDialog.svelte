<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		title: string;
		sub: string;
		onclose: () => void;
		/** Small icon shown next to the sub line (e.g. the integration's glyph). */
		icon?: Snippet;
		children: Snippet;
	}

	let { title, sub, onclose, icon, children }: Props = $props();

	let modal = $state<HTMLDivElement>();

	// Focus management for the modal dialog (WCAG 2.4.3 / ARIA dialog pattern):
	// move focus into the panel on open, keep Tab cycling inside it, close on
	// Escape from anywhere, and return focus to the invoker when it closes.
	$effect(() => {
		const invoker = document.activeElement as HTMLElement | null;
		modal?.focus();

		function onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault();
				onclose();
				return;
			}
			if (e.key !== 'Tab' || !modal) return;
			const focusable = modal.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || active === modal)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		}

		window.addEventListener('keydown', onKeydown);
		return () => {
			window.removeEventListener('keydown', onKeydown);
			invoker?.focus?.();
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="backdrop" onclick={onclose}>
	<!-- Escape/Tab are handled at the window level while open (see $effect); this
	     stops backdrop clicks from leaking through to the panel. -->
	<div class="modal" bind:this={modal} role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="setup-title" onclick={(e) => e.stopPropagation()}>
		<div class="modal-head">
			<h2 id="setup-title">{title}</h2>
			<button class="modal-close" aria-label={m.admin_close()} onclick={onclose}><X size={18} /></button>
		</div>
		<p class="modal-sub">{#if icon}{@render icon()}{/if}{sub}</p>
		<div class="modal-body">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 24px;
	}
	.modal {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		width: 100%;
		max-width: 680px;
		max-height: calc(100% - 48px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 22px 24px 0;
	}
	.modal-head h2 { font-size: 18px; }
	.modal-close {
		background: none;
		border: none;
		color: var(--muted-foreground);
		display: flex;
		padding: 4px;
		border-radius: var(--radius-xs);
		cursor: pointer;
	}
	.modal-close:hover { color: var(--foreground); }
	.modal-sub {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 24px 16px;
		font-size: 12.5px;
		color: var(--muted-foreground);
		border-bottom: 1px solid var(--border);
	}
	.modal-sub :global(svg) { flex-shrink: 0; color: var(--primary); }
	.modal-body { padding: 22px 24px 24px; overflow-y: auto; }
</style>
