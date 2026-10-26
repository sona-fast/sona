<script lang="ts">
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	// Asks before an action makes a Keep private artist public (SONA-236); see
	// createUnhideConfirm.
	interface Props {
		names: string[];
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { names, onconfirm, oncancel }: Props = $props();
	const list = $derived(new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names));
</script>

<ConfirmDialog
	title={m.admin_unhide_artist_title()}
	message={m.admin_unhide_artist_message({ names: list })}
	confirmLabel={m.admin_unhide_artist_confirm()}
	{onconfirm}
	{oncancel}
/>
