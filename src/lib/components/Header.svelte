<script lang="ts">
	import { page } from '$app/stores';
	import { Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import * as m from '$lib/paraglide/messages';

	const theme = getTheme();

	const navItems = [
		{ href: '/gallery', label: m.nav_gallery },
		{ href: '/stickers', label: m.nav_stickers },
		{ href: '/collections', label: m.nav_collections },
		{ href: '/about', label: m.nav_about }
	];
</script>

<header class="header">
	<div class="header-inner container">
		<a href="/" class="logo">sparky.ink</a>
		<nav>
			{#each navItems as item}
				<a href={item.href} class="nav-link" class:active={$page.url.pathname.startsWith(item.href)}>
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
