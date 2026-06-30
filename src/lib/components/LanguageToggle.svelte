<script lang="ts">
	import { getLocale, setLocale, locales } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	// Short labels for the segmented control; message catalog holds the full names.
	const labels: Record<string, string> = { en: 'EN', ja: 'JP' };
</script>

<div class="lang-toggle" role="group" aria-label={m.lang_toggle()}>
	{#each locales as loc}
		<button
			type="button"
			class:active={getLocale() === loc}
			aria-pressed={getLocale() === loc}
			onclick={() => setLocale(loc)}
		>
			{labels[loc] ?? loc.toUpperCase()}
		</button>
	{/each}
</div>

<style>
	.lang-toggle {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}

	.lang-toggle button {
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 10px;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.lang-toggle button:hover {
		color: var(--foreground);
	}

	.lang-toggle button.active {
		background: var(--secondary);
		color: var(--foreground);
	}
</style>
