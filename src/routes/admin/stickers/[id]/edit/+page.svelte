<script lang="ts">
	import StickerPackForm from '$lib/components/StickerPackForm.svelte';

	let { data, form } = $props();
</script>

<StickerPackForm
	heading="Edit pack: {data.pack.name}"
	submitLabel="Save changes"
	artists={data.artists}
	pack={{
		name: data.pack.name,
		managerArtistId: data.pack.managerArtistId,
		description: data.pack.description,
		telegramUrl: data.pack.telegramUrl,
		coverImageUrl: data.pack.coverImageUrl,
		published: data.pack.published
	}}
	stickers={data.stickers.map((s) => ({
		imageUrl: s.imageUrl,
		artistId: s.artistId,
		emojis: s.emojis,
		nsfw: s.nsfw,
		format: s.format
	}))}
	{form}
/>
