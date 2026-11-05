<script lang="ts">
	// The sticker detail view as a modal over the pack page. The pack page owns
	// the history (shallow routing: pushState to open, replaceState to page,
	// history.back() to close), and this component follows it: `index` >= 0
	// means open. Every way of closing (Escape, Close, a backdrop click, browser
	// Back) ends in the same place, the page state losing its sticker, so the
	// URL and the dialog never disagree.
	import { tick } from 'svelte';
	import StickerDetail from './StickerDetail.svelte';
	import { pagingStep } from '$lib/paging-keys';
	import { cdnImage } from '$lib';
	import type { StickerView } from '$lib/server/stickers';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		pack: { slug: string; name: string };
		/** The list being paged through: the grid as filtered. */
		stickers: StickerView[];
		/** Index of the open sticker in `stickers`, or -1 when closed. */
		index: number;
		filterEmoji?: string;
		/** Move by one sticker. */
		onstep: (step: -1 | 1) => void;
		/** Ask to close; the page pops the history entry. */
		onrequestclose: () => void;
		/** Closed: hand focus back to the grid card of the last-shown sticker. */
		onclosed: (stickerId: number) => void;
	}

	let { pack, stickers, index, filterEmoji = '', onstep, onrequestclose, onclosed }: Props = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let closeButton: HTMLButtonElement | undefined = $state();

	const open = $derived(index >= 0 && index < stickers.length);

	// What the dialog shows. Kept after close so the content doesn't vanish
	// while the closing fade plays.
	type View = { sticker: StickerView; position: number; total: number };
	let lastView: View | null = null;
	const view = $derived.by((): View | null => {
		if (open) lastView = { sticker: stickers[index], position: index + 1, total: stickers.length };
		return lastView;
	});

	// Warm the neighbours' art, so a page step doesn't start from a cold
	// request. Static images only: video and Lottie load their full source.
	$effect(() => {
		if (!open) return;
		for (const s of [stickers[index - 1], stickers[index + 1]]) {
			if (s && s.format !== 'video' && s.format !== 'animated') new Image().src = cdnImage(s.imageUrl, 512);
		}
	});

	let savedOverflow = '';
	let savedGutter = '';
	// Its own flag rather than dialog.open: when the browser closes the dialog
	// itself, dialog.open is already false by the time the page state follows,
	// and the scroll lock and focus return still have to be undone.
	let locked = false;

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.showModal();
			// showModal makes the page inert and traps Tab, but not scroll.
			const root = document.documentElement;
			savedOverflow = root.style.overflow;
			savedGutter = root.style.scrollbarGutter;
			// Hiding the overflow removes a classic (Windows, Linux) scrollbar,
			// and the page would shift sideways into its place. Keep the gutter,
			// but only when a scrollbar takes space now: on a page that doesn't
			// scroll, or with overlay scrollbars, a stable gutter would shift it
			// the other way.
			if (window.innerWidth > root.clientWidth) root.style.scrollbarGutter = 'stable';
			root.style.overflow = 'hidden';
			locked = true;
			// Close is the one control that is always there.
			void tick().then(() => closeButton?.focus());
		} else if (!open && locked) {
			const id = lastView?.sticker.id;
			if (dialog.open) dialog.close();
			unlockScroll();
			if (id !== undefined) onclosed(id);
		}
	});

	// Leaving the page with the modal open (a pack or emoji link inside it):
	// put the page's scroll back.
	$effect(() => () => {
		if (locked) unlockScroll();
	});

	function unlockScroll() {
		document.documentElement.style.overflow = savedOverflow;
		document.documentElement.style.scrollbarGutter = savedGutter;
		locked = false;
	}

	// Escape fires cancel. Route it through the page's history like every other
	// close, instead of letting the dialog close under a URL that still names
	// the sticker.
	function onCancel(e: Event) {
		e.preventDefault();
		onrequestclose();
	}

	// A browser can close a modal dialog on its own (Chrome does after repeated
	// Escape presses with no user activation in between). Keep history in step.
	function onClose() {
		if (open) onrequestclose();
	}

	// A press that starts and ends on the backdrop closes. Checking where the
	// press started keeps a text selection dragged out of the card from closing.
	// The release is checked too: a press dragged from the backdrop into the
	// card fires its click on the dialog, the nearest element both ends share.
	let downOnBackdrop = false;
	let upOnBackdrop = false;
	function isBackdrop(target: EventTarget | null) {
		return target === dialog;
	}
	function onPointerdown(e: PointerEvent) {
		downOnBackdrop = isBackdrop(e.target);
	}
	function onPointerup(e: PointerEvent) {
		upOnBackdrop = isBackdrop(e.target);
	}
	function onClick(e: MouseEvent) {
		if (downOnBackdrop && upOnBackdrop && isBackdrop(e.target)) onrequestclose();
		downOnBackdrop = false;
		upOnBackdrop = false;
	}

	// Left and Right page, through the shared guard (no modifiers, no
	// auto-repeat, not in a text field or a menu), with this dialog as the
	// scope so focus inside it still pages. The download format list is plain
	// links rather than a menu role, so it is excluded here by name.
	// On the window rather than the dialog: the page behind is inert, so a
	// keydown reaching the window comes from the dialog or from <body>, where
	// focus lands when a mouse click doesn't focus the pressed button (macOS)
	// or the focused control unmounts.
	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		const pressed = pagingStep(e, dialog);
		if (pressed === null) return;
		if ((e.target as Element | null)?.closest?.('.dl-menu')) return;
		e.preventDefault();
		// In right-to-left text Previous sits on the right, so the arrow keys
		// follow the drawing.
		const rtl = dialog ? getComputedStyle(dialog).direction === 'rtl' : false;
		// The pack page ignores a step with no sticker there.
		onstep(rtl ? (-pressed as -1 | 1) : pressed);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (the backdrop click is a convenience; Close does the same) -->
<dialog
	bind:this={dialog}
	class="sticker-modal"
	aria-label={view ? m.stickers_dialog_label({ n: view.position, total: view.total }) : undefined}
	oncancel={onCancel}
	onclose={onClose}
	onpointerdown={onPointerdown}
	onpointerup={onPointerup}
	onclick={onClick}
>
	{#if view}
		<StickerDetail
			{pack}
			sticker={view.sticker}
			position={view.position}
			total={view.total}
			{filterEmoji}
			onclose={onrequestclose}
			{onstep}
			hasPrev={open && index > 0}
			hasNext={open && index < stickers.length - 1}
			bind:closeButton
		/>
	{/if}
</dialog>

<style>
	/* The dialog is the whole viewport; its own box is the click target for
	   "outside the card". The dim is ::backdrop, black at 72% in every theme. */
	.sticker-modal {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 40px 24px;
		border: 0;
		background: transparent;
		color: var(--foreground);
		overflow-y: auto;
		overscroll-behavior: contain;
		opacity: 0;
		transition:
			opacity 0.15s ease-in,
			overlay 0.15s ease-in allow-discrete,
			display 0.15s ease-in allow-discrete;
	}

	.sticker-modal[open] {
		display: grid;
		place-items: center;
		opacity: 1;
		transition-duration: 0.2s;
		transition-timing-function: ease-out;
	}

	.sticker-modal::backdrop {
		background: rgba(0, 0, 0, 0.72);
		opacity: 0;
		transition:
			opacity 0.15s ease-in,
			overlay 0.15s ease-in allow-discrete,
			display 0.15s ease-in allow-discrete;
	}

	.sticker-modal[open]::backdrop {
		opacity: 1;
		transition-duration: 0.2s;
		transition-timing-function: ease-out;
	}

	/* The card lifts 8px as it fades in, and settles back on close. */
	.sticker-modal :global(.stage) {
		transform: translateY(8px);
		transition: transform 0.15s ease-in;
	}

	.sticker-modal[open] :global(.stage) {
		transform: none;
		transition: transform 0.2s ease-out;
	}

	@starting-style {
		.sticker-modal[open],
		.sticker-modal[open]::backdrop {
			opacity: 0;
		}

		.sticker-modal[open] :global(.stage) {
			transform: translateY(8px);
		}
	}

	/* Phones: a full-screen sheet that rises from the bottom. */
	@media (max-width: 768px) {
		.sticker-modal {
			padding: 0;
		}

		/* One track the size of the viewport, so the stage's height: 100% has
		   something definite to resolve against: the sheet is exactly the
		   screen, the bar stays pinned, and only the card scrolls. */
		.sticker-modal[open] {
			place-items: stretch;
			grid-template-rows: 100%;
			grid-template-columns: 100%;
		}

		.sticker-modal :global(.stage) {
			transform: translateY(24px);
		}

		@starting-style {
			.sticker-modal[open] :global(.stage) {
				transform: translateY(24px);
			}
		}
	}

	/* Reduced motion: a plain fade, no movement. */
	@media (prefers-reduced-motion: reduce) {
		.sticker-modal :global(.stage),
		.sticker-modal[open] :global(.stage) {
			transform: none;
			transition: none;
		}

		@starting-style {
			.sticker-modal[open] :global(.stage) {
				transform: none;
			}
		}
	}
</style>
