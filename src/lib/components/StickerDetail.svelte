<script lang="ts">
	// The sticker detail card plus its Previous/Next pager. One component, two
	// places: the modal over the pack page (StickerModal) and the direct-visit
	// page at /stickers/<pack>/<id>. In the modal the pager is buttons that page
	// through the grid as filtered; on the page it is plain links to the
	// neighbouring sticker URLs, which work without JavaScript.
	import { ChevronLeft, ChevronRight, X } from 'lucide-svelte';
	import StickerMedia from './StickerMedia.svelte';
	import DownloadMenu from './DownloadMenu.svelte';
	import ArtistAvatar from './ArtistAvatar.svelte';
	import TwitterIcon from './icons/TwitterIcon.svelte';
	import BlueskyIcon from './icons/BlueskyIcon.svelte';
	import TelegramIcon from './icons/TelegramIcon.svelte';
	import FurAffinityIcon from './icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from './icons/DeviantArtIcon.svelte';
	import PatreonIcon from './icons/PatreonIcon.svelte';
	import InstagramIcon from './icons/InstagramIcon.svelte';
	import { isRasterFormat, stickerDownloadOptions } from '$lib/sticker-download';
	import type { StickerView } from '$lib/server/stickers';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		pack: { slug: string; name: string };
		sticker: StickerView;
		/** 1-based place in the list being paged through. */
		position: number;
		total: number;
		/** The emoji the grid is filtered by, shown beside the counter. */
		filterEmoji?: string;
		/**
		 * Modal mode: renders Close, makes the counter a live status region, and
		 * turns the pager into buttons that call onstep. Without it the pager is
		 * links to prevHref/nextHref.
		 */
		onclose?: () => void;
		onstep?: (step: -1 | 1) => void;
		prevHref?: string | null;
		nextHref?: string | null;
		/** Modal only: whether a previous/next sticker exists in the paged list. */
		hasPrev?: boolean;
		hasNext?: boolean;
		closeButton?: HTMLButtonElement;
	}

	let {
		pack,
		sticker,
		position,
		total,
		filterEmoji = '',
		onclose,
		onstep,
		prevHref = null,
		nextHref = null,
		hasPrev = false,
		hasNext = false,
		closeButton = $bindable()
	}: Props = $props();

	const inModal = $derived(!!onclose);

	// Every NSFW sticker starts blurred each time it's shown: a reveal lasts
	// until the next page step, including a step back to the revealed one.
	let revealed = $state(false);
	$effect.pre(() => {
		void sticker.id;
		revealed = false;
	});

	// The reveal button unmounts as it's pressed. Focus moves to the art it
	// uncovered rather than falling to <body>, so the next Tab goes on to the
	// emoji chips instead of starting over at the top.
	let display: HTMLElement | undefined = $state();
	function reveal() {
		revealed = true;
		display?.focus({ preventScroll: true });
	}

	const socialLinks = $derived(
		sticker.artist
			? [
					{ url: sticker.artist.twitterUrl, icon: TwitterIcon, label: 'Twitter' },
					{ url: sticker.artist.blueskyUrl, icon: BlueskyIcon, label: 'Bluesky' },
					{ url: sticker.artist.telegramUrl, icon: TelegramIcon, label: 'Telegram' },
					{ url: sticker.artist.furAffinityUrl, icon: FurAffinityIcon, label: 'FurAffinity' },
					{ url: sticker.artist.deviantArtUrl, icon: DeviantArtIcon, label: 'DeviantArt' },
					{ url: sticker.artist.patreonUrl, icon: PatreonIcon, label: 'Patreon' },
					{ url: sticker.artist.instagramUrl, icon: InstagramIcon, label: 'Instagram' }
				].filter((l) => l.url)
			: []
	);

	const emojiLabel = $derived(sticker.emojis.join(' '));

	// Download choices come from the shared option logic (the same rules the
	// endpoint validates against); this card only maps them to labels + hrefs.
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
			ext: o.ext,
			label: (formatLabels[o.ext] ?? (() => o.ext.toUpperCase()))(),
			href:
				o.kind === 'original'
					? `/stickers/${pack.slug}/${sticker.id}/download`
					: `/stickers/${pack.slug}/${sticker.id}/download?format=${o.kind}`,
			hint: i === 0 ? m.stickers_dl_original() : m.stickers_dl_converted()
		}))
	);
	const downloadLabel = $derived((primaryLabels[downloadOptions[0].ext] ?? m.stickers_download)());

	// Fire-and-forget beacon so the admin dashboard can count download presses
	// (same aggregate counter the gallery download button feeds). Failures must
	// never block the visitor's download.
	function countDownload() {
		void fetch('/api/metrics/download', { method: 'POST', keepalive: true }).catch(() => {});
	}

	// aria-disabled rather than disabled, so focus stays on the button after you
	// step back to sticker 1 instead of dropping to <body>; the press does nothing.
	function press(step: -1 | 1, available: boolean) {
		if (available) onstep?.(step);
	}
</script>

<div class="stage" class:in-modal={inModal}>
	<div class="detail-card">
		<div class="toolbar">
			<!-- In the modal the count is a status region that stays rendered, so a
			     screen reader hears the new count on every step. The filter emoji
			     sits outside it so it isn't read again each time. -->
			<span class="counter" role={inModal ? 'status' : undefined}>{m.stickers_position({ n: position, total })}</span>
			{#if filterEmoji}
				<span class="filter-emoji"><span class="sr-only">{m.stickers_filtered_by()}</span> {filterEmoji}</span>
			{/if}
			{#if inModal}
				<button
					type="button"
					class="close-btn"
					bind:this={closeButton}
					aria-label={m.stickers_close()}
					onclick={onclose}
				>
					<X size={20} />
				</button>
			{/if}
		</div>

		<!-- Large sticker display on a checkerboard tile -->
		<div class="sticker-display" bind:this={display} tabindex="-1">
			<!-- Keyed on the sticker, for two reasons. A reused wrapper would animate
			     its blur in over 200ms after a page step, flashing NSFW art sharp;
			     a fresh one starts blurred. And StickerMedia sets up video and
			     Lottie playback on mount, so an animated sticker needs a fresh one. -->
			{#key sticker.id}
				<div class="media" class:blurred={sticker.nsfw && !revealed}>
					<StickerMedia format={sticker.format} imageUrl={sticker.imageUrl} alt={emojiLabel} width={512} eager />
				</div>
			{/key}
			{#if sticker.nsfw && !revealed}
				<button class="nsfw-overlay" onclick={reveal}>
					<span>NSFW</span>
					<span class="reveal-text">{m.card_reveal()}</span>
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
				{#if isRasterFormat(sticker.format) && sticker.isAnimated}
					<p class="dl-caption dl-note-animated">{m.stickers_dl_animated_note()}</p>
				{/if}
				<p class="dl-caption">{m.stickers_dl_caption_before()}<a href="/stickers/{pack.slug}">{m.stickers_dl_caption_link()}</a>{m.stickers_dl_caption_after()}</p>
			</div>
		</div>
	</div>

	<!-- Each control carries two labels: the icon circle's "Previous sticker"
	     for wide screens, the bar's visible "Previous" on phones. CSS removes
	     the one that doesn't apply (display: none), so each control has one
	     name. -->
	{#snippet prevContent()}
		<ChevronLeft size={20} class="pager-chevron" />
		<span class="sr-only label-wide">{m.stickers_previous()}</span>
		<span class="label-narrow">{m.gallery_previous()}</span>
	{/snippet}
	{#snippet nextContent()}
		<span class="sr-only label-wide">{m.stickers_next()}</span>
		<span class="label-narrow">{m.gallery_next()}</span>
		<ChevronRight size={20} class="pager-chevron" />
	{/snippet}

	<!-- After the card in the DOM (Close, the card's controls, then Previous and
	     Next in Tab order), though Previous is drawn on the left. A plain div,
	     not a nav: two controls don't need a landmark of their own beside the
	     site nav. -->
	<div class="pager">
		{#if inModal}
			<button
				type="button"
				class="pager-btn prev"
				aria-disabled={hasPrev ? undefined : 'true'}
				onclick={() => press(-1, hasPrev)}
			>
				{@render prevContent()}
			</button>
			<button
				type="button"
				class="pager-btn next"
				aria-disabled={hasNext ? undefined : 'true'}
				onclick={() => press(1, hasNext)}
			>
				{@render nextContent()}
			</button>
		{:else}
			{#if prevHref}
				<a class="pager-btn prev" href={prevHref} rel="prev">{@render prevContent()}</a>
			{:else}
				<span class="pager-btn prev" role="link" aria-disabled="true">{@render prevContent()}</span>
			{/if}
			{#if nextHref}
				<a class="pager-btn next" href={nextHref} rel="next">{@render nextContent()}</a>
			{:else}
				<span class="pager-btn next" role="link" aria-disabled="true">{@render nextContent()}</span>
			{/if}
		{/if}
	</div>
</div>

<style>
	/* Card plus pager. The pager hangs off the card's sides on wide screens,
	   level with the middle of the art; --art-h is the art's height so the
	   circles can follow it when a short modal shrinks the art. */
	.stage {
		--toolbar-h: 52px;
		--art-h: 360px;
		position: relative;
		width: 100%;
		max-width: 560px;
		margin: 0 auto;
	}

	.detail-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		overflow: hidden;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: var(--toolbar-h);
		padding-block: 6px;
		padding-inline: 20px 6px;
		border-bottom: 1px solid var(--border);
	}

	.counter {
		font-family: var(--font-primary);
		font-size: 14px;
		font-variant-numeric: tabular-nums;
		color: var(--foreground);
	}

	.filter-emoji {
		display: inline-flex;
		align-items: center;
		padding: 3px 9px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		font-size: 14px;
		line-height: 1;
	}

	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		margin-inline-start: auto;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--foreground);
		cursor: pointer;
		transition: background 0.15s;
	}

	.close-btn:hover {
		background: color-mix(in srgb, var(--secondary) 70%, var(--foreground));
	}

	/* Inside the card, so the app's usual ring. */
	.close-btn:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	/* Sticker display area — checkerboard bg, contain sizing */
	.sticker-display {
		position: relative;
		width: 100%;
		aspect-ratio: 560 / 360;
		padding: 30px;
		border-bottom: 1px solid var(--border);
		background-image:
			linear-gradient(45deg, var(--checker-square) 25%, transparent 25%),
			linear-gradient(-45deg, var(--checker-square) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--checker-square) 75%),
			linear-gradient(-45deg, transparent 75%, var(--checker-square) 75%);
		background-size: 24px 24px;
		background-position:
			0 0,
			0 12px,
			12px -12px,
			-12px 0px;
		background-color: var(--checker-base);
		overflow: hidden;
	}

	/* Focus target after a reveal; it is not in the Tab order. The card clips
	   anything outside this box, so the ring is drawn inside it. */
	.sticker-display:focus {
		outline: none;
	}

	/* --ring (#666) falls under 3:1 on the dark theme's darker square, so the
	   ring is the foreground colour (white on dark themes, near-black on light
	   ones, so it reads on both checkerboards) with a 2px band in the card
	   colour inside it, the same pairing as the pager's ring on the backdrop.
	   Inset shadows, so the clip can't cut them; the transparent outline keeps
	   a ring in forced-colors mode, where box-shadow is dropped. */
	.sticker-display:focus-visible {
		outline: 2px solid transparent;
		outline-offset: -2px;
		box-shadow:
			inset 0 0 0 2px var(--foreground),
			inset 0 0 0 4px var(--card);
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
		/* 60%, with the text at full white: over white art, a 50% scrim or
		   faded text falls under 4.5:1. */
		background: rgba(0, 0, 0, 0.6);
		border: none;
		color: white;
		cursor: pointer;
		font-family: var(--font-primary);
	}

	/* The overlay fills the clipped art area, so a ring outside it would be
	   cut to a hairline. This one is drawn inside, white on the 60% scrim. */
	.nsfw-overlay:focus-visible {
		outline: 2px solid #fff;
		outline-offset: -4px;
	}

	.nsfw-overlay span:first-child {
		font-size: 16px;
		font-weight: 600;
	}

	.reveal-text {
		font-size: 13px;
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
		/* A chip, not a text link: no underline. */
		text-decoration: none;
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
		color: var(--primary-text);
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
		color: var(--link);
	}

	/* The "PNG isn't offered" note explains the button directly above it — pull
	   it closer (4px effective gap) and weight it above the boilerplate caption. */
	.dl-note-animated {
		margin-top: -4px;
		color: var(--foreground);
		font-weight: 500;
	}

	/* In the modal on a wide screen the art has a fixed height that gives way
	   first on a short window, down to 200px, so the download button stays in
	   view; the pager follows the middle of it. */
	.in-modal {
		--art-h: clamp(200px, calc(100dvh - 480px), 360px);
	}

	.in-modal .sticker-display {
		aspect-ratio: auto;
		height: var(--art-h);
	}

	/* ── Pager ──────────────────────────────────────────────────────────── */

	/* Wide screens: 48px circles outside the card, level with the middle of the
	   art. The row spans past the card on both sides and lets clicks through its
	   empty middle (the modal's backdrop sits under it). Logical insets, so in
	   right-to-left text Previous sits on the right. */
	.pager {
		position: absolute;
		inset-inline: -69px;
		top: calc(var(--toolbar-h) + var(--art-h) / 2 - 24px);
		display: flex;
		justify-content: space-between;
		pointer-events: none;
	}

	.pager-btn {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 48px;
		height: 48px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--card);
		color: var(--foreground);
		font-family: var(--font-primary);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		text-decoration: none;
		transition: background 0.15s, border-color 0.15s;
	}

	.pager-btn:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.pager-btn:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	/* The same unavailable cue as .btn-held: no fill, a dashed edge. */
	.pager-btn[aria-disabled='true'],
	.pager-btn[aria-disabled='true']:hover {
		background: transparent;
		border: 1px dashed var(--input);
		color: var(--muted-foreground);
		cursor: not-allowed;
	}

	.label-narrow {
		display: none;
	}

	.pager-btn :global(.pager-chevron) {
		flex-shrink: 0;
	}

	.pager-btn:dir(rtl) :global(.pager-chevron) {
		transform: scaleX(-1);
	}

	/* On the modal's backdrop, which is dark in every theme, --ring (#666) falls
	   under 3:1 on a dimmed light page. A white ring with a 2px gap in the card
	   colour clears 3:1 against both. The transparent outline keeps a ring in
	   forced-colors mode, where box-shadow is dropped. */
	.in-modal .pager-btn:focus-visible {
		outline: 2px solid transparent;
		box-shadow:
			0 0 0 2px var(--card),
			0 0 0 4px #fff;
	}

	/* Phones (the app's 768px breakpoint): no room beside the card, so the
	   pager becomes a row of two labelled buttons under it. In the modal the
	   row is the sheet's bottom bar (see StickerModal). */
	@media (max-width: 768px) {
		.pager {
			position: static;
			inset: auto;
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 12px;
			margin-top: 16px;
			pointer-events: auto;
		}

		.pager-btn {
			width: auto;
			height: 48px;
			border-color: transparent;
			background: var(--secondary);
		}

		.label-wide {
			display: none;
		}

		.label-narrow {
			display: inline;
		}

		.in-modal .pager-btn:focus-visible {
			outline: 2px solid var(--ring);
			outline-offset: 2px;
			box-shadow: none;
		}

		/* The modal's full-screen sheet: the card fills the screen and scrolls,
		   the art spans the full width, and the pager is a bar pinned to the
		   bottom where a thumb reaches it. Safe-area insets keep the toolbar
		   clear of the notch and the bar clear of the home indicator. */
		.in-modal {
			display: flex;
			flex-direction: column;
			max-width: none;
			height: 100%;
		}

		.in-modal .detail-card {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}

		/* 16px at the sides, as the phone mocks draw it, rather than the
		   desktop card's 20px and 24px. */
		.in-modal .toolbar {
			padding-block-start: max(6px, env(safe-area-inset-top));
			padding-inline: max(16px, env(safe-area-inset-left)) max(6px, env(safe-area-inset-right));
		}

		.in-modal .detail-body {
			padding-inline: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right));
		}

		.in-modal .sticker-display {
			height: auto;
			aspect-ratio: 13 / 10;
		}

		.in-modal .pager {
			margin-top: 0;
			padding-block: 12px max(12px, env(safe-area-inset-bottom));
			padding-inline: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right));
			border-top: 1px solid var(--border);
			background: var(--card);
		}
	}
</style>
