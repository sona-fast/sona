<script lang="ts">
	import StickerPackForm from '$lib/components/StickerPackForm.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<StickerPackForm
	heading={m.admin_stickers_add_manual()}
	submitLabel={m.admin_pack_save()}
	intro={m.admin_pack_manual_intro()}
	artists={data.artists}
	ownerName={data.ownerName || data.siteName}
	registryEnabled={data.registryEnabled}
	{form}
/>
