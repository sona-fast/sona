<script lang="ts">
	// The row of suggested tags (SONA-220). Shared by the tray on the two forms
	// and by a row on /admin/images/suggest-tags, so a chip behaves the same
	// wherever it appears.
	//
	// Each chip is a toggle, not a checkbox: aria-pressed carries the state, the
	// check icon marks a tag that will be added, and the plus on a left-out tag
	// says it can come back. Nothing here writes anywhere — the parent owns the
	// state and decides what a toggle means.
	import { Check, Plus } from 'lucide-svelte';

	let {
		tags,
		leftOut,
		labelledBy,
		describedBy,
		ontoggle
	}: {
		tags: string[];
		leftOut: Set<string>;
		/** The ids of the elements that name this group, space-separated: the
		 *  eyebrow above the chips ("9 suggested tags…") in the forms' tray, and on
		 *  the backfill page that eyebrow plus the row's title, so a row's chips
		 *  say which image they belong to. */
		labelledBy: string;
		/** The instruction sentence under the chips. */
		describedBy: string;
		ontoggle: (tag: string) => void;
	} = $props();
</script>

<div class="tag-chiprow" role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
	{#each tags as tag (tag)}
		<button
			type="button"
			class="tag-chip"
			aria-pressed={!leftOut.has(tag)}
			onclick={() => ontoggle(tag)}
		>
			{#if leftOut.has(tag)}<Plus size={14} aria-hidden="true" />{:else}<Check size={14} aria-hidden="true" />{/if}
			{tag}
		</button>
	{/each}
</div>
