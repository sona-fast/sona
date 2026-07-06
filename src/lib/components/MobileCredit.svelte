<script lang="ts">
	import SonaBadge from '$lib/components/SonaBadge.svelte';

	// A slim "made with sona" credit shown only below the 768px breakpoint, where
	// the desktop Footer is hidden and MobileNav (a fixed bottom bar) takes over.
	// Rendered at the end of the scrollable content (not fixed); its bottom
	// padding clears the fixed nav so the badge is fully visible when scrolled.
	let { host }: { host: string } = $props();
</script>

<div class="mobile-credit">
	<SonaBadge {host} />
</div>

<style>
	.mobile-credit {
		display: none;
	}

	@media (max-width: 768px) {
		.mobile-credit {
			display: flex;
			justify-content: center;
			padding: 20px 16px;
			/* Clear the fixed MobileNav (mirrors the splash's 88px bottom gap). */
			padding-bottom: 88px;
			border-top: 1px solid var(--border);
			/* Bare badge inherits this muted color; only the ember stays orange. */
			color: var(--muted-foreground);
		}
	}
</style>
