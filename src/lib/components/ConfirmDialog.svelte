<script lang="ts">
	import { AlertTriangle } from 'lucide-svelte';
	import { focusTrap } from '$lib/focus-trap';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		title: string;
		message: string;
		confirmLabel?: string;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { title, message, confirmLabel = m.admin_delete(), onconfirm, oncancel }: Props = $props();

	let cancelButton = $state<HTMLButtonElement>();

	// Modal a11y rides the shared focus-trap action (SetupDialog/RefSheetPicker
	// precedent): Tab cycles inside the panel (skipping [disabled] controls),
	// Esc closes from anywhere, and focus RETURNS TO THE INVOKER on destroy —
	// the bespoke handler this replaced dropped focus on <body> after Esc/Cancel
	// (~15 stops back on /admin/images). Initial focus still lands on the safe
	// action rather than the panel itself.
	$effect(() => {
		cancelButton?.focus();
	});
</script>

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
		use:focusTrap={oncancel}
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
