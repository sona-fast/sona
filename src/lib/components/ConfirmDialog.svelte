<script lang="ts">
	import { AlertTriangle } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		title: string;
		message: string;
		confirmLabel?: string;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { title, message, confirmLabel = m.admin_delete(), onconfirm, oncancel }: Props = $props();

	let dialog = $state<HTMLDivElement>();
	let cancelButton = $state<HTMLButtonElement>();

	// Modal a11y: initial focus lands on the safe action, Esc closes from
	// anywhere (window-level — the old handler sat on a non-focusable div and
	// never fired), and Tab is trapped inside the dialog.
	$effect(() => {
		cancelButton?.focus();
	});

	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			oncancel();
			return;
		}
		if (e.key !== 'Tab' || !dialog) return;
		const focusables = dialog.querySelectorAll<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !dialog.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -- backdrop click-to-dismiss duplicates the Esc/Cancel paths -->
<div class="backdrop" onclick={oncancel}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		aria-describedby="confirm-dialog-message"
		tabindex="-1"
		bind:this={dialog}
		onclick={(e) => e.stopPropagation()}
	>
		<div class="dialog-icon">
			<AlertTriangle size={24} />
		</div>
		<h2 id="confirm-dialog-title">{title}</h2>
		<p id="confirm-dialog-message">{message}</p>
		<div class="dialog-actions">
			<button class="btn btn-secondary" bind:this={cancelButton} onclick={oncancel}>{m.admin_cancel()}</button>
			<button class="btn btn-destructive" onclick={onconfirm}>{confirmLabel}</button>
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
		padding: 16px;
	}

	.dialog {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 32px;
		width: 100%;
		max-width: 400px;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.dialog-icon {
		color: var(--destructive);
		display: flex;
	}

	h2 {
		font-size: 18px;
	}

	p {
		font-size: 14px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}

	.dialog-actions {
		display: flex;
		gap: 12px;
		margin-top: 8px;
		width: 100%;
	}

	.dialog-actions .btn {
		flex: 1;
	}
</style>
