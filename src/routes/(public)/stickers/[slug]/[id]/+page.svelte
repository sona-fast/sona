<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page as pageState } from '$app/state';
	import { ArrowLeft, ChevronRight } from 'lucide-svelte';
	import StickerMedia from '$lib/components/StickerMedia.svelte';
	import DownloadMenu from '$lib/components/DownloadMenu.svelte';
	import { stickerDownloadOptions } from '$lib/sticker-download';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const pack = $derived(data.pack);
	const sticker = $derived(data.sticker);
	const siteName = $derived(data.settings?.siteName ?? APP_NAME);

	let revealed = $state(false);

	const socialLinks = $derived(
		data.sticker.artist
			? [
					{ url: data.sticker.artist.twitterUrl, icon: TwitterIcon, label: 'Twitter' },
					{ url: data.sticker.artist.blueskyUrl, icon: BlueskyIcon, label: 'Bluesky' },
					{ url: data.sticker.artist.telegramUrl, icon: TelegramIcon, label: 'Telegram' },
					{ url: data.sticker.artist.furAffinityUrl, icon: FurAffinityIcon, label: 'FurAffinity' },
					{ url: data.sticker.artist.deviantArtUrl, icon: DeviantArtIcon, label: 'DeviantArt' },
					{ url: data.sticker.artist.patreonUrl, icon: PatreonIcon, label: 'Patreon' },
					{ url: data.sticker.artist.instagramUrl, icon: InstagramIcon, label: 'Instagram' }
				].filter((l) => l.url)
			: []
	);

	const emojiLabel = $derived(data.sticker.emojis.join(' '));

	// Download choices come from the shared option logic (the same rules the
	// endpoint validates against); this page only maps them to labels + hrefs.
	// options[0] is always the original; a second entry is the PNG conversion,
	// offered only for non-animated non-PNG rasters.
	const primaryLabels: Record<string, () => string> = {
		webm: m.stickers_download_webm,
		json: m.stickers_download_lottie,
		webp: m.stickers_download_webp,
		png: m.stickers_download_png,
		gif: m.stickers_download_gif
	};
	const formatLabels: Record<string, () => string> = {
		webp: m.stickers_dl_format_webp,
		png: m.stickers_dl_format_png,
		gif: m.stickers_dl_format_gif
	};
	const downloadOptions = $derived(
		stickerDownloadOptions(sticker).map((o, i) => ({
			label: (formatLabels[o.ext] ?? (() => o.ext.toUpperCase()))(),
			href:
				o.kind === 'original'
					? `/stickers/${pack.slug}/${sticker.id}/download`
					: `/stickers/${pack.slug}/${sticker.id}/download?format=${o.kind}`,
			hint: i === 0 ? m.stickers_dl_original() : m.stickers_dl_converted()
		}))
	);
	const downloadLabel = $derived((primaryLabels[stickerDownloadOptions(sticker)[0].ext] ?? m.stickers_download)());

	// Fire-and-forget beacon so the admin dashboard can count download presses
	// (same aggregate counter the gallery download button feeds). Failures must
	// never block the visitor's download.
	function countDownload() {
		void fetch('/api/metrics/download', { method: 'POST', keepalive: true }).catch(() => {});
	}
	// Social previews need a static image. Animated stickers are .json (Lottie) and
	// video stickers are .webm — neither renders as an OG image — so only use the
	// sticker's own imageUrl when it's a static format, else fall back to a static
	// pack preview or the sticker's thumbnail.
	const metaImage = $derived(
		sticker.format === 'png' || sticker.format === 'webp'
			? sticker.imageUrl
			: pack.previewImages?.[0] ?? sticker.thumbnailUrl ?? null
	);
	const metaTitle = $derived(
		emojiLabel
			? `${emojiLabel} — ${data.pack.name} — ${siteName}`
			: `${data.pack.name} — ${siteName}`
	);
</script>

<Meta
	title={metaTitle}
	description={m.stickers_sticker_meta_description({ pack: pack.name, artist: sticker.artist?.name ?? m.stickers_unattributed(), siteName })}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={metaImage}
	{siteName}
/>

<div class="container sticker-detail-page">
	<a href="/stickers/{pack.slug}" class="back-link">
		<ArrowLeft size={16} />
		{pack.name}
	</a>

	<div class="detail-card">
		<!-- Large sticker display on a checkerboard tile -->
		<div class="sticker-display">
			<div class="media" class:blurred={sticker.nsfw && !revealed}>
				<StickerMedia format={sticker.format} imageUrl={sticker.imageUrl} alt={emojiLabel} width={512} />
			</div>
			{#if sticker.nsfw && !revealed}
				<button class="nsfw-overlay" onclick={() => (revealed = true)}>
					<span>NSFW</span>
					<span class="reveal-text">{m.card_click_reveal()}</span>
				</button>
			{/if}
		</div>

		<div class="detail-body">
			<!-- Emoji chips -->
			{#if sticker.emojis.length > 0}
				<div class="emoji-row">
					{#each sticker.emojis as emoji}
						<a href="/stickers?emoji={encodeURIComponent(emoji)}" class="emoji-chip">{emoji}</a>
					{/each}
				</div>
			{/if}

			<!-- Pack link -->
			<div class="pack-link-row">
				<span class="from-label">{m.stickers_from_pack()}</span>
				<a href="/stickers/{pack.slug}" class="pack-link">{pack.name}</a>
				<ChevronRight size={15} class="pack-link-arrow" />
			</div>

			<div class="divider"></div>

			<!-- Artist -->
			<div class="artist-row">
				<div class="artist-left">
					{#if sticker.artist}
						<ArtistAvatar name={sticker.artist.name} avatarUrl={sticker.artist.avatarUrl} size={40} />
					{/if}
					<div class="artist-namecol">
						<span class="artist-name" title={sticker.artist?.name}>{sticker.artist?.name ?? m.stickers_unattributed()}</span>
						<span class="artist-role">{m.stickers_artist_role()}</span>
					</div>
				</div>
				{#if socialLinks.length > 0}
					<div class="artist-socials">
						{#each socialLinks as link}
							<a href={link.url} target="_blank" rel="noopener" aria-label={link.label} class="social-btn">
								<link.icon size={18} />
							</a>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Per-sticker download (the pack-level "Add to Telegram" lives on the pack page). -->
			<div class="download-group">
				<DownloadMenu
					options={downloadOptions}
					label={downloadLabel}
					menuLabel={m.stickers_dl_choose_format()}
					onDownload={countDownload}
				/>
				{#if (sticker.format === 'png' || sticker.format === 'webp') && sticker.isAnimated}
					<p class="dl-caption">{m.stickers_dl_animated_note()}</p>
				{/if}
				<p class="dl-caption">{m.stickers_dl_caption_before()}<a href="/stickers/{pack.slug}">{m.stickers_dl_caption_link()}</a>{m.stickers_dl_caption_after()}</p>
			</div>
		</div>
	</div>
</div>

<style>
	.sticker-detail-page {
		padding: 24px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-primary);
		font-size: 14px;
		font-weight: 500;
		color: var(--muted-foreground);
		margin-bottom: 24px;
		transition: color 0.15s;
	}

	.back-link:hover {
		color: var(--foreground);
		text-decoration: none;
	}

	/* Card centred like the mock's modal, but rendered inline on the page */
	.detail-card {
		max-width: 560px;
		margin: 0 auto;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		overflow: hidden;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
	}

	/* Sticker display area — checkerboard bg, contain sizing */
	.sticker-display {
		position: relative;
		width: 100%;
		aspect-ratio: 560 / 360;
		padding: 30px;
		border-bottom: 1px solid var(--border);
		background-image:
			linear-gradient(45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(-45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--secondary) 75%),
			linear-gradient(-45deg, transparent 75%, var(--secondary) 75%);
		background-size: 24px 24px;
		background-position:
			0 0,
			0 12px,
			12px -12px,
			-12px 0px;
		background-color: var(--background);
	}

	/* Wrapper so the blur applies uniformly to img/video/lottie alike.
	   Pinned by inset rather than %-sized: iOS WebKit resolves a percentage height
	   against the aspect-ratio border box instead of the content box, which made
	   the sticker overflow the padding and clip at the bottom edge. */
	.media {
		position: absolute;
		inset: 30px;
		transition: filter 0.2s;
	}

	.media.blurred {
		filter: blur(24px);
		/* Slight scale hides the transparent edges blur would otherwise reveal. */
		transform: scale(1.08);
	}

	.nsfw-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		background: rgba(0, 0, 0, 0.5);
		border: none;
		color: white;
		cursor: pointer;
		font-family: var(--font-primary);
	}

	.nsfw-overlay span:first-child {
		font-size: 16px;
		font-weight: 600;
	}

	.reveal-text {
		font-size: 13px;
		opacity: 0.7;
	}

	.detail-body {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 24px;
	}

	.emoji-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.emoji-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--foreground);
		font-size: 16px;
		line-height: 1;
		transition: background 0.15s;
	}

	.emoji-chip:hover {
		background: color-mix(in srgb, var(--secondary) 70%, var(--foreground));
		text-decoration: none;
	}

	/* Pack link — "From pack <name> >" */
	.pack-link-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.from-label {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.pack-link {
		font-size: 14px;
		font-weight: 600;
		color: var(--primary);
	}

	.pack-link-row :global(.pack-link-arrow) {
		color: var(--primary);
	}

	.divider {
		height: 1px;
		background: var(--border);
	}

	.artist-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
	}

	.artist-left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.artist-namecol {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.artist-name {
		font-size: 14px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artist-role {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.artist-socials {
		display: flex;
		flex-wrap: wrap;
		/* 6px keeps a 7-icon strip on one row at 390px (7×38 + 6×6 = 302px ≤ 308px
		   content width) without shrinking the 38px touch targets. */
		gap: 6px;
	}

	/* Social links rendered as outline icon buttons */
	.social-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		transition: border-color 0.15s;
	}

	.social-btn:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.download-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.dl-caption {
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted-foreground);
		margin: 0;
	}

	.dl-caption a {
		color: var(--primary);
	}

	@media (max-width: 768px) {
		.sticker-detail-page {
			padding: 16px;
		}

		.emoji-chip {
			font-size: 16px;
		}
	}
</style>
