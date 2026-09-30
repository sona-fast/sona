<script lang="ts">
	import { page } from '$app/stores';
	import { Home, LayoutGrid, Sticker, User } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let { stickersEnabled = true }: { stickersEnabled?: boolean } = $props();

	// The bar holds destinations only. The theme and language toggles live in
	// the site header, which the layouts show on phones too.
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
		// The border box: the bar's padding grows with the home-indicator inset,
		// which leaves the content box, and a content-box observer, unchanged.
		observer.observe(el, { box: 'border-box' });
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
		/* At least 8px, so the active mark never meets the screen's edge; more
		   where the home indicator needs it. */
		padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
		z-index: 50;
		/* The tabs' label size. The container queries below measure the bar in
		   em of it, so the layout switches when the labels stop fitting, at any
		   text size. rem, not px, so the labels follow the root font size. The
		   root is pinned at 16px in app.css, so a browser's default font-size
		   setting does not reach them; a user style sheet or extension that
		   overrides the root size does. */
		font-size: 0.6875rem;
		container: mobile-nav / inline-size;
	}

	@media (max-width: 768px) {
		.mobile-nav {
			display: flex;
			/* When the labels no longer fit one row (WCAG 1.4.4 and 1.4.10),
			   wrapping moves whole tabs onto a second row instead of pushing the
			   last ones off the screen. */
			flex-wrap: wrap;
			row-gap: 4px;
			justify-content: space-around;
		}

		/* The fixed bottom nav covers the foot of the page. This padding makes a
		   focused control or a scrolled-to panel stop above the nav instead of
		   behind it. It follows the bar's published height, which grows when the
		   tabs wrap. Before that height is set, the 4.5rem fallback covers a
		   one-row bar (about 67px at 16px text) plus the home-indicator inset. It
		   is in rem so it grows with the text. The extra 6px keeps a focused
		   control's ring (2px offset, 2px wide) above the bar after whole-pixel
		   scrolling. */
		:global(html) {
			scroll-padding-bottom: calc(var(--mobile-nav-height, calc(4.5rem + env(safe-area-inset-bottom, 0px))) + 6px);
		}
	}

	.tab {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		/* 2px sides: four English tabs then fit a 320px screen at 200% text with
		   room to spare. The tabs are flex: 1, so each keeps an equal share of the bar. */
		padding: 4px 2px;
		min-height: 44px;
		border-radius: var(--radius-s);
		text-decoration: none;
		color: var(--muted-foreground);
		font-family: var(--font-secondary);
		transition: color 0.15s;
	}

	/* Keep multi-character JA labels (e.g. サイトについて) on one line; the reduced
	   horizontal padding above lets all the tabs fit at 390px without wrapping.
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

	/* The active tab is marked by more than its hue (WCAG 1.4.1): a 3px bar
	   under its label. Every tab draws the slot, so the tabs stay level. */
	.tab::after {
		content: '';
		width: 24px;
		height: 3px;
		margin-top: 1px;
		border-radius: 2px;
	}

	.tab.active::after {
		background: var(--primary-text);
	}

	/* Forced colours drop author backgrounds, which would erase the mark. */
	@media (forced-colors: active) {
		.tab.active::after {
			forced-color-adjust: none;
			background: CanvasText;
		}
	}

	/* The page's ring (app.css), inset so the bar's edge does not clip it. */
	.tab:focus-visible {
		outline-offset: -2px;
	}

	/* Too narrow for the labels in one row: two tabs per row, so no tab ends
	   up alone on a row. Only with four tabs; three wrap on their own. */
	@container mobile-nav (max-width: 14em) {
		.tab:first-child:nth-last-child(4),
		.tab:first-child:nth-last-child(4) ~ .tab {
			flex: 1 1 40%;
		}
	}

	/* The Japanese labels are wider, so they reach that point sooner. A label
	   that still does not fit its half may break at a phrase boundary instead
	   of spilling out of the tab (Chromium only; elsewhere it breaks between
	   any two characters). */
	@container mobile-nav (max-width: 21.5em) {
		.tab:lang(ja):first-child:nth-last-child(4),
		.tab:lang(ja):first-child:nth-last-child(4) ~ .tab {
			flex: 1 1 40%;
		}

		.tab:lang(ja) span {
			white-space: normal;
			word-break: auto-phrase;
			text-align: center;
		}
	}
</style>
