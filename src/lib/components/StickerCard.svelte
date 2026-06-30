<script lang="ts">
	import StickerMedia from './StickerMedia.svelte';
	import type { StickerView } from '$lib/server/stickers';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		sticker: StickerView;
		packSlug: string;
		/** Show artist credit under the sticker — used in multi-artist pack grids. */
		showArtist?: boolean;
	}

	let { sticker, packSlug, showArtist = false }: Props = $props();

	let revealed = $state(false);
</script>

<a href="/stickers/{packSlug}/{sticker.id}" class="card">
	<div class="tile">
		<div class="media" class:blurred={sticker.nsfw && !revealed}>
			<StickerMedia
				format={sticker.format}
				imageUrl={sticker.thumbnailUrl ?? sticker.imageUrl}
				alt=""
			/>
		</div>
		{#if sticker.nsfw && !revealed}
			<button
				class="nsfw-overlay"
				onclick={(e) => { e.preventDefault(); e.stopPropagation(); revealed = true; }}
			>
				<span>NSFW</span>
				<span class="reveal-text">{m.card_click_reveal()}</span>
			</button>
		{/if}
	</div>
	{#if sticker.emojis.length > 0 || showArtist}
		<div class="card-body">
			{#if sticker.emojis.length > 0}
				<div class="emoji-row">
					{#each sticker.emojis as emoji}
						<span class="emoji-chip">{emoji}</span>
					{/each}
				</div>
			{/if}
			{#if showArtist}
				<div class="artist-credit">
					{#if sticker.artist}
						{#if sticker.artist.avatarUrl}
							<img src={sticker.artist.avatarUrl} alt="" class="artist-avatar" />
						{/if}
						<span class="artist-name">{m.stickers_by_artist({ artist: sticker.artist.name })}</span>
					{:else}
						<span class="artist-name unattributed">Unattributed</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</a>

<style>
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
		display: flex;
		flex-direction: column;
	}

	.card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	/* Sticker sits centred on a checkerboard tile rather than bleeding edge-to-edge. */
	.tile {
		position: relative;
		aspect-ratio: 19 / 15;
		padding: 18px;
		border-bottom: 1px solid var(--border);
		background-image:
			linear-gradient(45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(-45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--secondary) 75%),
			linear-gradient(-45deg, transparent 75%, var(--secondary) 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0px;
		background-color: var(--background);
	}

	/* On small phone cards the landscape (19/15) tile + fixed 18px padding shrinks a
	   square sticker into a small letterboxed square with wide checkerboard bars, which
	   exaggerates any off-centre artwork. Square the tile and tighten the padding on
	   mobile so square stickers fill the box edge-to-edge and read as centred + larger
	   (matching how they look on desktop). */
	@media (max-width: 640px) {
		.tile {
			aspect-ratio: 1 / 1;
			padding: 10px;
		}
	}

	/* Wrapper so the blur applies uniformly to img/video/lottie alike. */
	.media {
		width: 100%;
		height: 100%;
		transition: filter 0.2s;
	}

	.media.blurred {
		filter: blur(16px);
		/* Slight scale hides the transparent edges blur would otherwise reveal. */
		transform: scale(1.1);
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
		font-size: 14px;
		font-weight: 600;
	}

	.reveal-text {
		font-size: 12px;
		opacity: 0.7;
	}

	.card-body {
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.emoji-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.emoji-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px 9px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		font-size: 14px;
		line-height: 1;
	}

	.artist-credit {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.artist-avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.artist-name {
		font-size: 12px;
		color: var(--muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
