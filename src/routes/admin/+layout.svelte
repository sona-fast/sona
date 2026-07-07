<script lang="ts">
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import { Upload, Images, Folder, User, PawPrint, Tags, Settings, LogOut, Sun, Moon, Camera, Sticker, CalendarDays, Activity } from 'lucide-svelte';
	import { getTheme } from '$lib/theme.svelte';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import AdminTabs from '$lib/components/AdminTabs.svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import * as m from '$lib/paraglide/messages';

	let { children, data } = $props();

	const theme = getTheme();

	const sidebarItems = [
		{ href: '/admin/upload', label: m.admin_nav_upload, icon: Upload },
		{ href: '/admin/images', label: m.admin_nav_all_images, icon: Images },
		{ href: '/admin/collections', label: m.admin_nav_collections, icon: Folder },
		{ href: '/admin/artists', label: m.admin_nav_artists, icon: User },
		{ href: '/admin/characters', label: m.admin_nav_characters, icon: PawPrint },
		{ href: '/admin/fursuit', label: m.admin_nav_fursuit_photos, icon: Camera },
		{ href: '/admin/stickers', label: m.admin_nav_stickers, icon: Sticker },
		{ href: '/admin/tags', label: m.admin_nav_tags, icon: Tags },
		{ href: '/admin/conventions', label: m.admin_nav_conventions, icon: CalendarDays },
		{ href: '/admin/settings', label: m.admin_nav_settings, icon: Settings },
		{ href: '/admin/observability', label: m.admin_nav_observability, icon: Activity }
	];

</script>

{#if ['/admin/login', '/admin/setup', '/admin/forgot', '/admin/reset'].includes($page.url.pathname)}
	{@render children()}
{:else}
	<div class="admin-layout">
		<aside class="sidebar">
			<div class="sidebar-header">
				<a href="/" class="logo">{data.siteName}</a>
			</div>
			<nav class="sidebar-nav">
				{#each sidebarItems as item}
					<a
						href={item.href}
						class="sidebar-link"
						class:active={$page.url.pathname.startsWith(item.href)}
					>
						<item.icon size={16} />
						{item.label()}
					</a>
				{/each}
			</nav>
			<div class="sidebar-footer">
				<form method="POST" action="/admin/logout" use:enhance>
					<button type="submit" class="sidebar-link logout-btn">
						<LogOut size={16} />
						{m.admin_logout()}
					</button>
				</form>
			</div>
		</aside>

		<div class="admin-main">
			<header class="admin-header desktop-header">
				<div class="admin-badge">{m.admin_badge()}</div>
				<LanguageToggle />
				<button class="theme-toggle" onclick={theme.toggle} aria-label={m.theme_toggle()}>
					{#if theme.current === 'dark'}
						<Sun size={16} />
					{:else}
						<Moon size={16} />
					{/if}
				</button>
				<div class="admin-avatar">
					{#if data.adminAvatarUrl}
						<img src={data.adminAvatarUrl} alt={m.nav_admin()} />
					{/if}
				</div>
			</header>

			<main class="admin-content">
				{@render children()}
				<AdminTabs />
			</main>
		</div>
	</div>
	<div class="mobile-only">
		<MobileNav />
	</div>
{/if}

<style>
	.admin-layout {
		display: flex;
		min-height: 100vh;
	}

	.sidebar {
		width: 220px;
		background: var(--sidebar);
		border-right: 1px solid var(--sidebar-border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
	}

	.sidebar-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--sidebar-border);
	}

	.logo {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 14px;
		color: var(--sidebar-foreground);
		text-decoration: none;
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		padding: 8px;
		gap: 2px;
		flex: 1;
	}

	.sidebar-link {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		font-size: 14px;
		color: var(--muted-foreground);
		text-decoration: none;
		border-radius: var(--radius-xs);
		transition: background-color 0.15s, color 0.15s;
	}

	.sidebar-link:hover {
		background: var(--sidebar-accent);
		color: var(--sidebar-foreground);
		text-decoration: none;
	}

	.sidebar-link.active {
		background: var(--sidebar-accent);
		color: var(--sidebar-foreground);
		font-weight: 500;
	}

	.sidebar-footer {
		padding: 8px;
		border-top: 1px solid var(--sidebar-border);
	}

	.logout-btn {
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		font-family: var(--font-secondary);
	}

	.admin-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.desktop-header {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border);
	}

	.admin-badge {
		font-size: 12px;
		color: var(--primary);
		font-weight: 600;
		font-family: var(--font-primary);
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

	.admin-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--primary);
		overflow: hidden;
	}

	.admin-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.admin-content {
		flex: 1;
		padding: 32px;
	}

	.mobile-only {
		display: none;
	}

	@media (max-width: 768px) {
		.sidebar {
			display: none;
		}

		.desktop-header {
			display: none;
		}

		.admin-content {
			display: flex;
			flex-direction: column;
			padding: 16px;
			padding-bottom: 88px;
		}

		.mobile-only {
			display: contents;
		}
	}
</style>
