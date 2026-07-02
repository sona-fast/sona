<script lang="ts">
	import StickerPackForm from '$lib/components/StickerPackForm.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<StickerPackForm
	heading={m.admin_pack_edit_heading({ name: data.pack.name })}
	submitLabel={m.admin_save_changes()}
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
	ownerName={data.ownerName || data.siteName}
	registryEnabled={data.registryEnabled}
	{form}
/>
