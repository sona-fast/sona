<script lang="ts">
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import FurTrackIcon from '$lib/components/icons/FurTrackIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import * as m from '$lib/paraglide/messages';
	import { atHandleFromUrl, handleFromUrl } from '$lib/social-label';

	let { data } = $props();
	let settings = $derived(data.settings);
	let stats = $derived(data.stats);

	const ownerName = $derived(settings.ownerName || settings.siteName);

	// 2026-09-12 → 2026.09.12; same-year ranges trim the end date (→ 09.14).
	function fmt(d: string): string {
		return d.replaceAll('-', '.');
	}
	function dateRange(start: string, end: string | null): string {
		if (!end || end === start) return fmt(start);
		const same = start.slice(0, 4) === end.slice(0, 4);
		return `${fmt(start)} → ${same ? fmt(end).slice(5) : fmt(end)}`;
	}

	const socialLinks = $derived([
		{ url: settings.twitterUrl, icon: TwitterIcon, label: atHandleFromUrl(settings.twitterUrl, 'Twitter') },
		{ url: settings.telegramUrl, icon: TelegramIcon, label: handleFromUrl(settings.telegramUrl, 'Telegram') },
		{ url: settings.blueskyUrl, icon: BlueskyIcon, label: handleFromUrl(settings.blueskyUrl, 'Bluesky') },
		{ url: settings.furAffinityUrl, icon: FurAffinityIcon, label: handleFromUrl(settings.furAffinityUrl, 'FurAffinity') },
		{ url: settings.furtrackUrl, icon: FurTrackIcon, label: handleFromUrl(settings.furtrackUrl, 'FurTrack') },
		{ url: settings.instagramUrl, icon: InstagramIcon, label: atHandleFromUrl(settings.instagramUrl, 'Instagram') }
	].filter((l) => l.url));
</script>

<Meta
	title={m.about_meta_title({ siteName: settings.siteName })}
	description={settings.aboutText}
	url={`${page.url.origin}${page.url.pathname}`}
	image={data.avatarUrl}
	siteName={settings.siteName}
/>

<div class="container about-page">
	<div class="profile-card">
		<div class="avatar">
			{#if data.avatarUrl}
				<img src={data.avatarUrl} alt={ownerName} />
			{/if}
		</div>
		<h1>{ownerName}</h1>
		<p class="bio">{settings.aboutText}</p>

		<div class="stats-row">
			<div class="stat">
				<span class="stat-value">{stats.artworks}</span>
				<span class="stat-label">{m.about_stat_artworks()}</span>
			</div>
			<div class="stat">
				<span class="stat-value">{stats.artists}</span>
				<span class="stat-label">{m.about_stat_artists()}</span>
			</div>
			<div class="stat">
				<span class="stat-value">{stats.collections}</span>
				<span class="stat-label">{m.about_stat_collections()}</span>
			</div>
		</div>

		<div class="social-section">
			<h3>{m.about_find_elsewhere()}</h3>
			<div class="social-list">
				{#each socialLinks as link}
					<a href={link.url} class="social-item" target="_blank" rel="noopener noreferrer">
						<link.icon size={18} />
						<span>{link.label}</span>
					</a>
				{/each}
			</div>
		</div>

		{#if data.conventions.length > 0}
			<div class="cons-section">
				<h3>{m.about_conventions()}</h3>
				<div class="cons-list">
					{#each data.conventions as con}
						<svelte:element
							this={con.url ? 'a' : 'div'}
							class="con-item"
							href={con.url ?? undefined}
							target={con.url ? '_blank' : undefined}
							rel={con.url ? 'noopener' : undefined}
						>
							<span class="con-dates">{dateRange(con.startDate, con.endDate)}</span>
							<span class="con-info">
								<span class="con-name">{con.name}</span>
								{#if con.location}<span class="con-loc">{con.location}</span>{/if}
							</span>
						</svelte:element>
					{/each}
				</div>
			</div>
		{/if}

		<a href="/gallery" class="btn btn-primary btn-lg browse-btn">{m.browse_gallery()}</a>
	</div>
</div>

<style>
	.about-page {
		display: flex;
		justify-content: center;
		padding: 64px 24px;
	}

	.profile-card {
		max-width: 480px;
		width: 100%;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 48px;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}

	.avatar {
		width: 96px;
		height: 96px;
		border-radius: 50%;
		background: var(--secondary);
		margin-bottom: 8px;
		overflow: hidden;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	h1 {
		font-size: 24px;
	}

	.bio {
		font-size: 14px;
		color: var(--muted-foreground);
		line-height: 1.6;
	}

	.stats-row {
		display: flex;
		gap: 32px;
		padding: 16px 0;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.stat-value {
		font-family: var(--font-primary);
		font-size: 24px;
		font-weight: 700;
		color: var(--primary);
	}

	.stat-label {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.social-section {
		width: 100%;
		margin-top: 8px;
	}

	.social-section h3 {
		font-size: 12px;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
	}

	.social-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}

	.social-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--foreground);
		text-decoration: none;
		font-size: 14px;
		transition: background 0.15s;
	}

	.social-item:hover {
		background: var(--muted);
		text-decoration: none;
	}

	.cons-section {
		width: 100%;
		margin-top: 8px;
	}

	.cons-section h3 {
		font-size: 12px;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
	}

	.cons-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}

	.con-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-radius: var(--radius-s);
		background: var(--secondary);
		color: var(--foreground);
		text-decoration: none;
		font-size: 14px;
		text-align: left;
	}

	a.con-item:hover {
		background: var(--muted);
		text-decoration: none;
	}

	.con-dates {
		font-size: 12px;
		color: var(--muted-foreground);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.con-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.con-name {
		font-weight: 500;
	}

	.con-loc {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.browse-btn {
		margin-top: 8px;
		width: 100%;
	}

	@media (max-width: 768px) {
		.about-page {
			padding: 24px 16px;
		}

		.profile-card {
			padding: 32px 24px;
			border: none;
			background: none;
		}

		.stats-row {
			gap: 24px;
		}
	}
</style>
