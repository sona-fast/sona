<!-- Shared shell for the three-path destination pages (/art, /connect, /share):
     a narrow single-column layout with a minimal back-to-splash topbar, distinct
     from the full (public) chrome. The pages are always routable; the splash
     homepage surfaces them when landingLayout === 'threePath'. -->
<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';

	let { children, data } = $props();

	const wordmark = $derived(data.settings.siteName.toUpperCase());
</script>

<div class="paths-shell">
	<header class="topbar">
		<div class="topbar-left">
			<a href="/" class="back" aria-label="Back"><ArrowLeft size={20} /></a>
			<a href="/" class="wordmark">{wordmark}</a>
		</div>
		<div class="topbar-toggles">
			<ThemeToggle />
			<LanguageToggle />
		</div>
	</header>
	<main class="paths-page">
		{@render children()}
	</main>
</div>

<MobileNav stickersEnabled={data.stickersEnabled} />

<style>
	.paths-shell {
		min-height: 100vh;
		min-height: 100dvh;
		background: var(--background);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		max-width: 600px;
		margin: 0 auto;
		padding: 16px 20px;
	}

	.topbar-left {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.topbar-toggles {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* On mobile the toggles live in the bottom nav bar instead. */
	@media (max-width: 768px) {
		.topbar-toggles {
			display: none;
		}

		.paths-page {
			padding-bottom: 88px;
		}
	}

	.back {
		display: flex;
		color: var(--muted-foreground);
		text-decoration: none;
	}

	.back:hover {
		color: var(--foreground);
	}

	.wordmark {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 14px;
		letter-spacing: 2px;
		color: var(--foreground);
		text-decoration: none;
	}

	.paths-page {
		max-width: 600px;
		margin: 0 auto;
		padding-bottom: 40px;
	}

	/* ---- Shared section primitives used by /art, /connect, /share ---- */
	.paths-page :global(.section) {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 20px 28px;
	}

	.paths-page :global(.section-label) {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 11px;
		letter-spacing: 3px;
		color: var(--primary);
		text-transform: uppercase;
	}

	.paths-page :global(.divider) {
		height: 1px;
		border: 0;
		background: var(--border);
	}

	.paths-page :global(.stack) {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* Hero block (centered icon + title + subtitle) */
	.paths-page :global(.hero) {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 32px 28px;
		background: var(--card);
		text-align: center;
	}

	.paths-page :global(.hero .hero-icon) {
		color: var(--primary);
	}

	.paths-page :global(.hero h1) {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 24px;
		color: var(--foreground);
	}

	.paths-page :global(.hero p) {
		font-family: var(--font-secondary);
		font-size: 14px;
		line-height: 1.5;
		color: var(--muted-foreground);
		max-width: 320px;
	}

	/* Bordered panel (character details, con rows) */
	.paths-page :global(.panel) {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
	}
</style>
