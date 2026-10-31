<script lang="ts">
	// Link a piece (SONA-236): the picker's pieces as one radio group, so arrow
	// keys move between them and a taken piece can't be chosen. Shared by the
	// dialog and the page's own picker for a browser without the page's script.
	import { Image as ImageIcon } from '@lucide/svelte';
	import { cdnImage, rawFallback, THUMB_WIDTH } from '$lib/img';
	import type { PickerList } from '$lib/server/commission-link';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		list: PickerList;
		/** The picked piece's id, or null. */
		picked?: number | null;
		/** Ids for the legend and each choice's description, unique on the page. */
		idPrefix: string;
	}

	let { list, picked = $bindable(null), idPrefix }: Props = $props();

	// Pieces by the entry's artist all share it, so only "all pieces" names it.
	const showArtist = $derived(list.scope === 'all');
</script>

<fieldset class="choices">
	<legend id="{idPrefix}-legend">
		{list.scope === 'all' ? m.admin_commissions_pick_all() : m.admin_commissions_pick_by_artist({ artist: list.artistName })}
	</legend>
	<ul>
		{#each list.pieces as piece (piece.id)}
			{@const metaId = `${idPrefix}-meta-${piece.id}`}
			{@const hasMeta = showArtist || !piece.published || piece.taken}
			<li>
				<label class="choice" class:taken={piece.taken}>
					<input
						type="radio"
						name="imageId"
						value={piece.id}
						disabled={piece.taken}
						checked={picked === piece.id}
						onchange={() => (picked = piece.id)}
						aria-describedby={hasMeta ? metaId : undefined}
					/>
					<span class="thumb">
						{#if piece.thumb}
							<img src={cdnImage(piece.thumb, THUMB_WIDTH)} alt="" loading="lazy" use:rawFallback={piece.thumb} />
						{:else}
							<ImageIcon size={20} aria-hidden="true" />
						{/if}
					</span>
					<span class="title">{piece.title}</span>
					{#if hasMeta}
						<span class="meta" id={metaId}>
							{#if showArtist}<span>{piece.artistName}</span>{/if}
							{#if !piece.published}<span>{m.admin_status_private()}</span>{/if}
							{#if piece.taken}<span class="taken-label">{m.admin_commissions_pick_taken()}</span>{/if}
						</span>
					{/if}
				</label>
			</li>
		{/each}
	</ul>
</fieldset>

<style>
	.choices { border: none; padding: 0; margin: 0; min-width: 0; }
	legend { font-size: 13px; font-weight: 500; padding: 0; margin-bottom: 8px; }
	ul {
		list-style: none; margin: 0; padding: 0;
		display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 10px;
	}
	.choice {
		position: relative; display: flex; flex-direction: column; gap: 6px;
		padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-s);
		cursor: pointer; font-size: 13px; overflow-wrap: anywhere; height: 100%;
	}
	.choice:hover { border-color: var(--muted-foreground); }
	/* The radio stays in the accessibility tree and takes keyboard focus; the
	   card shows its state. */
	.choice input {
		position: absolute; top: 10px; left: 10px; margin: 0;
		width: 18px; height: 18px;
	}
	/* --primary-text, not --primary: the edge marks the picked state, and raw
	   --primary misses 3:1 on Ember light. */
	.choice:has(input:checked) { border-color: var(--primary-text); box-shadow: 0 0 0 1px var(--primary-text); }
	.choice:has(input:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
	.choice.taken { cursor: not-allowed; }
	.choice.taken .thumb { opacity: 0.45; }
	.thumb {
		aspect-ratio: 1; border-radius: var(--radius-xs); background: var(--secondary);
		color: var(--muted-foreground); display: flex; align-items: center; justify-content: center;
		overflow: hidden;
		outline: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent); outline-offset: -1px;
	}
	.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
	.title { font-weight: 500; line-height: 1.35; }
	.meta { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted-foreground); }
	.taken-label { color: var(--foreground); }
</style>
