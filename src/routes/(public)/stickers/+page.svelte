<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { page as pageState } from '$app/state';
	import { Search, Send, Server, Sticker, X, RotateCcw, ChevronDown } from 'lucide-svelte';
	import StickerCard from '$lib/components/StickerCard.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const siteName = $derived(data.settings?.siteName ?? APP_NAME);
	const ownerName = $derived(data.settings?.ownerName || data.settings?.siteName || APP_NAME);

	function updateFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) {
			params.set(key, value);
		} else {
			params.delete(key);
		}
		// When picking a chip, clear free-text query and vice versa.
		if (key === 'emoji') params.delete('q');
		if (key === 'q') params.delete('emoji');
		goto(`?${params.toString()}`, { replaceState: true });
	}

	function clearFilters() {
		goto('/stickers', { replaceState: true });
	}

	// Derive active emoji label for display in summary.
	const activeEmoji = $derived(data.filters.emoji || data.filters.q);
</script>

<Meta
	title={m.stickers_meta_title({ siteName })}
	description={m.stickers_meta_description({ siteName, ownerName })}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={null}
	{siteName}
/>

<!-- Cover mosaic: first ≤4 stickers laid out 1=full, 2=side-by-side, 3=two-up
     + wide, 4=2×2. Tiles are `contain` on the checkerboard, matching the card. -->
{#snippet mosaic(images: string[])}
	<div class="mosaic" data-count={Math.min(images.length, 4)}>
		{#each images.slice(0, 4) as image}
			<img src={cdnImage(image, 200)} alt="" loading="lazy" />
		{/each}
	</div>
{/snippet}

<div class="container stickers-page">
	<div class="page-header">
		<h1>{m.stickers_title()}</h1>
		<p class="subtitle">{m.stickers_subtitle({ ownerName })}</p>
	</div>

	<!-- Tab bar — pill segmented control; Stickers is active here -->
	<div class="tabs">
		<a href="/gallery" class="tab">{m.gallery_view_artwork()}</a>
		{#if data.fursuitEnabled}
			<a href="/gallery?view=fursuit" class="tab">{m.gallery_view_fursuit()}</a>
		{/if}
		<span class="tab active" aria-current="page">{m.gallery_view_stickers()}</span>
	</div>

	<!-- Filter bar: emoji rail on the left, search + artist on the right -->
	<div class="filter-bar">
		{#if data.topEmojis.length > 0}
			<div class="emoji-rail">
				{#each data.topEmojis as { emoji }}
					<button
						class="emoji-chip"
						class:active={data.filters.emoji === emoji}
						onclick={() => updateFilter('emoji', data.filters.emoji === emoji ? '' : emoji)}
						title={emoji}
					>{emoji}</button>
				{/each}
			</div>
		{/if}

		<div class="filter-controls">
			<!-- Free-text emoji/keyword search -->
			<div class="search-wrapper">
				<Search size={16} class="search-icon" />
				<input
					type="search"
					class="input search"
					placeholder={m.stickers_search_placeholder()}
					value={data.filters.q}
					onchange={(e) => updateFilter('q', e.currentTarget.value)}
				/>
			</div>

			<!-- Artist filter -->
			{#if data.artists.length > 0}
				<div class="select-wrapper">
					<select
						class="input filter-select"
						value={data.filters.artist}
						onchange={(e) => updateFilter('artist', e.currentTarget.value)}
					>
						<option value="">{m.stickers_all_artists()}</option>
						{#each data.artists as artist}
							<option value={String(artist.id)}>{artist.name}</option>
						{/each}
					</select>
					<ChevronDown size={16} class="select-chevron" />
				</div>
			{/if}
		</div>
	</div>

	<!-- Filtered sticker grid -->
	{#if data.mode === 'filtered'}
		<div class="filter-summary">
			<span class="summary-text">
				{m.stickers_count({ count: data.stickers.length })}
				{#if activeEmoji}<span class="summary-sep">·</span><span class="summary-emoji">{activeEmoji}</span>{/if}
				<span class="summary-sep">·</span>{m.stickers_across_packs({ packs: data.packCount })}
			</span>
			<button class="ghost-btn" onclick={clearFilters}>
				<X size={16} />
				{m.stickers_clear_filters()}
			</button>
		</div>

		{#if data.stickers.length > 0}
			<div class="sticker-grid">
				{#each data.stickers as sticker}
					<StickerCard {sticker} packSlug={data.packSlugById[sticker.packId] ?? String(sticker.packId)} showArtist />
				{/each}
			</div>
		{:else}
			<div class="empty-state">
				<div class="empty-icon">{activeEmoji && /\p{Emoji}/u.test(activeEmoji) ? activeEmoji : '🦊'}</div>
				<div class="empty-text">
					<p class="empty-title">{m.stickers_empty_title({ query: activeEmoji ? `「${activeEmoji}」` : m.stickers_empty_fallback() })}</p>
					<p class="empty-subtext">{m.stickers_empty_subtext()}</p>
				</div>
				<button class="btn btn-primary" onclick={clearFilters}>
					<RotateCcw size={16} />
					{m.stickers_reset_filters()}
				</button>
			</div>
		{/if}

	<!-- Pack card grid -->
	{:else}
		{#if data.packs.length > 0}
			<div class="pack-grid">
				{#each data.packs as pack}
					<!--
						Pack card: div + named link for the pack, separate Telegram CTA below.
						Outer is a div to avoid nesting <a> inside <a> (Telegram button is a link too).
					-->
					<div class="pack-card">
						<a href="/stickers/{pack.slug}" class="pack-cover-link" tabindex="-1" aria-hidden="true">
							<div class="pack-cover">
								{#if pack.previewImages.length > 0}
									{@render mosaic(pack.previewImages)}
								{:else if pack.coverImageUrl}
									<img src={cdnImage(pack.coverImageUrl, 400)} alt="" loading="lazy" />
								{:else}
									<div class="pack-cover-placeholder">
										<span class="placeholder-emoji">🎭</span>
									</div>
								{/if}
								<!-- Source chip overlays the cover, top-left -->
								<span class="source-chip" class:telegram={pack.source === 'telegram'}>
									{#if pack.source === 'telegram'}
										<Send size={13} />
										{m.stickers_source_telegram()}
									{:else}
										<Server size={13} />
										{m.stickers_source_self_hosted()}
									{/if}
								</span>
							</div>
						</a>
						<div class="pack-body">
							<h3 class="pack-name">
								<a href="/stickers/{pack.slug}" class="pack-name-link">{pack.name}</a>
							</h3>

							<!-- Credit line: single-artist vs. multi-artist -->
							<p class="pack-credit">
								{#if pack.shape === 'single' && pack.soleArtist}
									{#if pack.soleArtist.avatarUrl}
										<img src={pack.soleArtist.avatarUrl} alt="" class="credit-avatar" />
									{/if}
									{m.stickers_by_artist({ artist: pack.soleArtist.name })}
								{:else}
									{m.stickers_managed_by_owner({ ownerName, n: pack.artists.length })}
								{/if}
							</p>

							<div class="pack-meta">
								<span class="sticker-count">{m.stickers_count({ count: pack.stickerCount })}</span>
							</div>

							{#if pack.telegramUrl}
								<a
									href={pack.telegramUrl}
									target="_blank"
									rel="noopener"
									class="btn btn-primary telegram-btn"
								>
									<Send size={16} />
									{m.stickers_add_to_telegram()}
								</a>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty-state">
				<div class="empty-icon"><Sticker size={48} /></div>
				<div class="empty-text">
					<p class="empty-title">{m.stickers_no_packs()}</p>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.stickers-page {
		padding: 32px 24px;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.page-header h1 {
		font-size: 28px;
		font-weight: 700;
		font-family: var(--font-primary);
	}

	.subtitle {
		font-size: 14px;
		color: var(--muted-foreground);
		margin-top: 6px;
	}

	/* Tab bar — pill segmented control */
	.tabs {
		display: inline-flex;
		gap: 8px;
		margin-bottom: 24px;
		padding: 4px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		border: none;
		background: none;
		font-family: var(--font-secondary);
		font-size: 14px;
		font-weight: 500;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: color 0.15s, background 0.15s;
		text-decoration: none;
	}

	.tab:hover {
		color: var(--foreground);
		text-decoration: none;
	}

	.tab.active {
		color: var(--foreground);
		background: var(--background);
		box-shadow: 0 1px 3.5px rgba(0, 0, 0, 0.06);
	}

	/* Filter bar — emoji rail left, controls right */
	.filter-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 24px;
	}

	.emoji-rail {
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
		border: none;
		background: var(--secondary);
		color: var(--foreground);
		font-size: 16px;
		cursor: pointer;
		transition: background 0.15s;
		line-height: 1;
	}

	.emoji-chip:hover {
		background: color-mix(in srgb, var(--secondary) 70%, var(--foreground));
	}

	.emoji-chip.active {
		background: var(--primary);
		color: var(--primary-foreground);
	}

	.filter-controls {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
	}

	.search-wrapper {
		position: relative;
		width: 260px;
		max-width: 100%;
	}

	.search-wrapper :global(.search-icon) {
		position: absolute;
		left: 14px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.search {
		padding-left: 38px;
	}

	.select-wrapper {
		position: relative;
	}

	.select-wrapper :global(.select-chevron) {
		position: absolute;
		right: 14px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.filter-select {
		width: auto;
		min-width: 180px;
		padding-right: 42px;
		appearance: none;
	}

	/* Filter summary bar */
	.filter-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 18px;
		font-size: 14px;
	}

	.summary-text {
		color: var(--foreground);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.summary-sep {
		color: var(--muted-foreground);
	}

	.summary-emoji {
		font-size: 18px;
	}

	/* Ghost button — icon + label, no fill */
	.ghost-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		font-family: var(--font-primary);
		font-size: 14px;
		font-weight: 500;
		color: var(--muted-foreground);
		cursor: pointer;
		padding: 6px 4px;
		transition: color 0.15s;
	}

	.ghost-btn:hover {
		color: var(--foreground);
	}

	/* Sticker grid for filtered results */
	.sticker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 16px;
	}

	/* Pack card grid */
	.pack-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 20px;
	}

	.pack-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
		color: inherit;
		transition: border-color 0.15s;
		display: flex;
		flex-direction: column;
	}

	.pack-card:hover {
		border-color: var(--muted-foreground);
	}

	.pack-cover-link {
		display: block;
		text-decoration: none;
	}

	/* Cover: sticker sits contained on a checkerboard tile */
	.pack-cover {
		position: relative;
		aspect-ratio: 300 / 168;
		overflow: hidden;
		border-bottom: 1px solid var(--border);
		background-image:
			linear-gradient(45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(-45deg, var(--secondary) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--secondary) 75%),
			linear-gradient(-45deg, transparent 75%, var(--secondary) 75%);
		background-size: 18px 18px;
		background-position:
			0 0,
			0 9px,
			9px -9px,
			-9px 0px;
		background-color: var(--background);
	}

	.pack-cover img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	/* Cover mosaic — up to a 2×2 grid of contained sticker tiles */
	.mosaic {
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-auto-rows: 1fr;
		gap: 2px;
		width: 100%;
		height: 100%;
	}

	.mosaic[data-count='1'] {
		grid-template-columns: 1fr;
	}

	/* 3 tiles: two side by side on top, the third spanning the full bottom row */
	.mosaic[data-count='3'] img:nth-child(3) {
		grid-column: span 2;
	}

	.mosaic img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		min-width: 0;
		min-height: 0;
	}

	.pack-cover-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.placeholder-emoji {
		font-size: 48px;
	}

	/* Source chip overlay on cover */
	.source-chip {
		position: absolute;
		top: 12px;
		left: 12px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		padding: 5px 10px;
		border-radius: var(--radius-pill);
		background: rgba(0, 0, 0, 0.7);
		color: #ffffff;
	}

	.source-chip.telegram {
		color: var(--primary);
	}

	.pack-body {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		flex: 1;
	}

	.pack-name {
		font-family: var(--font-primary);
		font-size: 17px;
		font-weight: 700;
		margin: 0;
	}

	.pack-name-link {
		color: inherit;
		text-decoration: none;
	}

	.pack-name-link:hover {
		text-decoration: underline;
	}

	.pack-credit {
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.credit-avatar {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.pack-meta {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.sticker-count {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.telegram-btn {
		display: flex;
		width: 100%;
		margin-top: 2px;
	}

	/* Empty / no-results state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 18px;
		padding: 64px 24px;
		text-align: center;
	}

	.empty-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 104px;
		height: 104px;
		border-radius: 50%;
		background: var(--secondary);
		font-size: 52px;
		line-height: 1;
	}

	.empty-text {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 460px;
	}

	.empty-title {
		font-family: var(--font-primary);
		font-size: 22px;
		font-weight: 700;
		color: var(--foreground);
	}

	.empty-subtext {
		font-size: 14px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}

	@media (max-width: 768px) {
		.stickers-page {
			padding: 20px 16px;
		}

		.page-header h1 {
			font-size: 24px;
		}

		.filter-bar {
			align-items: stretch;
		}

		.filter-controls {
			gap: 8px;
		}

		.search-wrapper {
			width: 100%;
		}

		/* The artist select is width:auto, so a long artist name grew it past the
		   viewport and pushed the whole page into horizontal overflow (the grid then
		   looked shifted). Make it full-width like the search so it can't overflow. */
		.select-wrapper {
			width: 100%;
		}

		.filter-select {
			width: 100%;
			min-width: 0;
		}

		.sticker-grid {
			grid-template-columns: repeat(3, 1fr);
			gap: 10px;
		}

		.pack-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
