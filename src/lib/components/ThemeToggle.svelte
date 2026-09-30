<script lang="ts">
	import { Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import * as m from '$lib/paraglide/messages';

	const theme = getTheme();
</script>

<!-- Named by what it does, so the name changes with the state and needs no
     aria-pressed. -->
<button
	class="theme-toggle"
	onclick={theme.toggle}
	aria-label={theme.current === 'dark' ? m.theme_to_light() : m.theme_to_dark()}
>
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
		/* background-color, never the shorthand: the shorthand would reset the
		   phone rule's background-clip and fill the whole 44px target. */
		background-color: var(--secondary);
		color: var(--foreground);
		cursor: pointer;
		transition: background-color 0.15s;
	}

	/* --muted matches the page in some themes and --secondary in others, so the
	   hover shade mixes the text colour into the resting fill instead. */
	@media (hover: hover) {
		.theme-toggle:hover {
			background-color: color-mix(in srgb, var(--foreground) 12%, var(--secondary));
		}
	}

	/* The page's ring, as on links and the bottom tabs. */
	.theme-toggle:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	/* On phones, a 44px target around the 32px circle. The circle is 2rem, so
	   at 200% text the padding reaches 0 and the circle fills the target. */
	@media (max-width: 768px) {
		.theme-toggle {
			--target-pad: max(0px, (44px - 2rem) / 2);
			flex: none;
			width: 44px;
			height: 44px;
			padding: var(--target-pad);
			background-clip: content-box;
		}

		/* The ring sits 2px from the circle, not from the larger target. */
		.theme-toggle:focus-visible {
			outline-offset: calc(2px - var(--target-pad));
		}
	}
</style>
