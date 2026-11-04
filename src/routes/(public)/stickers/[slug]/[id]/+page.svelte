<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page as pageState } from '$app/state';
	import { ArrowLeft } from 'lucide-svelte';
	import StickerDetail from '$lib/components/StickerDetail.svelte';
	import { isRasterFormat } from '$lib/sticker-download';
	import Meta from '$lib/components/Meta.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const pack = $derived(data.pack);
	const sticker = $derived(data.sticker);
	const siteName = $derived(data.settings?.siteName ?? APP_NAME);

	// A direct visit (a shared link, a reload, a new tab) has no grid underneath
	// and so no filter: Previous and Next walk the whole pack, as plain links
	// that work without JavaScript.
	const index = $derived(pack.stickers.findIndex((s) => s.id === sticker.id));
	const prev = $derived(index > 0 ? pack.stickers[index - 1] : null);
	const next = $derived(index < pack.stickers.length - 1 ? pack.stickers[index + 1] : null);

	const emojiLabel = $derived(sticker.emojis.join(' '));

	// Social previews need a static image. Animated stickers are .json (Lottie) and
	// video stickers are .webm — neither renders as an OG image — so only use the
	// sticker's own imageUrl when it's a static format, else fall back to a static
	// pack preview or the sticker's thumbnail.
	const metaImage = $derived(
		isRasterFormat(sticker.format)
			? sticker.imageUrl
			: pack.previewImages?.[0] ?? sticker.thumbnailUrl ?? null
	);
	const metaTitle = $derived(
		emojiLabel
			? `${emojiLabel} — ${data.pack.name} — ${siteName}`
			: `${data.pack.name} — ${siteName}`
	);
</script>

<Meta
	title={metaTitle}
	description={m.stickers_sticker_meta_description({ pack: pack.name, artist: sticker.artist?.name ?? m.stickers_unattributed(), siteName })}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={metaImage}
	{siteName}
/>

<div class="container sticker-detail-page">
	<a href="/stickers/{pack.slug}" class="back-link">
		<ArrowLeft size={16} />
		{pack.name}
	</a>

	<StickerDetail
		pack={{ slug: pack.slug, name: pack.name }}
		{sticker}
		position={index + 1}
		total={pack.stickers.length}
		prevHref={prev ? `/stickers/${pack.slug}/${prev.id}` : null}
		nextHref={next ? `/stickers/${pack.slug}/${next.id}` : null}
	/>
</div>

<style>
	.sticker-detail-page {
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

	@media (max-width: 768px) {
		.sticker-detail-page {
			padding: 16px;
		}
	}
</style>
