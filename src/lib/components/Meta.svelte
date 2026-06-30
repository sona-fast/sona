<script lang="ts">
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
		siteName = 'sparky.ink',
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

	const ogImage = image ? transformedImage(image, url) : null;

	let ogWidth: number | null = null;
	let ogHeight: number | null = null;
	if (image && imageWidth && imageHeight) {
		if (imageWidth > OG_MAX_WIDTH) {
			const scale = OG_MAX_WIDTH / imageWidth;
			ogWidth = OG_MAX_WIDTH;
			ogHeight = Math.round(imageHeight * scale);
		} else {
			ogWidth = imageWidth;
			ogHeight = imageHeight;
		}
	}
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
