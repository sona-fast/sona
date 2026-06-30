<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import ArtworkCard from '$lib/components/ArtworkCard.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const siteName = data.settings?.siteName ?? APP_NAME;
	const metaImage = data.collection.coverImageUrl || data.images[0]?.imageUrl || null;
	const metaDescription = m.collection_meta_description({
		countLabel: m.gallery_count_artwork({ count: data.images.length }),
		name: data.collection.name,
		siteName
	});
</script>

<Meta
	title={`${data.collection.name} — ${siteName}`}
	description={metaDescription}
	url={`${page.url.origin}${page.url.pathname}`}
	image={metaImage}
	type="article"
	{siteName}
/>

<div class="container collection-page">
	<nav class="breadcrumb">
		<a href="/collections">{m.nav_collections()}</a>
		<span>/</span>
		<span>{data.collection.name}</span>
	</nav>

	<div class="page-header">
		<h1>{data.collection.name}</h1>
		<p class="count">{m.gallery_count_artwork({ count: data.images.length })}</p>
	</div>

	<div class="grid">
		{#each data.images as image}
			<ArtworkCard
				slug={image.slug}
				title={image.title}
				artistName={image.artistName || m.common_unknown()}
				imageUrl={image.thumbnailUrl || image.imageUrl}
				tag={image.tag}
				nsfw={image.nsfw}
			/>
		{:else}
			<p class="empty">{m.collection_empty()}</p>
		{/each}
	</div>
</div>

<style>
	.collection-page {
		padding: 32px 24px;
	}

	.breadcrumb {
		display: flex;
		gap: 8px;
		font-size: 14px;
		color: var(--muted-foreground);
		margin-bottom: 24px;
	}

	.breadcrumb a {
		color: var(--primary);
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
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
		grid-column: 1 / -1;
	}
</style>
