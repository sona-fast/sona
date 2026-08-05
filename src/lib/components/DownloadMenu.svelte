<script lang="ts">
	import { Download, ChevronUp } from 'lucide-svelte';

	interface DownloadMenuOption {
		/** Visible row label ("WebP", "PNG") — i18n'd by the caller. */
		label: string;
		href: string;
		/** Small fidelity hint ("original" / "converted") — i18n'd by the caller. */
		hint: string;
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

	const uid = $props.id();
	const listId = `${uid}-list`;

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let caret: HTMLButtonElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();

	// One option ⇒ the component collapses to the plain pill button, so the
	// disclosure machinery below only exists when there's a real choice.
	const hasMenu = $derived(options.length > 1);

	function toggle() {
		open = !open;
		if (open) {
			// Focus the first link once it renders (disclosure-menu convenience).
			queueMicrotask(() => list?.querySelector('a')?.focus());
		}
	}

	function close(refocus = false) {
		if (!open) return;
		open = false;
		if (refocus) caret?.focus();
	}

	function onWindowPointerdown(e: PointerEvent) {
		// Guarded on open so the listener is a no-op for the 99% of page life the
		// menu is closed (and for the single-option collapse, which never opens).
		if (open && root && !root.contains(e.target as Node)) close();
	}

	// On the wrapper so it works whether focus sits on the caret or in the list.
	function onRootKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			close(true);
		}
	}

	function picked() {
		onDownload?.();
		// Downloads don't navigate, so the focused link is about to unmount —
		// hand focus back to the caret rather than letting it fall to <body>.
		close(true);
	}
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<!-- svelte-ignore a11y_no_static_element_interactions (Escape-to-close convenience; not the element's only affordance) -->
<div class="dl-menu" bind:this={root} onkeydown={onRootKeydown}>
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
				aria-expanded={open}
				aria-controls={listId}
				aria-label={menuLabel}
				onclick={toggle}
			>
				<ChevronUp size={14} class={open ? 'caret-open' : ''} />
			</button>
		{/if}
	</div>

	{#if hasMenu && open}
		<!-- Opens UPWARD by design (CSS only — the list follows the button in DOM so
		     a virtual cursor meets the trigger first): the button sits at the bottom
		     of the detail card, which is overflow:hidden — a downward menu would
		     clip. See the direction decision on SONA-123. Plain links in a plain
		     list (ARIA disclosure pattern), natively tabbable — no menu roles. -->
		<ul class="dl-list" id={listId}>
			{#each options as option, i}
				<li>
					<a href={option.href} download onclick={picked}>
						{option.label}
						<span class="hint" class:primary={i === 0}>{option.hint}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
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
		/* 16px + 14px icon + 16px = 46px hit width (≥44px touch target). */
		padding-inline: 16px;
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
		/* 4px: concentric with the 10px container radius minus its 6px padding. */
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		color: var(--foreground);
		/* Menu rows read as controls, not prose links — no resting underline. */
		text-decoration: none;
	}

	.dl-list a:hover {
		background: var(--secondary);
	}

	.dl-list a:focus-visible {
		/* --ring, not --primary: the ring sits on the card and --primary fails the
		   3:1 non-text bar there on the default light theme (2.46:1). Guarded by
		   theme-contrast.test.ts. */
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}

	.hint {
		font-size: 11px;
		color: var(--muted-foreground);
	}

	/* Mark the default (original) entry so the two rows read as
	   original-vs-converted at a glance, not two equal formats. Drawn as an empty
	   pseudo-element box (not text content) so it stays out of accessible names. */
	.hint.primary::before {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-inline-end: 5px;
		border-radius: 50%;
		background: var(--primary);
		vertical-align: 1px;
	}
</style>
