<script lang="ts">
	// A gallery piece's thumbnail in the ledger: the piece's thumbnail, or its
	// full image when it has none, through the CDN like the admin pickers. The
	// link beside it names the piece, so the image itself is decorative.
	import { Image as ImageIcon } from 'lucide-svelte';
	import { cdnImage, rawFallback, THUMB_WIDTH } from '$lib/img';

	let { src }: { src: string | null } = $props();
</script>

<span class="thumb">
	{#if src}
		<img src={cdnImage(src, THUMB_WIDTH)} alt="" loading="lazy" use:rawFallback={src} />
	{:else}
		<ImageIcon size={16} aria-hidden="true" />
	{/if}
</span>

<style>
	.thumb {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-xs);
		background: var(--secondary);
		color: var(--muted-foreground);
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
		overflow: hidden;
		/* A 10% edge keeps a light or dark piece from melting into the page. */
		outline: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent);
		outline-offset: -1px;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
</style>
