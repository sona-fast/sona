<script lang="ts">
	import { Download, ChevronUp } from 'lucide-svelte';

	interface DownloadMenuOption {
		/** Visible row label ("WebP", "PNG") — i18n'd by the caller. */
		label: string;
		href: string;
		/** Small fidelity hint ("original" / "converted") — i18n'd by the caller. */
		hint?: string;
	}

	interface Props {
		/** Menu entries in order; options[0] is the primary action. */
		options: DownloadMenuOption[];
		/** Primary button text ("Download WebP") — i18n'd by the caller. */
		label: string;
		/** Accessible name for the format-picker caret — i18n'd by the caller. */
		menuLabel: string;
		/** Fired when any download link is pressed (metrics beacon hook). */
		onDownload?: () => void;
	}

	let { options, label, menuLabel, onDownload }: Props = $props();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let caret: HTMLButtonElement | undefined = $state();
	let itemEls: HTMLAnchorElement[] = $state([]);

	// One option ⇒ the component collapses to the plain pill button, so the
	// menu machinery below only exists when there's a real choice.
	const hasMenu = $derived(options.length > 1);

	function toggle() {
		open = !open;
		if (open) {
			// Focus the first menu item once it renders (APG menu-button pattern).
			queueMicrotask(() => itemEls[0]?.focus());
		}
	}

	function close(refocus = false) {
		if (!open) return;
		open = false;
		if (refocus) caret?.focus();
	}

	function onWindowPointerdown(e: PointerEvent) {
		if (open && root && !root.contains(e.target as Node)) close();
	}

	function onMenuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close(true);
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const current = itemEls.indexOf(document.activeElement as HTMLAnchorElement);
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			const next = (current + delta + itemEls.length) % itemEls.length;
			itemEls[next]?.focus();
		}
	}

	function picked() {
		onDownload?.();
		close();
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="dl-menu" bind:this={root}>
	{#if hasMenu && open}
		<!-- Opens UPWARD by design: the button sits at the bottom of the detail
		     card, which is overflow:hidden — a downward menu would clip. See the
		     direction decision on SONA-123. -->
		<ul class="dl-list" role="menu" aria-label={menuLabel} onkeydown={onMenuKeydown}>
			{#each options as option, i}
				<li role="none">
					<a
						role="menuitem"
						href={option.href}
						download
						bind:this={itemEls[i]}
						onclick={picked}
					>
						{option.label}
						{#if option.hint}<span class="hint" class:primary={i === 0}>{option.hint}</span>{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="dl-split">
		<a
			href={options[0].href}
			class="btn btn-primary dl-primary"
			class:solo={!hasMenu}
			download
			onclick={() => onDownload?.()}
		>
			<Download size={16} />
			{label}
		</a>
		{#if hasMenu}
			<button
				type="button"
				class="btn btn-primary dl-caret"
				bind:this={caret}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={menuLabel}
				onclick={toggle}
			>
				<ChevronUp size={14} class={open ? 'caret-open' : ''} />
			</button>
		{/if}
	</div>
</div>

<style>
	.dl-menu {
		position: relative;
		width: 100%;
	}

	.dl-split {
		display: flex;
		width: 100%;
	}

	.dl-primary {
		flex: 1;
		display: flex;
	}

	/* Split-button halves share one pill silhouette; the divider is a subtle
	   line of the button's own foreground so it works on any theme's primary. */
	.dl-primary:not(.solo) {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}

	.dl-caret {
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		padding-inline: 14px;
		border-inline-start: 1px solid color-mix(in srgb, var(--primary-foreground) 25%, transparent);
	}

	.dl-caret :global(svg) {
		transition: rotate 0.15s ease-out;
	}

	.dl-caret :global(.caret-open) {
		rotate: 180deg;
	}

	.dl-list {
		position: absolute;
		inset-inline: 0;
		bottom: calc(100% + 8px);
		margin: 0;
		padding: 6px;
		list-style: none;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 10px;
		/* Layered shadow: the menu floats over the artist row, so it needs real
		   elevation, not just a border. */
		box-shadow:
			0 4px 12px rgba(0, 0, 0, 0.18),
			0 16px 40px rgba(0, 0, 0, 0.28);
		z-index: 5;
	}

	@media (prefers-reduced-motion: no-preference) {
		.dl-list {
			animation: dl-rise 0.13s ease-out;
		}
	}

	@keyframes dl-rise {
		from {
			opacity: 0;
			translate: 0 4px;
		}
		to {
			opacity: 1;
			translate: 0 0;
		}
	}

	.dl-list a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 12px;
		border-radius: 7px;
		font-size: 14px;
		font-weight: 500;
		color: var(--foreground);
	}

	.dl-list a:hover {
		background: var(--secondary);
		text-decoration: none;
	}

	.dl-list a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	.hint {
		font-size: 11px;
		color: var(--muted-foreground);
	}

	/* Mark the default (original) entry so the two rows read as
	   original-vs-converted at a glance, not two equal formats. */
	.hint.primary::before {
		content: '● ';
		color: var(--primary);
		font-size: 8px;
		vertical-align: 1px;
	}
</style>
