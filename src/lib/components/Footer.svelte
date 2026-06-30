<script lang="ts">
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import FurTrackIcon from '$lib/components/icons/FurTrackIcon.svelte';
	import * as m from '$lib/paraglide/messages';
	import type { SiteSettings } from '$lib/server/settings';

	let { settings }: { settings: SiteSettings } = $props();
</script>

<footer class="footer">
	<div class="footer-inner container">
		<p class="copyright">{m.footer_rights({ year: new Date().getFullYear(), siteName: settings.siteName })}</p>
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

	.copyright {
		font-size: 12px;
		color: var(--muted-foreground);
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
