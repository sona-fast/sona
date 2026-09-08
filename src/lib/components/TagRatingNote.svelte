<script lang="ts">
	// The rating entail.dev returned, shown beside the "Mark as NSFW" checkbox
	// (SONA-220).
	//
	// A suggestion NEVER checks the box. The classifier is a hint about the
	// artwork, not a decision about the gallery, and a wrong automatic check is
	// a piece published under the wrong rating. So a questionable or explicit
	// rating turns warning-coloured and offers a button; the operator's click is
	// what checks the box.
	//
	// The note renders as plain text rather than the capsule SONA-156 uses for
	// its lookup result: a capsule sitting next to a button reads as a second
	// button.
	import { tick } from 'svelte';
	import { TriangleAlert } from 'lucide-svelte';
	import { ratingLabel, type EntailRating } from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let {
		rating,
		id,
		nsfw = $bindable(false),
		checkbox = null
	}: {
		rating: EntailRating | null;
		/** The checkbox points its aria-describedby here. */
		id: string;
		nsfw: boolean;
		/** The NSFW checkbox itself: "Mark it NSFW" removes its own button, so
		 *  focus moves to the box it just checked rather than dropping to <body>. */
		checkbox?: HTMLInputElement | null;
	} = $props();

	// Persistent live region: the text is written into a node that was already
	// there, because a region inserted with its text already inside announces
	// nothing in NVDA or JAWS. Same shape as the reference control on the edit
	// page.
	let announcement = $state('');

	const warn = $derived(rating === 'explicit' || rating === 'questionable');

	const label = $derived(ratingLabel(rating));

	async function markNsfw() {
		nsfw = true;
		announcement = m.admin_tag_suggest_marked_nsfw();
		await tick();
		checkbox?.focus();
	}
</script>

<p class="sr-only" role="status">{announcement}</p>

{#if rating}
	<span class="tag-rating-note" class:warn {id}>
		{#if warn}<TriangleAlert size={14} aria-hidden="true" />{/if}
		{label}
	</span>
	{#if warn && !nsfw}
		<button type="button" class="btn btn-secondary tag-btn-sm" onclick={markNsfw}>
			{m.admin_tag_suggest_mark_nsfw()}
		</button>
	{/if}
{/if}

