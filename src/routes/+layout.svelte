<script lang="ts">
	import '../app.css';
	import { onNavigate } from '$app/navigation';
	import { createThemeState } from '$lib/theme.svelte';
	import Toaster from '$lib/components/Toaster.svelte';

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
</svelte:head>

{@render children()}

<Toaster />
