<script lang="ts">
	// The visually hidden polite region the admin forms report events through
	// (4.1.3). One copy of the shape the upload and edit pages were each keeping
	// their own version of.
	import type { Announcer } from '$lib/live-announcer.svelte';

	let { announcer }: { announcer: Announcer } = $props();
</script>

<!-- The region itself stays put; only the node inside it is keyed, so repeating
     an announcement still mutates the region and gets read out. -->
<div class="sr-only" aria-live="polite">{#key announcer.uid}<span>{announcer.text}</span>{/key}</div>
