<script lang="ts">
	import LegalPage from '$lib/components/LegalPage.svelte';
	import { defaultTerms } from '$lib/legal';
	import * as m from '$lib/paraglide/messages';

	// `settings` comes from the (public) layout load; no page-level load needed.
	let { data } = $props();
	let settings = $derived(data.settings);
	let sections = $derived(
		defaultTerms({ siteName: settings.siteName, contactEmail: settings.contactEmail })
	);
</script>

<LegalPage
	title={m.terms_page_title()}
	metaTitle={m.terms_meta_title({ siteName: settings.siteName })}
	siteName={settings.siteName}
	override={settings.termsOfService}
	{sections}
/>
