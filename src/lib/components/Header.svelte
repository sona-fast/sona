<script lang="ts">
	import { page } from '$app/stores';
	import { Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import { APP_NAME } from '$lib/config';
	import * as m from '$lib/paraglide/messages';

	let {
		siteName = APP_NAME,
		stickersEnabled = true,
		collectionsEnabled = true
	}: { siteName?: string; stickersEnabled?: boolean; collectionsEnabled?: boolean } = $props();

	const theme = getTheme();

	// Stickers and Collections are content-gated like the tab-bar pills: the
	// link drops out while its section has no published content (About/Gallery
	// always show). The defaults fail OPEN so a caller passing no flags keeps
	// every link.
	const navItems = $derived([
		{ href: '/gallery', label: m.nav_gallery },
		...(stickersEnabled ? [{ href: '/stickers', label: m.nav_stickers }] : []),
		...(collectionsEnabled ? [{ href: '/collections', label: m.nav_collections }] : []),
		{ href: '/about', label: m.nav_about }
	]);
</script>

<header class="header">
	<div class="header-inner container">
		<a href="/" class="logo" aria-current={$page.url.pathname === '/' ? 'page' : undefined}>{siteName}</a>
		<nav aria-label={m.nav_main_label()}>
			{#each navItems as item (item.href)}
				{@const active = $page.url.pathname.startsWith(item.href)}
				<!-- "page" only on the section's own page: a piece under /gallery is in
				     the Gallery section ("true") but is not the Gallery page. -->
				<a
					href={item.href}
					class="nav-link"
					class:active
					aria-current={$page.url.pathname === item.href ? 'page' : active ? 'true' : undefined}
				>
					{item.label()}
				</a>
			{/each}
			<LanguageToggle />
			<button class="theme-toggle" onclick={theme.toggle} aria-label={m.theme_toggle()}>
				{#if theme.current === 'dark'}
					<Sun size={16} />
				{:else}
					<Moon size={16} />
				{/if}
			</button>
		</nav>
	</div>
</header>

<style>
	.header {
		border-bottom: 1px solid var(--border);
	}

	.header-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 56px;
	}

	.logo {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 16px;
		color: var(--foreground);
		text-decoration: none;
	}

	nav {
		display: flex;
		align-items: center;
		gap: 24px;
	}

	.nav-link {
		font-size: 14px;
		color: var(--muted-foreground);
		text-decoration: none;
		transition: color 0.15s;
	}

	.nav-link:hover,
	.nav-link.active {
		color: var(--foreground);
		text-decoration: none;
	}

	.theme-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-pill);
		border: none;
		background: var(--secondary);
		color: var(--foreground);
		cursor: pointer;
		transition: background 0.15s;
	}

	.theme-toggle:hover {
		background: var(--muted);
	}
</style>
