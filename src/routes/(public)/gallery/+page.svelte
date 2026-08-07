<script lang="ts">
	import { APP_NAME, GALLERY_VIEW_STORAGE_KEY } from '$lib/config';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { page as pageState } from '$app/state';
	import { Search, ChevronDown, LayoutGrid, List, ImageOff, ArrowRight } from 'lucide-svelte';
	import ArtworkCard from '$lib/components/ArtworkCard.svelte';
	import FursuitPhotoCard from '$lib/components/FursuitPhotoCard.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import { formatDate, cdnImage, rawFallback } from '$lib';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const isFursuit = $derived(data.view === 'fursuit');

	// Client-side pagination over the loaded fursuit photos.
	const FURSUIT_PER_PAGE = 12;
	let fursuitPage = $state(1);
	const fursuitTotalPages = $derived(Math.ceil(data.fursuitPhotos.length / FURSUIT_PER_PAGE));
	const pagedFursuit = $derived(
		data.fursuitPhotos.slice((fursuitPage - 1) * FURSUIT_PER_PAGE, fursuitPage * FURSUIT_PER_PAGE)
	);
	// Reset to page 1 whenever the loaded set changes (filters / navigation).
	$effect(() => {
		data.fursuitPhotos;
		fursuitPage = 1;
	});

	const siteName = data.settings?.siteName ?? APP_NAME;
	const metaTitle = m.gallery_meta_title({ siteName });
	const metaDescription = m.gallery_meta_description({ count: data.total, siteName });

	let view = $state<'grid' | 'list'>(
		(typeof window !== 'undefined' && localStorage.getItem(GALLERY_VIEW_STORAGE_KEY) as 'grid' | 'list') || 'grid'
	);

	$effect(() => {
		localStorage.setItem(GALLERY_VIEW_STORAGE_KEY, view);
	});

	function updateFilter(key: string, value: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (value) {
			params.set(key, value);
		} else {
			params.delete(key);
		}
		params.delete('page');
		goto(`?${params.toString()}`, { replaceState: true });
	}

	// Artist filter as a type-to-filter combobox. A native <select> only does
	// first-letter typeahead and never narrows its options, so with 80+ artists
	// typing felt broken ("non-matching artists still show up"). This filters the
	// list by case-insensitive substring on the artist name.
	let artistQuery = $state(data.filters.artist);
	let artistOpen = $state(false);
	let artistBox = $state<HTMLDivElement>();

	// Keep the input text in sync with the active filter after navigation, but
	// never clobber what the user is typing while the menu is open.
	$effect(() => {
		const active = data.filters.artist;
		if (!artistOpen) artistQuery = active;
	});

	// Match on the current name OR any former name, so an old handle still finds
	// the artist in the combobox.
	const artistMatches = $derived(
		data.artists.filter((a) => {
			const q = artistQuery.toLowerCase();
			return (
				a.name.toLowerCase().includes(q) ||
				(a.formerly ?? []).some((f) => f.toLowerCase().includes(q))
			);
		})
	);

	function selectArtist(name: string) {
		artistOpen = false;
		artistQuery = name;
		updateFilter('artist', name);
	}

	// Close the menu when clicking outside of it.
	$effect(() => {
		if (!artistOpen) return;
		function onPointerDown(e: PointerEvent) {
			if (artistBox && !artistBox.contains(e.target as Node)) artistOpen = false;
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	});
</script>

<Meta
	title={metaTitle}
	description={metaDescription}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={data.images[0]?.imageUrl ?? null}
	{siteName}
/>

<div class="container gallery-page">
	<div class="page-header">
		<h1>{m.gallery_title()}</h1>
		<p class="count">
			{isFursuit ? m.gallery_count_fursuit({ count: data.fursuitPhotos.length }) : m.gallery_count_artwork({ count: data.total })}
		</p>
	</div>

	<div class="tabs" role="tablist">
		<button
			class="tab"
			class:active={!isFursuit}
			role="tab"
			aria-selected={!isFursuit}
			onclick={() => updateFilter('view', '')}
		>
			{m.gallery_view_artwork()}
		</button>
		{#if data.fursuitEnabled}
			<button
				class="tab"
				class:active={isFursuit}
				role="tab"
				aria-selected={isFursuit}
				onclick={() => updateFilter('view', 'fursuit')}
			>
				{m.gallery_view_fursuit()}
			</button>
		{/if}
		<a href="/stickers" class="tab">{m.gallery_view_stickers()}</a>
	</div>

	{#if isFursuit}
		{#if data.fursuitPhotographers.length > 0 || data.fursuitEvents.length > 0}
			<div class="filters">
				<div class="select-wrapper">
					<select
						class="input filter-select"
						value={data.fursuitFilters.photographer}
						onchange={(e) => updateFilter('photographer', e.currentTarget.value)}
					>
						<option value="">{m.gallery_all_photographers()}</option>
						{#each data.fursuitPhotographers as p}
							<option value={p}>{p}</option>
						{/each}
					</select>
				</div>
				<div class="select-wrapper">
					<select
						class="input filter-select"
						value={data.fursuitFilters.event}
						onchange={(e) => updateFilter('event', e.currentTarget.value)}
					>
						<option value="">{m.gallery_all_events()}</option>
						{#each data.fursuitEvents as ev}
							<option value={ev}>{ev}</option>
						{/each}
					</select>
				</div>
			</div>
		{/if}

		{#if data.fursuitPhotos.length > 0}
			{#if data.fursuitCapped}
				<p class="fursuit-cap">{m.gallery_fursuit_capped()}</p>
			{/if}
			<div class="grid">
				{#each pagedFursuit as photo}
					<FursuitPhotoCard {photo} />
				{/each}
			</div>
			{#if fursuitTotalPages > 1}
				<nav class="pagination">
					<button class="btn btn-secondary" disabled={fursuitPage === 1} onclick={() => (fursuitPage -= 1)}>{m.gallery_previous()}</button>
					{#each Array.from({ length: fursuitTotalPages }, (_, i) => i + 1) as p}
						<button class="page-link" class:active={p === fursuitPage} onclick={() => (fursuitPage = p)}>{p}</button>
					{/each}
					<button class="btn btn-secondary" disabled={fursuitPage === fursuitTotalPages} onclick={() => (fursuitPage += 1)}>{m.gallery_next()}</button>
				</nav>
			{/if}
			<p class="fursuit-note">
				{m.gallery_fursuit_note()}
			</p>
		{:else}
			<div class="fursuit-empty">
				<ImageOff size={40} aria-hidden="true" />
				<p class="empty-title">{m.gallery_fursuit_empty_title()}</p>
				<p class="empty-sub">{m.gallery_fursuit_empty_sub()}</p>
			</div>
		{/if}
	{:else}
	{#if data.formerName}
		<div class="aka-pointer">
			<div class="txt">
				<span class="cmt">{m.gallery_aka_formerly()}</span> {m.gallery_aka_pointer({ old: data.formerName.searched, current: data.formerName.current })}
			</div>
			<div class="spacer"></div>
			<a class="go" href="/gallery?artist={encodeURIComponent(data.formerName.current)}">
				{m.gallery_aka_view({ current: data.formerName.current })}
				<ArrowRight size={13} />
			</a>
		</div>
	{/if}
	<div class="filters">
		<div class="search-wrapper">
			<Search size={16} class="search-icon" />
			<input
				type="search"
				class="input search"
				placeholder={m.gallery_search_placeholder()}
				value={data.filters.search}
				onchange={(e) => updateFilter('q', e.currentTarget.value)}
			/>
		</div>
		<div class="select-wrapper">
			<select
				class="input filter-select"
				value={data.filters.tag}
				onchange={(e) => updateFilter('tag', e.currentTarget.value)}
			>
				<option value="">{m.gallery_all_tags()}</option>
				{#each data.tags as tag}
					<option value={tag.name}>{tag.name}</option>
				{/each}
			</select>
		</div>
		<div class="select-wrapper combobox" bind:this={artistBox}>
			<input
				type="text"
				class="input filter-select combobox-input"
				placeholder={m.gallery_all_artists()}
				bind:value={artistQuery}
				onfocus={() => (artistOpen = true)}
				oninput={() => (artistOpen = true)}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						artistOpen = false;
						artistQuery = data.filters.artist;
						e.currentTarget.blur();
					} else if (e.key === 'Enter') {
						e.preventDefault();
						if (artistMatches.length) selectArtist(artistMatches[0].name);
					}
				}}
				role="combobox"
				aria-expanded={artistOpen}
				aria-controls="artist-combobox-list"
				autocomplete="off"
			/>
			<ChevronDown size={16} class="select-chevron" />
			{#if artistOpen}
				<ul class="combobox-list" id="artist-combobox-list" role="listbox">
					<li>
						<button
							type="button"
							class="combobox-option"
							class:selected={!data.filters.artist}
							role="option"
							aria-selected={!data.filters.artist}
							onclick={() => selectArtist('')}
						>{m.gallery_all_artists()}</button>
					</li>
					{#each artistMatches as artist}
						<li>
							<button
								type="button"
								class="combobox-option"
								class:selected={artist.name === data.filters.artist}
								role="option"
								aria-selected={artist.name === data.filters.artist}
								onclick={() => selectArtist(artist.name)}
							>{artist.name}{#if artist.formerly?.length}<span class="combobox-former">· {m.gallery_aka_formerly()} {artist.formerly.join(', ')}</span>{/if}</button>
						</li>
					{:else}
						<li class="combobox-empty">No matching artists</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="select-wrapper">
			<select
				class="input filter-select"
				value={data.filters.character}
				onchange={(e) => updateFilter('character', e.currentTarget.value)}
			>
				<option value="">{m.gallery_all_characters()}</option>
				{#each data.characters as character}
					<option value={character.name}>{character.name}</option>
				{/each}
			</select>
		</div>
		<div class="select-wrapper">
			<select
				class="input filter-select"
				value={data.filters.sort}
				onchange={(e) => updateFilter('sort', e.currentTarget.value)}
			>
				<option value="newest">{m.gallery_sort_newest()}</option>
				<option value="oldest">{m.gallery_sort_oldest()}</option>
				<option value="commissioned-newest">{m.gallery_sort_commissioned_newest()}</option>
				<option value="commissioned-oldest">{m.gallery_sort_commissioned_oldest()}</option>
			</select>
		</div>
		<div class="view-toggle">
			<button class="view-btn" class:active={view === 'grid'} onclick={() => (view = 'grid')} aria-label={m.gallery_grid_view()}><LayoutGrid size={18} /></button>
			<button class="view-btn" class:active={view === 'list'} onclick={() => (view = 'list')} aria-label={m.gallery_list_view()}><List size={18} /></button>
		</div>
	</div>

	<div class={view === 'grid' ? 'grid' : 'list'}>
		{#each data.images as image}
			{#if view === 'grid'}
				<ArtworkCard
					slug={image.slug}
					title={image.title}
					artistName={image.artistName || m.common_unknown()}
					imageUrl={image.thumbnailUrl || image.imageUrl}
					tag={image.tag}
					nsfw={image.nsfw}
				/>
			{:else}
				<a href="/gallery/{image.slug}" class="list-item">
					<div class="list-thumb" class:nsfw-thumb={image.nsfw}>
						<img src={cdnImage(image.thumbnailUrl || image.imageUrl, 200)} alt={image.title} loading="lazy" use:rawFallback={image.thumbnailUrl || image.imageUrl} />
					</div>
					<div class="list-info">
						<h3 class="list-title">
							{image.title}
							{#if image.nsfw}<span class="nsfw-badge">NSFW</span>{/if}
						</h3>
						<p class="list-artist">{m.card_by_artist({ artistName: image.artistName || m.common_unknown() })}</p>
					</div>
					{#if image.tag}
						<span class="tag">{image.tag}</span>
					{/if}
					<span class="list-date">{image.commissionedAt ? formatDate(image.commissionedAt) : '—'}</span>
				</a>
			{/if}
		{:else}
			<p class="empty">{m.gallery_empty_artwork()}</p>
		{/each}
	</div>

	{#if data.totalPages > 1}
		<nav class="pagination">
			{#if data.page > 1}
				<a href="?page={data.page - 1}" class="btn btn-secondary">{m.gallery_previous()}</a>
			{/if}
			{#each Array.from({ length: data.totalPages }, (_, i) => i + 1) as p}
				<a
					href="?page={p}"
					class="page-link"
					class:active={p === data.page}
				>{p}</a>
			{/each}
			{#if data.page < data.totalPages}
				<a href="?page={data.page + 1}" class="btn btn-secondary">{m.gallery_next()}</a>
			{/if}
		</nav>
	{/if}
	{/if}
</div>

<style>
	.gallery-page {
		padding: 32px 24px;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.page-header h1 {
		font-size: 28px;
	}

	.count {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	/* Pill segmented control — matches the /stickers tab bar for one sitewide style. */
	.tabs {
		display: inline-flex;
		gap: 8px;
		margin-bottom: 20px;
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

	.fursuit-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 64px 24px;
		text-align: center;
		color: var(--muted-foreground);
	}

	.empty-title {
		font-size: 16px;
		color: var(--foreground);
	}

	.empty-sub {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.fursuit-note {
		margin-top: 24px;
		text-align: center;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.fursuit-cap {
		margin-bottom: 16px;
		font-size: 13px;
		color: var(--muted-foreground);
	}

	/* pagination buttons reuse .page-link (normally an <a>); reset button chrome */
	button.page-link {
		border: none;
		background: none;
		font: inherit;
		cursor: pointer;
	}

	button.page-link.active {
		background: var(--background);
		border: 1px solid var(--border);
	}

	.filters {
		display: flex;
		gap: 12px;
		margin-bottom: 24px;
		flex-wrap: wrap;
		align-items: center;
	}

	.search-wrapper {
		position: relative;
		flex: 1;
		min-width: 200px;
	}

	.search-wrapper :global(.search-icon) {
		position: absolute;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.search {
		padding-left: 40px;
	}

	.select-wrapper {
		position: relative;
	}

	.select-wrapper :global(.select-chevron) {
		position: absolute;
		right: 16px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.filter-select {
		width: auto;
		min-width: 140px;
		padding-right: 42px;
		appearance: none;
	}

	/* Artist type-to-filter combobox */
	.combobox-input {
		cursor: text;
	}

	.combobox-list {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 20;
		max-height: 260px;
		overflow-y: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	.combobox-option {
		display: block;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: none;
		background: none;
		border-radius: var(--radius-xs);
		font: inherit;
		color: var(--foreground);
		cursor: pointer;
	}

	.combobox-option:hover {
		background: var(--secondary);
	}

	.combobox-option.selected {
		background: var(--secondary);
		font-weight: 600;
	}

	.combobox-empty {
		padding: 8px 10px;
		font-size: 13px;
		color: var(--muted-foreground);
	}

	/* Former name annotation in the combobox — quiet mono, like the credit line. */
	.combobox-former {
		margin-left: 6px;
		font-family: var(--font-primary);
		font-size: 12px;
		color: var(--muted-foreground);
	}

	/* AKA pointer — one quiet line when an old ?artist= name was redirected. A thin
	   ember accent rule on the left, not a glowing box; matches the design mock. */
	.aka-pointer {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-left: 2px solid var(--primary);
		border-radius: var(--radius-s);
		background: var(--card);
		margin-bottom: 24px;
	}

	.aka-pointer .txt {
		font-size: 14px;
		color: var(--foreground);
		line-height: 1.5;
	}

	.aka-pointer .cmt {
		font-family: var(--font-primary);
		font-size: 12px;
		color: var(--muted-foreground);
		margin-right: 6px;
	}

	.aka-pointer .spacer {
		flex: 1;
	}

	.aka-pointer .go {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		color: var(--muted-foreground);
		text-decoration: none;
		white-space: nowrap;
	}

	.aka-pointer .go:hover {
		color: var(--foreground);
	}

	.view-toggle {
		display: flex;
		gap: 4px;
		background: var(--secondary);
		border-radius: var(--radius-pill);
		padding: 4px;
	}

	.view-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-pill);
		border: none;
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.view-btn.active {
		background: var(--background);
		color: var(--foreground);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}

	.list-item {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		text-decoration: none;
		color: inherit;
		transition: background 0.15s;
	}

	.list-item:last-child {
		border-bottom: none;
	}

	.list-item:hover {
		background: var(--card);
		text-decoration: none;
	}

	.list-thumb {
		width: 56px;
		height: 56px;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
		flex-shrink: 0;
	}

	.list-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.nsfw-thumb {
		position: relative;
	}

	.nsfw-thumb img {
		filter: blur(8px);
	}

	.nsfw-badge {
		font-size: 10px;
		font-weight: 600;
		font-family: var(--font-primary);
		color: var(--destructive);
		margin-left: 6px;
	}

	.list-info {
		flex: 1;
		min-width: 0;
	}

	.list-title {
		font-size: 14px;
		font-weight: 600;
	}

	.list-artist {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.list-date {
		font-size: 13px;
		color: var(--muted-foreground);
		white-space: nowrap;
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
		grid-column: 1 / -1;
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin-top: 40px;
	}

	.page-link {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-pill);
		font-size: 14px;
		color: var(--muted-foreground);
		text-decoration: none;
		transition: background 0.15s;
	}

	.page-link:hover {
		background: var(--secondary);
		text-decoration: none;
	}

	.page-link.active {
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--border);
	}

	@media (max-width: 768px) {
		.gallery-page {
			padding: 20px 16px;
		}

		.page-header h1 {
			font-size: 24px;
		}

		.filters {
			gap: 8px;
		}

		.search-wrapper {
			min-width: 100%;
		}

		.select-wrapper {
			display: none;
		}

		.view-toggle {
			display: none;
		}

		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 10px;
		}

		.list-item {
			gap: 10px;
			padding: 10px 12px;
		}

		.list-thumb {
			width: 44px;
			height: 44px;
		}

		.list-date {
			display: none;
		}

		.pagination {
			gap: 4px;
			margin-top: 24px;
		}

		.page-link {
			width: 34px;
			height: 34px;
			font-size: 13px;
		}
	}
</style>
