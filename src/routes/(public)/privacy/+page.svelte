<script lang="ts">
	import LegalPage from '$lib/components/LegalPage.svelte';
	import { defaultPrivacyPolicy } from '$lib/legal';
	import * as m from '$lib/paraglide/messages';

	// `settings` comes from the (public) layout load; no page-level load needed.
	let { data } = $props();
	let settings = $derived(data.settings);
	let sections = $derived(
		defaultPrivacyPolicy({
			siteName: settings.siteName,
			contactEmail: settings.contactEmail,
			aiToolsDisclosed: settings.aiPageEnabled,
			feedPublished: settings.rssFeedEnabled
		})
	);
</script>

<LegalPage
	title={m.privacy_page_title()}
	metaTitle={m.privacy_meta_title({ siteName: settings.siteName })}
	siteName={settings.siteName}
	override={settings.privacyPolicy}
	legalUpdatedAt={settings.privacyUpdatedAt}
	{sections}
/>
