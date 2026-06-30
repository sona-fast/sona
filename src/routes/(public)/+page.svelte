<script lang="ts">
	import { page } from '$app/state';
	import ArtworkCard from '$lib/components/ArtworkCard.svelte';
	import MosaicBanner from '$lib/components/MosaicBanner.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
</script>

<Meta
	title={data.settings.siteName}
	description={data.settings.aboutText}
	url={`${page.url.origin}/`}
	image={data.mosaicImageUrls[0] ?? null}
	siteName={data.settings.siteName}
/>

<MosaicBanner
	images={data.mosaicImageUrls}
	subtitle={data.settings.aboutText}
	siteName={data.settings.siteName}
/>

<section class="recent container">
	<div class="section-header">
		<h2>{m.home_recent()}</h2>
		<a href="/gallery">{m.home_see_more()} &rarr;</a>
	</div>
	<div class="grid">
		{#each data.recentImages as image}
			<ArtworkCard
				slug={image.slug}
				title={image.title}
				artistName={image.artistName || m.common_unknown()}
				imageUrl={image.thumbnailUrl || image.imageUrl}
				tag={image.tag}
				nsfw={image.nsfw}
			/>
		{:else}
			<p class="empty">{m.home_empty()}</p>
		{/each}
	</div>
</section>

<style>
	.recent {
		padding: 48px 24px;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	.section-header h2 {
		font-size: 20px;
	}

	.section-header a {
		font-size: 14px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
	}

	@media (max-width: 768px) {
		.recent {
			padding: 24px 16px;
		}

		.section-header h2 {
			font-size: 18px;
		}

		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 12px;
		}
	}
</style>
