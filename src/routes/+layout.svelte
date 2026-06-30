<script lang="ts">
	import '../app.css';
	import { onNavigate } from '$app/navigation';
	import { createThemeState } from '$lib/theme.svelte';
	import Toaster from '$lib/components/Toaster.svelte';

	let { children, data } = $props();

	const theme = createThemeState();

	$effect(() => {
		document.documentElement.setAttribute('data-theme', theme.current);
	});

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
