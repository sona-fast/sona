<script lang="ts">
	import { page } from '$app/stores';

	const tabs = [
		{ href: '/admin/upload', label: 'Upload' },
		{ href: '/admin/images', label: 'Images' },
		{ href: '/admin/collections', label: 'Collections' },
		{ href: '/admin/tags', label: 'Tags' },
		{ href: '/admin/artists', label: 'Artists' },
		{ href: '/admin/characters', label: 'Characters' },
		{ href: '/admin/fursuit', label: 'Fursuit' },
		{ href: '/admin/stickers', label: 'Stickers' },
		{ href: '/admin/conventions', label: 'Conventions' },
		{ href: '/admin/settings', label: 'Settings' }
	];
</script>

<nav class="admin-tabs">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="admin-tab"
			class:active={$page.url.pathname.startsWith(tab.href)}
		>
			{tab.label}
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
