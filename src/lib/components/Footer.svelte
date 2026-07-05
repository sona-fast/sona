<script lang="ts">
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import FurTrackIcon from '$lib/components/icons/FurTrackIcon.svelte';
	import * as m from '$lib/paraglide/messages';
	import type { SiteSettings } from '$lib/server/settings';

	let { settings, host }: { settings: SiteSettings; host: string } = $props();
</script>

<footer class="footer">
	<div class="footer-inner container">
		<div class="footer-cred">
			<p class="copyright">{m.footer_rights({ year: new Date().getFullYear(), siteName: settings.siteName })}</p>
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
		</div>
		<div class="social-links">
			{#if settings.twitterUrl}
				<a href={settings.twitterUrl} aria-label="Twitter"><TwitterIcon size={18} /></a>
			{/if}
			{#if settings.blueskyUrl}
				<a href={settings.blueskyUrl} aria-label="Bluesky"><BlueskyIcon size={18} /></a>
			{/if}
			{#if settings.telegramUrl}
				<a href={settings.telegramUrl} aria-label="Telegram"><TelegramIcon size={18} /></a>
			{/if}
			{#if settings.furAffinityUrl}
				<a href={settings.furAffinityUrl} aria-label="FurAffinity"><FurAffinityIcon size={18} /></a>
			{/if}
			{#if settings.furtrackUrl}
				<a href={settings.furtrackUrl} aria-label="FurTrack"><FurTrackIcon size={18} /></a>
			{/if}
		</div>
	</div>
</footer>

<style>
	.footer {
		border-top: 1px solid var(--border);
		padding: 24px 0;
		margin-top: auto;
	}

	.footer-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.footer-cred {
		display: flex;
		align-items: center;
		gap: 14px;
		/* The badge is bare/inherit: its text takes this muted color so only the
		 * ember stays orange. */
		color: var(--muted-foreground);
	}

	.copyright {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	/* "made with sona" credit badge. Bare/inherit surface: transparent anchor
	 * whose text inherits the footer's muted color; the ember is the one brand
	 * constant (#FF8400) across every fork theme. */
	.sona-badge {
		display: inline-flex;
		align-items: center;
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

	.social-links {
		display: flex;
		gap: 16px;
	}

	.social-links a {
		color: var(--muted-foreground);
		text-decoration: none;
		transition: color 0.15s;
		display: flex;
	}

	.social-links a:hover {
		color: var(--foreground);
	}
</style>
