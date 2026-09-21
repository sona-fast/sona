<script lang="ts">
	import { page } from '$app/stores';
	import * as m from '$lib/paraglide/messages';

	const tabs = [
		{ href: '/admin/upload', label: m.admin_nav_upload },
		{ href: '/admin/images', label: m.admin_tab_images },
		{ href: '/admin/collections', label: m.admin_nav_collections },
		{ href: '/admin/tags', label: m.admin_nav_tags },
		{ href: '/admin/artists', label: m.admin_nav_artists },
		{ href: '/admin/characters', label: m.admin_nav_characters },
		{ href: '/admin/fursuit', label: m.admin_tab_fursuit },
		{ href: '/admin/stickers', label: m.admin_nav_stickers },
		{ href: '/admin/vr', label: m.admin_nav_vr },
		{ href: '/admin/conventions', label: m.admin_nav_conventions },
		{ href: '/admin/settings', label: m.admin_nav_settings },
		{ href: '/admin/observability', label: m.admin_nav_observability }
	];
</script>

<nav class="admin-tabs">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="admin-tab"
			class:active={$page.url.pathname.startsWith(tab.href)}
			aria-current={$page.url.pathname.startsWith(tab.href) ? 'page' : undefined}
		>
			{tab.label()}
		</a>
	{/each}
</nav>

<style>
	.admin-tabs {
		display: none;
	}

	@media (max-width: 768px) {
		/* The strip scrolls with no scrollbar, so nothing says there are more tabs
		   past either edge. A mask fades 24px out at both ends, and the matching
		   padding keeps the first and last tab from stopping exactly at the edge, so
		   a half-faded tab is visible whichever way the strip is scrolled. The
		   gradient is alpha only (opaque to transparent), so it dims nothing it
		   covers except those two 24px bands. */
		.admin-tabs {
			display: flex;
			gap: 6px;
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: none;
			padding: 0 24px 12px 24px;
			/* Keyboard focus scrolls the strip itself, which would otherwise park the
			   focused tab under one of the fades. */
			scroll-padding-inline-end: 24px;
			scroll-padding-inline-start: 24px;
			order: -1;
			-webkit-mask-image: linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
			mask-image: linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
		}

		.admin-tabs::-webkit-scrollbar {
			display: none;
		}

		/* Forced colors keeps the mask's alpha, so the last tab fades out to
		   nothing instead of being dimmed against a chosen background. Clipping is
		   the honest fallback; the padding stays, so the strip still ends short of
		   the edge. */
		@media (forced-colors: active) {
			.admin-tabs {
				-webkit-mask-image: none;
				mask-image: none;
			}
		}

		.admin-tab {
			flex-shrink: 0;
			padding: 6px 14px;
			border-radius: var(--radius-pill);
			font-size: 13px;
			font-family: var(--font-secondary);
			color: var(--muted-foreground);
			text-decoration: none;
			white-space: nowrap;
			transition: background 0.15s, color 0.15s;
		}

		.admin-tab:hover {
			text-decoration: none;
		}

		.admin-tab.active {
			background: var(--primary);
			color: var(--primary-foreground);
			font-weight: 500;
		}
	}
</style>
