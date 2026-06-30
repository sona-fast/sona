<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const siteName = data.settings?.siteName ?? APP_NAME;
	const firstCover = data.collections.find((c) => c.coverImageUrl || c.previewImages.length > 0);
	const metaImage = firstCover?.coverImageUrl || firstCover?.previewImages[0] || null;
</script>

<Meta
	title={m.collections_meta_title({ siteName })}
	description={m.collections_meta_description({ siteName })}
	url={`${page.url.origin}${page.url.pathname}`}
	image={metaImage}
	{siteName}
/>

<div class="container collections-page">
	<div class="page-header">
		<h1>{m.collections_title()}</h1>
		<p class="count">{m.collections_count({ count: data.collections.length })}</p>
	</div>

	<div class="grid">
		{#each data.collections as collection}
			<a href="/collections/{collection.slug}" class="collection-card">
				<div class="collection-cover">
					{#if collection.coverImageUrl}
						<img src={cdnImage(collection.coverImageUrl, 800)} alt={collection.name} loading="lazy" />
					{:else if collection.previewImages.length > 0}
						<!-- Mosaic of the first ≤4 published images: 1=full, 2=side-by-side,
						     3=two-up + wide, 4=2×2. Cover-fit to match the single-cover look. -->
						<div class="mosaic" data-count={Math.min(collection.previewImages.length, 4)}>
							{#each collection.previewImages.slice(0, 4) as image}
								<img src={cdnImage(image, 400)} alt="" loading="lazy" />
							{/each}
						</div>
					{/if}
				</div>
				<div class="collection-info">
					<h2>{collection.name}</h2>
					<p class="artwork-count">{m.gallery_count_artwork({ count: collection.artworkCount })}</p>
				</div>
			</a>
		{:else}
			<p class="empty">{m.collections_empty()}</p>
		{/each}
	</div>
</div>

<style>
	.collections-page {
		padding: 32px 24px;
	}

	.page-header {
		margin-bottom: 32px;
	}

	.page-header h1 {
		font-size: 28px;
	}

	.count {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 24px;
	}

	.collection-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}

	.collection-card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.collection-cover {
		aspect-ratio: 16 / 9;
		background: var(--secondary);
		overflow: hidden;
	}

	.collection-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* Cover mosaic — up to a 2×2 grid of cover-fit image tiles */
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
		min-width: 0;
		min-height: 0;
	}

	.collection-info {
		padding: 16px;
	}

	.collection-info h2 {
		font-size: 16px;
		margin-bottom: 4px;
	}

	.artwork-count {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
		grid-column: 1 / -1;
	}

	@media (max-width: 768px) {
		.collections-page {
			padding: 20px 16px;
		}

		.grid {
			grid-template-columns: 1fr;
			gap: 16px;
		}
	}
</style>
