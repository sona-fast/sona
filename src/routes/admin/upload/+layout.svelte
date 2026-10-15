<script lang="ts">
	// The upload page reads its commission prefill once, when it mounts, and
	// seeds the form from it. SvelteKit keeps the page mounted across a
	// navigation that only changes the query, so going from an entry's upload
	// (?commission=ID) to a plain one would carry the entry's artist,
	// characters, Private, and commissionId into an unrelated upload. Keying on
	// the parameter remounts the page whenever the entry changes.
	import { page } from '$app/stores';

	let { children } = $props();
</script>

{#key $page.url.searchParams.get('commission')}
	{@render children()}
{/key}
