<script lang="ts">
	import VrAvatarForm from '$lib/components/VrAvatarForm.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<VrAvatarForm
	heading={m.admin_vr_edit_title()}
	submitLabel={m.admin_vr_save()}
	artists={data.artists}
		registryEnabled={data.registryEnabled}
	characters={data.characters}
	images={data.images}
	avatar={data.avatar}
	credits={data.credits}
	media={data.media}
	platforms={data.platforms}
	{form}
/>
