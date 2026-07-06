<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	// Bare/inherit "made with sona" credit badge. Transparent anchor whose text
	// uses color:inherit so it takes the host context's muted color; only the
	// ember stays the constant Sona orange (#FF8400). Links to sona.fast with the
	// site's own host as ?ref for per-fork attribution.
	let { host }: { host: string } = $props();
</script>

<a
	class="sona-badge"
	href="https://sona.fast/?ref={host}"
	target="_blank"
	rel="noopener"
	aria-label="{m.footer_made_with()} sona — sona.fast"
>
	<span class="mw">{m.footer_made_with()}</span>
	<span class="wm">sona<span class="ember" aria-hidden="true"></span></span>
</a>

<style>
	.sona-badge {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5ch;
		font-size: 12px;
		line-height: 1;
		text-decoration: none;
		color: inherit;
	}

	.sona-badge .mw {
		font-family: var(--font-secondary);
		opacity: 0.72;
	}

	.sona-badge .wm {
		font-family: var(--font-primary);
		font-weight: 600;
		letter-spacing: -0.01em;
		display: inline-flex;
		align-items: baseline;
	}

	.sona-badge .ember {
		position: relative;
		display: inline-block;
		width: 0.44em;
		height: 0.44em;
		margin-left: 0.06em;
		border-radius: 50%;
		transform: translateY(0.01em);
		background: radial-gradient(circle at 38% 32%, #ffce86 0%, #ff8400 55%, #c85e00 100%);
		box-shadow: 0 0 5px 0 rgba(255, 132, 0, 0.55);
	}

	.sona-badge .ember::after {
		content: '';
		position: absolute;
		inset: -65%;
		border-radius: 50%;
		background: radial-gradient(circle, rgba(255, 150, 50, 0.55) 0%, rgba(255, 132, 0, 0) 70%);
		animation: sona-ember-breathe 5.5s ease-in-out infinite;
		pointer-events: none;
	}

	@keyframes sona-ember-breathe {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(0.82);
		}
		50% {
			opacity: 1;
			transform: scale(1.28);
		}
	}

	.sona-badge:hover .ember {
		box-shadow: 0 0 9px 1px rgba(255, 132, 0, 0.85);
	}

	.sona-badge:hover .ember::after {
		opacity: 1;
		transform: scale(1.45);
	}

	.sona-badge:focus-visible {
		outline: 2px solid #ff8400;
		outline-offset: 3px;
		border-radius: 4px;
	}

	@media (prefers-reduced-motion: reduce) {
		.sona-badge .ember::after {
			animation: none;
			opacity: 0.7;
			transform: scale(1);
		}
	}
</style>
