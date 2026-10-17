<script lang="ts">
	// Every ledger page loads `gate`. A Back press that interrupts a navigation
	// can mount a ledger page with the page being left's data first
	// (sveltejs/kit#13276), and `data.gate.open` then throws. Rendering the page
	// only once its own data is here skips that one stale render.
	import { page } from '$app/state';

	let { children } = $props();
</script>

{#if page.data.gate}{@render children()}{/if}
