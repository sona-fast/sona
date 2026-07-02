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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={oncancel} onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="dialog" onclick={(e) => e.stopPropagation()}>
		<div class="dialog-icon">
			<AlertTriangle size={24} />
		</div>
		<h2>{title}</h2>
		<p>{message}</p>
		<div class="dialog-actions">
			<button class="btn btn-secondary" onclick={oncancel}>{m.admin_cancel()}</button>
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
