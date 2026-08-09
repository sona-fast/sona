<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page as pageState } from '$app/state';
	import { Box, ExternalLink } from 'lucide-svelte';
	import Meta from '$lib/components/Meta.svelte';
	import { cdnImage, rawFallback } from '$lib';
	import { platformLabel } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	const siteName = $derived(data.settings?.siteName ?? APP_NAME);
</script>

<Meta
	title={m.vr_meta_title({ siteName })}
	description={m.vr_meta_description({ count: data.total, siteName })}
	url={`${pageState.url.origin}${pageState.url.pathname}`}
	image={data.avatars[0]?.posterUrl ?? null}
	{siteName}
/>

<div class="container vr-page">
	<div class="page-header">
		<h1>{m.vr_title()}</h1>
		<p class="count">{m.vr_count({ count: data.total })}</p>
	</div>

	<!-- Tab bar — pill segmented control; VR avatars is active here -->
	<div class="tabs">
		<a href="/gallery" class="tab">{m.gallery_view_artwork()}</a>
		{#if data.fursuitEnabled}
			<a href="/gallery?view=fursuit" class="tab">{m.gallery_view_fursuit()}</a>
		{/if}
		<a href="/stickers" class="tab">{m.gallery_view_stickers()}</a>
		<span class="tab active" aria-current="page">{m.gallery_view_vr()}</span>
	</div>

	{#if data.avatars.length > 0}
		<div class="grid">
			{#each data.avatars as avatar}
				<a href="/vr/{avatar.slug}" class="card">
					<div class="poster">
						{#if avatar.posterUrl}
							<img
								src={cdnImage(avatar.posterUrl, 800)}
								alt={avatar.name}
								loading="lazy"
								class:blurred={avatar.nsfw}
								use:rawFallback={avatar.posterUrl}
							/>
						{:else}
							<div class="poster-placeholder"><Box size={40} aria-hidden="true" /></div>
						{/if}
						{#if avatar.nsfw}
							<span class="mature-chip">{m.vr_mature_chip()}</span>
						{/if}
						{#if avatar.hasModel}
							<span class="model-badge">{m.vr_badge_model({ format: avatar.formatLabel ?? 'VRM' })}</span>
						{:else if avatar.externalName}
							<span class="model-badge external">{avatar.externalName} <ExternalLink size={11} aria-hidden="true" /></span>
						{/if}
					</div>
					<div class="card-body">
						<h3 class="card-title">{avatar.name}</h3>
						{#if avatar.platforms.length > 0}
							<div class="platforms">
								{#each avatar.platforms as platform}
									<span class="platform-chip">{platformLabel(platform) ?? m.vr_platform_other()}</span>
								{/each}
							</div>
						{/if}
					</div>
				</a>
			{/each}
		</div>
	{:else}
		<div class="empty-state">
			<Box size={40} aria-hidden="true" />
			<p class="empty-title">{m.vr_empty_title()}</p>
			<p class="empty-sub">{m.vr_empty_sub()}</p>
		</div>
	{/if}
</div>

<style>
	.vr-page {
		padding: 32px 24px;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.page-header h1 {
		font-size: 28px;
	}

	.count {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	/* Pill segmented control — matches the /gallery and /stickers tab bars. */
	.tabs {
		display: inline-flex;
		gap: 8px;
		margin-bottom: 24px;
		padding: 4px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		border: none;
		background: none;
		font-family: var(--font-secondary);
		font-size: 14px;
		font-weight: 500;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: color 0.15s, background 0.15s;
		text-decoration: none;
	}

	.tab:hover {
		color: var(--foreground);
		text-decoration: none;
	}

	.tab.active {
		color: var(--foreground);
		background: var(--background);
		box-shadow: 0 1px 3.5px rgba(0, 0, 0, 0.06);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}

	.card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.poster {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		background: var(--secondary);
	}

	.poster img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.poster img.blurred {
		filter: blur(16px);
	}

	.poster-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-foreground);
	}

	.mature-chip {
		position: absolute;
		top: 10px;
		left: 10px;
		font-size: 11px;
		font-weight: 600;
		font-family: var(--font-primary);
		padding: 3px 8px;
		border-radius: var(--radius-pill);
		background: rgba(0, 0, 0, 0.7);
		color: #ffffff;
	}

	.model-badge {
		position: absolute;
		bottom: 10px;
		right: 10px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 600;
		font-family: var(--font-primary);
		letter-spacing: 0.02em;
		padding: 3px 8px;
		border-radius: var(--radius-pill);
		background: rgba(0, 0, 0, 0.7);
		color: #ffffff;
	}

	.card-body {
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.card-title {
		font-size: 15px;
		font-weight: 600;
	}

	.platforms {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.platform-chip {
		font-size: 11px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--muted-foreground);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 64px 24px;
		text-align: center;
		color: var(--muted-foreground);
	}

	.empty-title {
		font-size: 16px;
		color: var(--foreground);
	}

	.empty-sub {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	@media (max-width: 768px) {
		.vr-page {
			padding: 20px 16px;
		}

		.page-header h1 {
			font-size: 24px;
		}

		.grid {
			grid-template-columns: repeat(2, 1fr);
			gap: 10px;
		}
	}
</style>
