<script lang="ts">
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		slug: string;
		title: string;
		artistName: string;
		imageUrl: string;
		tag?: string;
		nsfw?: boolean;
	}

	let { slug, title, artistName, imageUrl, tag, nsfw = false }: Props = $props();

	let revealed = $state(false);
</script>

<a href="/gallery/{slug}" class="card">
	<div class="image-wrapper">
		<img src={cdnImage(imageUrl, 800)} alt={title} loading="lazy" class:blurred={nsfw && !revealed} />
		{#if nsfw && !revealed}
			<button
				class="nsfw-overlay"
				onclick={(e) => { e.preventDefault(); revealed = true; }}
			>
				<span>NSFW</span>
				<span class="reveal-text">{m.card_click_reveal()}</span>
			</button>
		{/if}
	</div>
	<div class="card-body">
		<h3 class="card-title">{title}</h3>
		<p class="card-artist">{m.card_by_artist({ artistName })}</p>
		{#if tag}
			<span class="tag">{tag}</span>
		{/if}
	</div>
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
	}

	.card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.image-wrapper {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		background: var(--secondary);
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: filter 0.2s;
	}

	img.blurred {
		filter: blur(24px);
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
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.card-title {
		font-family: var(--font-secondary);
		font-size: 15px;
		font-weight: 600;
	}

	.card-artist {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--muted-foreground);
	}
</style>
