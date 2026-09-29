<script lang="ts">
	import '../app.css';
	import { onNavigate } from '$app/navigation';
	import { createThemeState } from '$lib/theme.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import * as m from '$lib/paraglide/messages';

	let { children, data } = $props();

	// Sets up the dark/light mode store (and Svelte context for the toggle). The
	// initial `data-theme` is rendered at SSR from the mode cookie (hooks.server.ts),
	// so there's no flash; the toggle updates the attribute + cookie live.
	createThemeState();

	// Smooth cross-page transitions via the View Transitions API.
	// Browsers without the API just navigate instantly (graceful fallback).
	onNavigate((navigation) => {
		if (!document.startViewTransition) return;

		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head>
	<title>{data.siteName}</title>
	<!-- Feed autodiscovery lives in the ROOT layout, not the (public) one: the
	     homepage is +page@.svelte and escapes that layout, and the homepage is
	     exactly where a reader's "find the feed" button looks. Only ever the SFW
	     address — the keyed edition is private by construction. -->
	{#if data.rssFeedEnabled}
		<link
			rel="alternate"
			type="application/rss+xml"
			title={data.siteName}
			href="/feed.xml"
		/>
	{/if}
</svelte:head>

<!-- The first focusable element on every page. Every layout's <main> carries
     id="main-content", and tabindex="-1" there lets the jump move focus too. -->
<a class="skip-link" href="#main-content">{m.nav_skip_to_content()}</a>

{@render children()}

<Toaster />
