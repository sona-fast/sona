<script lang="ts">
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import FurTrackIcon from '$lib/components/icons/FurTrackIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import SonaBadge from '$lib/components/SonaBadge.svelte';
	import * as m from '$lib/paraglide/messages';
	import BuildReceipt from '$lib/components/BuildReceipt.svelte';
	import type { PublicSiteSettings } from '$lib/server/settings';

	let { settings, host }: { settings: PublicSiteSettings; host: string } = $props();
</script>

<footer class="footer">
	<div class="footer-inner container">
		<div class="footer-cred">
			<p class="copyright">{m.footer_rights({ year: new Date().getFullYear(), siteName: settings.siteName })}</p>
			<nav class="legal-links" aria-label={m.footer_legal_label()}>
				<a href="/privacy">{m.footer_privacy()}</a>
				<a href="/terms">{m.footer_terms()}</a>
				{#if settings.aiPageEnabled}
					<a href="/ai">{m.footer_ai()}</a>
				{/if}
			</nav>
			<SonaBadge {host} />
			<BuildReceipt />
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
			{#if settings.instagramUrl}
				<a href={settings.instagramUrl} aria-label="Instagram"><InstagramIcon size={18} /></a>
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
		/* With the build receipt the cluster outgrows mid widths (~769-1024px);
		 * wrapping onto a second row beats crushing the gap to zero. The badge
		 * itself is an atomic inline-flex, so its phrase never breaks mid-way. */
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 14px;
		/* The badge is bare/inherit: its text takes this muted color so only the
		 * ember stays orange. */
		color: var(--muted-foreground);
	}

	.copyright {
		font-size: 12px;
		color: var(--muted-foreground);
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
