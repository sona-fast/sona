<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';

	let { children, data } = $props();
</script>

<div class="public-layout">
	<div class="desktop-header">
		<Header />
	</div>
	<main>
		{@render children()}
	</main>
	<div class="desktop-footer">
		<Footer settings={data.settings} />
	</div>
	<MobileNav />
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

		main {
			padding-bottom: 72px;
		}
	}
</style>
