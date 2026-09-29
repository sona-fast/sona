<script lang="ts">
	import { page } from '$app/stores';
	import { Home, LayoutGrid, Sticker, User, Sun, Moon } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import * as m from '$lib/paraglide/messages';

	let { stickersEnabled = true }: { stickersEnabled?: boolean } = $props();

	const theme = getTheme();

	// The Stickers tab is content-gated like the header's link: hidden while no
	// published pack exists. The default fails OPEN so a caller passing no flag
	// (e.g. the admin shell) keeps every tab.
	const tabs = $derived([
		{ href: '/', label: m.nav_home, icon: Home },
		{ href: '/gallery', label: m.nav_gallery, icon: LayoutGrid },
		...(stickersEnabled ? [{ href: '/stickers', label: m.nav_stickers, icon: Sticker }] : []),
		{ href: '/about', label: m.nav_about, icon: User }
	]);

	// Publish the bar's height so the layouts' bottom gap (--mobile-nav-clearance
	// in app.css) grows with it. Enlarged text wraps the tabs onto a second row,
	// and a fixed 88px gap would then leave the page's last lines under the bar.
	// The property is left in place on teardown: the next page's nav overwrites
	// it, and a removal racing that write would reset the gap to its floor.
	let navEl: HTMLElement | undefined = $state();
	$effect(() => {
		const el = navEl;
		if (!el) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(() => {
			root.style.setProperty('--mobile-nav-height', `${el.offsetHeight}px`);
		});
		observer.observe(el);
		return () => observer.disconnect();
	});

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/';
		return pathname.startsWith(href);
	}
</script>

<nav class="mobile-nav" aria-label={m.nav_main_label()} bind:this={navEl}>
	{#each tabs as tab (tab.href)}
		{@const active = isActive(tab.href, $page.url.pathname)}
		<!-- "page" only on the section's own page: a piece under /gallery is in
		     the Gallery section ("true") but is not the Gallery page. -->
		<a
			href={tab.href}
			class="tab"
			class:active
			aria-current={$page.url.pathname === tab.href ? 'page' : active ? 'true' : undefined}
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
			/* At 320px with 200% text the five labels no longer fit one row
			   (WCAG 1.4.4 and 1.4.10). Wrapping moves whole tabs onto a second
			   row instead of pushing the last ones off the screen. */
			flex-wrap: wrap;
			row-gap: 4px;
			justify-content: space-around;
		}

		/* The fixed bottom nav (about 53px tall, plus the home-indicator inset
		   its bottom padding adds) covers the foot of the page. This padding
		   makes a focused control or a scrolled-to panel stop above the nav
		   instead of behind it. */
		:global(html) {
			scroll-padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
		}
	}

	.tab {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		border-radius: var(--radius-s);
		text-decoration: none;
		color: var(--muted-foreground);
		/* rem, not px, so the labels follow the root font size. The root is
		   pinned at 16px in app.css, so a browser's default font-size setting
		   does not reach them; a user style sheet or extension that overrides
		   the root size does. */
		font-size: 0.6875rem;
		font-family: var(--font-secondary);
		transition: color 0.15s;
	}

	/* Keep multi-character JA labels (e.g. サイトについて) on one line; the reduced
	   horizontal padding above lets all five tabs fit at 390px without wrapping.
	   When they cannot fit, the bar wraps whole tabs rather than breaking a
	   label mid-word. */
	.tab span {
		white-space: nowrap;
	}

	.tab:hover {
		text-decoration: none;
	}

	.tab.active {
		color: var(--primary-text);
	}

	.theme-tab {
		background: none;
		border: none;
		cursor: pointer;
		font-family: var(--font-secondary);
	}
</style>
