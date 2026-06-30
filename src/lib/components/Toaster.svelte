<script lang="ts">
	import { SquareX, ShieldCheck, Info, OctagonAlert, X } from 'lucide-svelte';
	import { fly } from 'svelte/transition';
	import { getToasts, dismissToast, type ToastType } from '$lib/toast.svelte';

	// Maps each toast type to the lunaris Alert chip — solid light fill, dark
	// foreground (icon + text), and the lucide icon from the design mock.
	const styles: Record<ToastType | 'warning', { bg: string; fg: string; icon: typeof Info }> = {
		error: { bg: '#FFBFB2', fg: '#590F00', icon: SquareX },
		success: { bg: '#A1E5A1', fg: '#003300', icon: ShieldCheck },
		info: { bg: '#C9D6F0', fg: '#001133', icon: Info },
		warning: { bg: '#FFD9B2', fg: '#4D2700', icon: OctagonAlert }
	};

	const toasts = $derived(getToasts());
</script>

<div class="toaster" aria-live="polite" aria-atomic="false">
	{#each toasts as t (t.id)}
		{@const s = styles[t.type] ?? styles.info}
		{@const Icon = s.icon}
		<div
			class="alert"
			role="status"
			style:background={s.bg}
			style:color={s.fg}
			transition:fly={{ y: -12, duration: 200 }}
		>
			<Icon size={24} class="alert-icon" />
			<p class="alert-message">{t.message}</p>
			<button class="alert-dismiss" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
				<X size={20} />
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 1000;
		display: flex;
		flex-direction: column-reverse;
		gap: 12px;
		max-width: min(420px, calc(100vw - 32px));
		pointer-events: none;
	}

	/* lunaris Alert/Info: cornerRadius 24, padding 16px 24px, gap 12, icon 24 + contents row */
	.alert {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		border-radius: 24px;
		padding: 16px 24px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
	}

	.alert :global(.alert-icon) {
		flex: 0 0 24px;
		margin-top: 2px;
	}

	.alert-message {
		flex: 1;
		min-width: 0;
		font-family: var(--font-secondary);
		font-size: 16px;
		font-weight: 400;
		line-height: 1.5;
		word-break: break-word;
	}

	.alert-dismiss {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		margin-top: 2px;
		background: none;
		border: none;
		color: inherit;
		cursor: pointer;
		opacity: 0.7;
	}

	.alert-dismiss:hover {
		opacity: 1;
	}
</style>
