<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import MobileCredit from '$lib/components/MobileCredit.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';

	let { children, data } = $props();
</script>

<div class="public-layout">
	<div class="desktop-header">
		<Header
			siteName={data.settings.siteName}
			stickersEnabled={data.stickersEnabled}
			collectionsEnabled={data.collectionsEnabled}
		/>
	</div>
	<main>
		{@render children()}
	</main>
	<div class="desktop-footer">
		<Footer settings={data.settings} host={data.host} />
	</div>
	<MobileCredit settings={data.settings} host={data.host} />
	<MobileNav stickersEnabled={data.stickersEnabled} />
</div>

<style>
	.public-layout {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	main {
		flex: 1;
	}

	@media (max-width: 768px) {
		.desktop-header {
			display: none;
		}

		.desktop-footer {
			display: none;
		}
	}
</style>
