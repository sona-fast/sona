<script lang="ts">
	import SonaBadge from '$lib/components/SonaBadge.svelte';
	import * as m from '$lib/paraglide/messages';

	// A slim "made with sona" credit shown only below the 768px breakpoint, where
	// the desktop Footer is hidden and MobileNav (a fixed bottom bar) takes over.
	// Rendered at the end of the scrollable content (not fixed); its bottom
	// padding clears the fixed nav so the badge is fully visible when scrolled.
	let { host }: { host: string } = $props();
</script>

<div class="mobile-credit">
	<nav class="legal-links" aria-label={m.footer_legal_label()}>
		<a href="/privacy">{m.footer_privacy()}</a>
		<a href="/terms">{m.footer_terms()}</a>
	</nav>
	<SonaBadge {host} />
</div>

<style>
	.mobile-credit {
		display: none;
	}

	@media (max-width: 768px) {
		.mobile-credit {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 12px;
			padding: 20px 16px;
			/* Clear the fixed MobileNav (mirrors the splash's 88px bottom gap). */
			padding-bottom: 88px;
			border-top: 1px solid var(--border);
			/* Bare badge inherits this muted color; only the ember stays orange. */
			color: var(--muted-foreground);
		}
	}

	.legal-links {
		display: flex;
		gap: 12px;
		font-size: 12px;
	}

	.legal-links a {
		color: var(--muted-foreground);
		text-decoration: underline;
		transition: color 0.15s;
	}

	.legal-links a:hover {
		color: var(--foreground);
	}
</style>
