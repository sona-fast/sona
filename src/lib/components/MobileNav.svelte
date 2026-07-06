<script lang="ts">
	import { page } from '$app/stores';
	import { Home, LayoutGrid, Sticker, User, Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import * as m from '$lib/paraglide/messages';

	const theme = getTheme();

	const tabs = [
		{ href: '/', label: m.nav_home, icon: Home },
		{ href: '/gallery', label: m.nav_gallery, icon: LayoutGrid },
		{ href: '/stickers', label: m.nav_stickers, icon: Sticker },
		{ href: '/about', label: m.nav_about, icon: User }
	];

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/';
		return pathname.startsWith(href);
	}
</script>

<nav class="mobile-nav">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="tab"
			class:active={isActive(tab.href, $page.url.pathname)}
		>
			<tab.icon size={20} />
			<span>{tab.label()}</span>
		</a>
	{/each}
	<button class="tab theme-tab" onclick={theme.toggle} aria-label={m.theme_toggle()}>
		{#if theme.current === 'dark'}
			<Sun size={20} />
			<span>{m.theme_light()}</span>
		{:else}
			<Moon size={20} />
			<span>{m.theme_dark()}</span>
		{/if}
	</button>
</nav>

<style>
	.mobile-nav {
		display: none;
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--card);
		border-top: 1px solid var(--border);
		padding: 8px 0;
		padding-bottom: env(safe-area-inset-bottom, 8px);
		z-index: 50;
	}

	@media (max-width: 768px) {
		.mobile-nav {
			display: flex;
			justify-content: space-around;
		}
	}

	.tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		border-radius: var(--radius-s);
		text-decoration: none;
		color: var(--muted-foreground);
		font-size: 11px;
		font-family: var(--font-secondary);
		transition: color 0.15s;
	}

	/* Keep multi-character JA labels (e.g. サイトについて) on one line; the reduced
	   horizontal padding above lets all five tabs fit at 390px without wrapping. */
	.tab span {
		white-space: nowrap;
	}

	.tab:hover {
		text-decoration: none;
	}

	.tab.active {
		color: var(--primary);
	}

	.theme-tab {
		background: none;
		border: none;
		cursor: pointer;
		font-family: var(--font-secondary);
	}
</style>
