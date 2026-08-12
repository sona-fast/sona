<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { socialImage } from '$lib/social-image';

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

	// $derived so the tags track prop changes on a same-route nav (e.g. the gallery
	// detail page swapping images), not just the initial value. One helper call, so
	// the advertised url and its dimensions always describe the same image.
	const social = $derived(image ? socialImage(image, url, imageWidth, imageHeight) : null);
	const ogImage = $derived(social?.url ?? null);
	const ogWidth = $derived(social?.width ?? null);
	const ogHeight = $derived(social?.height ?? null);
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
