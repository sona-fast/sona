<script lang="ts">
	import StickerPackForm from '$lib/components/StickerPackForm.svelte';

	let { data, form } = $props();
</script>

<StickerPackForm
	heading="Add pack manually"
	submitLabel="Save pack"
	intro="Upload sticker images (PNG or WebP) and fill in the pack details. Each sticker can have its own artist and emoji. Files are uploaded to storage before saving."
	artists={data.artists}
	ownerName={data.ownerName || data.siteName}
	{form}
/>
