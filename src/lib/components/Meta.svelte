<script lang="ts">
	import { APP_NAME } from '$lib/config';

	interface Props {
		title: string;
		description: string;
		url: string;
		image?: string | null;
		imageWidth?: number | null;
		imageHeight?: number | null;
		type?: 'website' | 'article';
		siteName?: string;
		oembedUrl?: string | null;
	}

	let {
		title,
		description,
		url,
		image = null,
		imageWidth = null,
		imageHeight = null,
		type = 'website',
		siteName = APP_NAME,
		oembedUrl = null
	}: Props = $props();

	const OG_MAX_WIDTH = 1200;

	function transformedImage(src: string, pageUrl: string): string {
		try {
			const origin = new URL(pageUrl).origin;
			return `${origin}/cdn-cgi/image/width=${OG_MAX_WIDTH},quality=85,fit=scale-down,format=auto/${src}`;
		} catch {
			return src;
		}
	}

	// $derived so the tags track prop changes on a same-route nav (e.g. the gallery
	// detail page swapping images), not just the initial value.
	const ogImage = $derived(image ? transformedImage(image, url) : null);

	const ogDimensions = $derived.by(() => {
		if (!(image && imageWidth && imageHeight)) return { width: null, height: null };
		if (imageWidth > OG_MAX_WIDTH) {
			return { width: OG_MAX_WIDTH, height: Math.round(imageHeight * (OG_MAX_WIDTH / imageWidth)) };
		}
		return { width: imageWidth, height: imageHeight };
	});
	const ogWidth = $derived(ogDimensions.width);
	const ogHeight = $derived(ogDimensions.height);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />

	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:type" content={type} />
	<meta property="og:site_name" content={siteName} />
	{#if ogImage}
		<meta property="og:image" content={ogImage} />
		{#if ogWidth}<meta property="og:image:width" content={String(ogWidth)} />{/if}
		{#if ogHeight}<meta property="og:image:height" content={String(ogHeight)} />{/if}
	{/if}

	<meta name="twitter:card" content={ogImage ? 'summary_large_image' : 'summary'} />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	{#if ogImage}
		<meta name="twitter:image" content={ogImage} />
	{/if}

	{#if oembedUrl}
		<link rel="alternate" type="application/json+oembed" href={oembedUrl} title={title} />
	{/if}
</svelte:head>
