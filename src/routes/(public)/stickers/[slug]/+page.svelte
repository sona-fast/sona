<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { page as pageState } from '$app/state';
	import { Send, Server, ArrowLeft, X } from 'lucide-svelte';
	import StickerCard from '$lib/components/StickerCard.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const pack = $derived(data.pack);
	const siteName = $derived(data.settings?.siteName ?? APP_NAME);
	const ownerName = $derived(data.settings?.ownerName || data.settings?.siteName || APP_NAME);

	// `pack.artists` is already distinct-by-id (getPackBySlug builds it from a Set).
	const distinctArtists = $derived(pack.artists);

	// Does this pack hold any unattributed (null-artist) stickers? If so they get
	// their own selectable "Unassigned" group in the artist filter.
	const hasUnassigned = $derived(pack.stickers.some((s) => !s.artist));

	// The artist filter is a set of selectable groups: each distinct artist plus an
	// optional "Unassigned" group. Only worth showing when there's more than one.
	const artistGroupCount = $derived(distinctArtists.length + (hasUnassigned ? 1 : 0));
	const showArtistFilter = $derived(artistGroupCount > 1);

	// Currently-selected artist groups (artist ids as strings, plus `unassigned`).
	const selectedArtists = $derived(new Set(data.filters.artist));

	// Social links for the sole artist (single-artist packs).
	const soleArtistLinks = $derived.by(() => {
		const a = data.pack.soleArtist;
		if (!a) return [];
		return [
			{ url: a.twitterUrl, icon: TwitterIcon, label: 'Twitter' },
			{ url: a.blueskyUrl, icon: BlueskyIcon, label: 'Bluesky' },
			{ url: a.telegramUrl, icon: TelegramIcon, label: 'Telegram' },
			{ url: a.furAffinityUrl, icon: FurAffinityIcon, label: 'FurAffinity' },
			{ url: a.deviantArtUrl, icon: DeviantArtIcon, label: 'DeviantArt' },
			{ url: a.patreonUrl, icon: PatreonIcon, label: 'Patreon' },
			{ url: a.instagramUrl, icon: InstagramIcon, label: 'Instagram' }
		].filter((l) => l.url);
	});

	// Emoji rail scoped to this pack — derived from the pack's own stickers so it
	// works against the existing emoji filter without any extra server data.
	const packEmojis = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of pack.stickers) {
			for (const e of s.emojis) counts.set(e, (counts.get(e) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([emoji]) => emoji);
	});

	function updateFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) {
			params.set(key, value);
		} else {
			params.delete(key);
		}
		if (key === 'emoji') params.delete('q');
		if (key === 'q') params.delete('emoji');
		goto(`?${params.toString()}`, { replaceState: true });
	}

	// Toggle one artist group (an artist id or the `unassigned` sentinel) in/out of
	// the multi-select, encoded as repeated `?artist=` params.
	function toggleArtist(value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		const current = params.getAll('artist');
		params.delete('artist');
		const next = current.includes(value)
			? current.filter((v) => v !== value)
			: [...current, value];
		for (const v of next) params.append('artist', v);
		goto(`?${params.toString()}`, { replaceState: true });
	}

	function clearFilters() {
		goto(`/stickers/${data.pack.slug}`, { replaceState: true });
	}

	const activeEmoji = $derived(data.filters.emoji || data.filters.q);
</script>

<Meta
	title={m.stickers_pack_meta_title({ name: pack.name, siteName })}
	description={pack.description ?? m.stickers_meta_description({ siteName, ownerName })}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={pack.previewImages?.[0] ?? null}
	{siteName}
/>

<!-- Cover mosaic: first ≤4 stickers (1=full, 2=side-by-side, 3=two-up + wide,
     4=2×2), contained on the checkerboard to match the sticker tiles. -->
{#snippet mosaic(images: string[])}
	<div class="mosaic" data-count={Math.min(images.length, 4)}>
		{#each images.slice(0, 4) as image}
			<img src={cdnImage(image, 200)} alt="" loading="lazy" />
		{/each}
	</div>
{/snippet}

<div class="container pack-page">
	<a href="/stickers" class="back-link">
		<ArrowLeft size={16} />
		{m.stickers_back_to_packs()}
	</a>

	<!-- Pack header -->
	<div class="pack-header">
		<div class="header-left">
			<h1 class="pack-name">{pack.name}</h1>

			<div class="header-meta">
				<span class="sticker-count">{m.stickers_count({ count: pack.stickerCount ?? pack.stickers.length })}</span>
			</div>

			{#if pack.description}
				<p class="pack-description">{pack.description}</p>
			{/if}

			<!-- Single-artist credit: avatar, name + role, social links -->
			{#if pack.shape === 'single' && pack.soleArtist}
				<div class="artist-credit">
					{#if pack.soleArtist.avatarUrl}
						<img src={pack.soleArtist.avatarUrl} alt={pack.soleArtist.name} class="artist-avatar" />
					{/if}
					<div class="artist-namecol">
						<span class="artist-name-text">{pack.soleArtist.name}</span>
						<span class="artist-role">{m.stickers_artist_role()}</span>
					</div>
					{#if soleArtistLinks.length > 0}
						<div class="artist-socials">
							{#each soleArtistLinks as link}
								<a href={link.url} target="_blank" rel="noopener" aria-label={link.label} class="social-btn">
									<link.icon size={18} />
								</a>
							{/each}
						</div>
					{/if}
				</div>

			<!-- Multi-artist: managed by the site owner -->
			{:else}
				<div class="managed-block">
					<span class="managed-by">{m.stickers_managed_by_owner_label({ ownerName })}</span>
				</div>
			{/if}
		</div>

		<div class="header-right">
			{#if pack.previewImages.length > 0}
				<div class="header-cover">
					{@render mosaic(pack.previewImages)}
				</div>
			{/if}
			{#if pack.source === 'telegram'}
				<span class="pack-chip telegram">{m.stickers_telegram_pack()}</span>
			{:else}
				<span class="pack-chip"><Server size={14} />{m.stickers_source_self_hosted()}</span>
			{/if}
			{#if pack.telegramUrl}
				<a href={pack.telegramUrl} target="_blank" rel="noopener" class="btn btn-primary telegram-cta">
					<Send size={16} />
					{m.stickers_add_to_telegram()}
				</a>
			{:else}
				<p class="self-hosted-note">{m.stickers_hosted_by_owner({ ownerName })}</p>
			{/if}
		</div>
	</div>

	<!-- Contributing artists row — doubles as the artist filter (clickable,
	     multi-selectable badges). Hidden when there's only one group. -->
	{#if showArtistFilter}
		<div class="contributors">
			<p class="contrib-label">{m.stickers_contributing_artists({ n: distinctArtists.length })}</p>
			<div class="contrib-row">
				{#each distinctArtists as artist}
					<button
						type="button"
						class="contrib-chip"
						class:active={selectedArtists.has(String(artist.id))}
						aria-pressed={selectedArtists.has(String(artist.id))}
						title={artist.name}
						onclick={() => toggleArtist(String(artist.id))}
					>
						{#if artist.avatarUrl}
							<img src={artist.avatarUrl} alt="" class="contrib-avatar" />
						{/if}
						{artist.name}
					</button>
				{/each}
				{#if hasUnassigned}
					<button
						type="button"
						class="contrib-chip"
						class:active={selectedArtists.has('unassigned')}
						aria-pressed={selectedArtists.has('unassigned')}
						title="Unassigned"
						onclick={() => toggleArtist('unassigned')}
					>
						Unassigned
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Sticker grid + scoped filters -->
	<div class="grid-section">
		<div class="scoped-filter">
			{#if packEmojis.length > 0}
				<div class="emoji-rail">
					{#each packEmojis as emoji}
						<button
							class="emoji-chip"
							class:active={data.filters.emoji === emoji}
							onclick={() => updateFilter('emoji', data.filters.emoji === emoji ? '' : emoji)}
							title={emoji}
						>{emoji}</button>
					{/each}
				</div>
			{/if}

			<div class="filter-right">
				{#if data.hasFilter}
					<button class="ghost-btn" onclick={clearFilters}>
						<X size={16} />
						{m.stickers_clear_filters()}
					</button>
				{/if}
			</div>
		</div>

		{#if data.hasFilter}
			<p class="filter-summary">
				{m.stickers_pack_filter_summary({ count: data.stickers.length })}
				{#if activeEmoji}<span class="summary-emoji">{activeEmoji}</span>{/if}
			</p>
		{/if}

		{#if data.stickers.length > 0}
			<div class="sticker-grid">
				{#each data.stickers as sticker}
					<StickerCard {sticker} packSlug={pack.slug} showArtist={pack.shape === 'multi'} />
				{/each}
			</div>
		{:else}
			<div class="empty-state">
				<div class="empty-icon">{activeEmoji && /\p{Emoji}/u.test(activeEmoji) ? activeEmoji : '🦊'}</div>
				<div class="empty-text">
					<p class="empty-title">{m.stickers_empty_title({ query: activeEmoji ? m.stickers_query_term({ query: activeEmoji }) : m.stickers_empty_fallback() })}</p>
					<p class="empty-subtext">{m.stickers_empty_subtext()}</p>
				</div>
				<button class="btn btn-outline" onclick={clearFilters}>{m.stickers_clear_filters()}</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.pack-page {
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

	/* Pack header — text column left, CTA column right */
	.pack-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 32px;
		margin-bottom: 24px;
	}

	.header-left {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 680px;
	}

	.pack-name {
		font-family: var(--font-primary);
		font-size: 28px;
		font-weight: 700;
	}

	.header-meta {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.sticker-count {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.pack-description {
		font-size: 15px;
		color: var(--muted-foreground);
		line-height: 1.5;
	}

	/* Single-artist credit */
	.artist-credit {
		display: flex;
		align-items: center;
		gap: 12px;
		padding-top: 4px;
	}

	.artist-avatar {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.artist-namecol {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.artist-name-text {
		font-size: 15px;
		font-weight: 600;
	}

	.artist-role {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.artist-socials {
		display: flex;
		gap: 8px;
		padding-left: 8px;
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
		transition: border-color 0.15s, background 0.15s;
	}

	.social-btn:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.managed-block {
		padding-top: 4px;
	}

	.managed-by {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	/* Header right column */
	.header-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 12px;
		flex-shrink: 0;
	}

	/* Cover mosaic in the header — a square pack thumbnail on the checkerboard */
	.header-cover {
		width: 180px;
		max-width: 40vw;
		aspect-ratio: 1;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
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

	.pack-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-primary);
		font-size: 13px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--muted-foreground);
	}

	.pack-chip.telegram {
		background: color-mix(in srgb, var(--primary) 16%, var(--background));
		color: var(--primary);
	}

	.telegram-cta {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.self-hosted-note {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	/* Contributing artists */
	.contributors {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 24px;
	}

	.contrib-label {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.5px;
		color: var(--muted-foreground);
	}

	.contrib-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	/* Contributing-artist badges double as the artist filter, so they're buttons. */
	.contrib-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 14px;
		border-radius: var(--radius-pill);
		border: 1px solid transparent;
		background: var(--secondary);
		color: var(--foreground);
		font-family: var(--font-primary);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s, color 0.15s;
	}

	/* Tighter left padding when the badge leads with an avatar. */
	.contrib-chip:has(.contrib-avatar) {
		padding-left: 4px;
	}

	.contrib-chip:hover {
		background: color-mix(in srgb, var(--secondary) 70%, var(--foreground));
	}

	.contrib-chip.active {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
	}

	.contrib-avatar {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	/* Sticker grid section */
	.grid-section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.scoped-filter {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
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

	.filter-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}

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

	.filter-summary {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.summary-emoji {
		font-size: 16px;
		margin-left: 4px;
	}

	.sticker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 16px;
	}

	/* Empty / no-results state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 18px;
		padding: 56px 24px;
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
		.pack-page {
			padding: 16px;
		}

		.pack-header {
			flex-direction: column;
			gap: 20px;
		}

		.header-right {
			align-items: flex-start;
		}

		.pack-name {
			font-size: 22px;
		}

		.sticker-grid {
			grid-template-columns: repeat(3, 1fr);
			gap: 10px;
		}
	}
</style>
