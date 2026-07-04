<script lang="ts">
	import { Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import * as m from '$lib/paraglide/messages';

	const theme = getTheme();
</script>

<button class="theme-toggle" onclick={theme.toggle} aria-label={m.theme_toggle()}>
	{#if theme.current === 'dark'}
		<Sun size={16} />
	{:else}
		<Moon size={16} />
	{/if}
</button>

<style>
	.theme-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-pill);
		border: none;
		background: var(--secondary);
		color: var(--foreground);
		cursor: pointer;
		transition: background 0.15s;
	}

	.theme-toggle:hover {
		background: var(--muted);
	}
</style>
