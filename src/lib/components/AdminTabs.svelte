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
		{ href: '/admin/conventions', label: m.admin_nav_conventions },
		{ href: '/admin/settings', label: m.admin_nav_settings }
	];
</script>

<nav class="admin-tabs">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="admin-tab"
			class:active={$page.url.pathname.startsWith(tab.href)}
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
		.admin-tabs {
			display: flex;
			gap: 6px;
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: none;
			padding: 0 0 12px;
			order: -1;
		}

		.admin-tabs::-webkit-scrollbar {
			display: none;
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
