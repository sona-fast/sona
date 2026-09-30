<script lang="ts">
	import { page } from '$app/stores';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { APP_NAME } from '$lib/config';
	import * as m from '$lib/paraglide/messages';

	let {
		siteName = APP_NAME,
		stickersEnabled = true,
		collectionsEnabled = true
	}: { siteName?: string; stickersEnabled?: boolean; collectionsEnabled?: boolean } = $props();

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
		<div class="header-end">
			<!-- On phones the links drop out (the bottom nav holds them) and the
			     toggles stay, so the header carries only the site name and the two
			     settings. -->
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
			</nav>
			<div class="toggles">
				<LanguageToggle />
				<ThemeToggle />
			</div>
		</div>
	</div>
</header>

<style>
	.header {
		border-bottom: 1px solid var(--border);
	}

	/* A minimum height, and the name in rem, so both follow the text size; a
	   long name wraps and the toggles move under it. */
	.header-inner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		min-height: 56px;
	}

	.logo {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 1rem;
		line-height: 1.2;
		min-width: 0;
		overflow-wrap: break-word;
		color: var(--foreground);
		text-decoration: none;
	}

	.header-end,
	nav,
	.toggles {
		display: flex;
		align-items: center;
		gap: 24px;
	}

	.header-end {
		margin-left: auto;
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

	@media (max-width: 768px) {
		/* The 16px gutter the page content uses on phones. */
		.header-inner {
			padding-block: 6px;
			padding-inline: 16px;
		}

		nav {
			display: none;
		}

		.toggles {
			gap: 8px;
		}
	}
</style>
