<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import { Download, ExternalLink } from 'lucide-svelte';
	import Meta from '$lib/components/Meta.svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import VrViewer from '$lib/components/VrViewer.svelte';
	import { cdnImage, rawFallback } from '$lib';
	import { formatBytes, modelFormatLabel, platformLabel, viewerSupports } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
	const avatar = $derived(data.avatar);

	// NSFW poster reveal — client state only, deliberately not persisted.
	let revealed = $state(false);

	// Media strip selection: null = the poster. Selecting a thumbnail swaps the
	// main display; the poster stays the initial render (and the page's LCP).
	let selected = $state<number | null>(null);
	const current = $derived(selected === null ? null : data.media[selected]);

	// Durations read client-side from each video thumb's metadata (the schema
	// stores no duration), keyed by media index.
	let durations = $state<Record<number, number>>({});

	function formatDuration(seconds: number): string {
		const s = Math.round(seconds);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	function licenseLabel(license: string | null): string | null {
		switch (license) {
			case 'personal-use':
				return m.vr_license_personal_use();
			case 'cc-by':
				return m.vr_license_cc_by();
			case 'base-tos':
				return m.vr_license_base_tos();
			case 'all-rights-reserved':
				return m.vr_license_all_rights_reserved();
			default:
				return null;
		}
	}

	function roleChip(credit: (typeof data.credits)[number]): string {
		switch (credit.role) {
			case 'base':
				return m.vr_role_base();
			case 'modeler':
				return m.vr_role_modeler();
			case 'rigger':
				return m.vr_role_rigger();
			case 'texture':
				return m.vr_role_texture();
			case 'shader':
				return m.vr_role_shader();
			default:
				// role='other' names itself via roleLabel (required in admin forms);
				// fall back to the generic label if a row slipped through without one.
				return credit.roleLabel || m.vr_role_other();
		}
	}

	const siteName = $derived(data.settings?.siteName ?? APP_NAME);
	const canonicalUrl = $derived(`${page.url.origin}${page.url.pathname}`);
	const metaDescription = $derived(
		avatar.description ?? m.vr_meta_description_detail({ name: avatar.name, siteName })
	);
</script>

<Meta
	title={`${avatar.name} — ${siteName}`}
	description={metaDescription}
	url={canonicalUrl}
	image={avatar.posterUrl}
	imageWidth={avatar.posterWidth}
	imageHeight={avatar.posterHeight}
	type="article"
	{siteName}
/>

{#snippet mainMedia()}
	{#if current}
		{#if current.kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -- showcase clips carry no dialogue -->
			<video src={current.url} controls playsinline width={current.width} height={current.height}></video>
		{:else}
			<img src={cdnImage(current.url, 1200)} alt={avatar.name} width={current.width} height={current.height} use:rawFallback={current.url} />
		{/if}
	{:else if avatar.posterUrl}
		{#if avatar.nsfw && !revealed}
			<div class="nsfw-overlay">
				<img
					src={cdnImage(avatar.posterUrl, 1200)}
					alt={avatar.name}
					width={avatar.posterWidth}
					height={avatar.posterHeight}
					fetchpriority="high"
					use:rawFallback={avatar.posterUrl}
					class="blurred"
				/>
				<button class="reveal-btn" onclick={() => (revealed = true)}>
					<span class="mature-label">{m.vr_mature_chip()}</span>
					<span>{m.vr_show_avatar()}</span>
				</button>
			</div>
		{:else}
			<img
				src={cdnImage(avatar.posterUrl, 1200)}
				alt={avatar.name}
				width={avatar.posterWidth}
				height={avatar.posterHeight}
				fetchpriority="high"
				use:rawFallback={avatar.posterUrl}
			/>
		{/if}
	{:else}
		<div class="poster-placeholder"></div>
	{/if}
{/snippet}

<div class="container avatar-page">
	<nav class="breadcrumb">
		<a href="/vr">{m.vr_title()}</a>
		<span>/</span>
		<span>{avatar.name}</span>
	</nav>

	<div class="avatar-layout">
		<div class="avatar-media">
			{#if data.modelPath && viewerSupports(avatar.modelFormat)}
				<VrViewer modelPath={data.modelPath} modelSizeBytes={avatar.modelSizeBytes} name={avatar.name}>
					<div class="media-frame">{@render mainMedia()}</div>
				</VrViewer>
			{:else}
				<div class="media-frame">{@render mainMedia()}</div>
			{/if}

			{#if data.media.length > 0}
				<div class="media-strip">
					<button
						class="media-thumb"
						class:current={selected === null}
						aria-current={selected === null}
						onclick={() => (selected = null)}
					>
						{#if avatar.posterUrl}
							<img src={cdnImage(avatar.posterUrl, 200)} alt={m.vr_media_poster()} loading="lazy" class:blurred-thumb={avatar.nsfw && !revealed} use:rawFallback={avatar.posterUrl} />
						{/if}
					</button>
					{#each data.media as item, i}
						<button
							class="media-thumb"
							class:current={selected === i}
							aria-current={selected === i}
							onclick={() => (selected = i)}
						>
							{#if item.kind === 'video'}
								<video
									src={item.url}
									muted
									playsinline
									preload="metadata"
									onloadedmetadata={(e) => (durations = { ...durations, [i]: e.currentTarget.duration })}
								></video>
								{#if durations[i]}
									<span class="duration-badge">{formatDuration(durations[i])}</span>
								{/if}
							{:else}
								<img src={cdnImage(item.url, 200)} alt={m.vr_media_item({ name: avatar.name, n: i + 1 })} loading="lazy" use:rawFallback={item.url} />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="avatar-meta">
			<h1>{avatar.name}</h1>
			<p class="character-line">
				{m.vr_avatar_of()}
				<a href="/gallery?character={encodeURIComponent(avatar.characterName)}"><strong>{avatar.characterName}</strong></a>
			</p>

			{#if avatar.description}
				<p class="description">{avatar.description}</p>
			{/if}

			<div class="chips">
				{#each data.platforms as platform}
					<span class="chip">{platformLabel(platform) ?? m.vr_platform_other()}</span>
				{/each}
				{#if data.modelPath || avatar.modelSizeBytes}
					<span class="chip format-chip">{modelFormatLabel(avatar.modelFormat)} · {formatBytes(avatar.modelSizeBytes)}</span>
				{/if}
			</div>

			{#if data.credits.length > 0}
				<div class="meta-section">
					<h3>{m.vr_credits()}</h3>
					<ul class="credits">
						{#each data.credits as credit}
							<li class="credit-row">
								<a href="/gallery?artist={encodeURIComponent(credit.artistName)}" class="credit-artist">
									<ArtistAvatar name={credit.artistName} avatarUrl={credit.artistAvatar} size={24} />
									{credit.artistName}
								</a>
								<span class="role-chip">{roleChip(credit)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if licenseLabel(avatar.license)}
				<div class="meta-section">
					<h3>{m.vr_license()}</h3>
					<span class="license-badge">{licenseLabel(avatar.license)}</span>
				</div>
			{/if}

			{#if data.downloadAllowed}
				<div class="actions">
					<a href="/vr/{avatar.slug}/download" class="btn btn-outline" download>
						<Download size={16} /> {m.vr_download_model()}
					</a>
				</div>
			{/if}

			{#if avatar.externalUrl && avatar.externalName}
				<a href={avatar.externalUrl} target="_blank" rel="noopener" class="external-card">
					<ExternalLink size={16} aria-hidden="true" />
					<span>{m.vr_external_view({ site: avatar.externalName })}</span>
				</a>
			{/if}
		</div>
	</div>
</div>

<style>
	.avatar-page {
		padding: 24px;
	}

	.breadcrumb {
		display: flex;
		gap: 8px;
		font-size: 14px;
		color: var(--muted-foreground);
		margin-bottom: 24px;
	}

	.breadcrumb a {
		color: var(--primary);
	}

	.avatar-layout {
		display: grid;
		grid-template-columns: 1fr 380px;
		gap: 40px;
		align-items: start;
	}

	.avatar-media {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.media-frame {
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.media-frame img,
	.media-frame video {
		width: 100%;
		height: auto;
		display: block;
	}

	.poster-placeholder {
		aspect-ratio: 4 / 3;
	}

	.nsfw-overlay {
		position: relative;
	}

	.blurred {
		filter: blur(32px);
	}

	.reveal-btn {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: rgba(0, 0, 0, 0.6);
		border: none;
		color: white;
		cursor: pointer;
		font-family: var(--font-primary);
		font-size: 14px;
	}

	.mature-label {
		font-weight: 600;
		font-size: 16px;
	}

	.media-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.media-thumb {
		position: relative;
		width: 84px;
		height: 84px;
		padding: 0;
		border: 2px solid transparent;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.media-thumb:hover {
		border-color: var(--border);
	}

	.media-thumb.current {
		border-color: var(--primary);
	}

	.media-thumb img,
	.media-thumb video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.blurred-thumb {
		filter: blur(8px);
	}

	.duration-badge {
		position: absolute;
		bottom: 4px;
		right: 4px;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		font-size: 10px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		pointer-events: none;
	}

	.avatar-meta {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.avatar-meta h1 {
		font-size: 24px;
	}

	.character-line {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.character-line a {
		color: inherit;
	}

	.character-line a:hover {
		text-decoration: underline;
	}

	.description {
		font-size: 14px;
		line-height: 1.6;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		font-size: 12px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--muted-foreground);
	}

	.format-chip {
		font-family: var(--font-primary);
		font-variant-numeric: tabular-nums;
	}

	.meta-section h3 {
		font-size: 12px;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 8px;
	}

	.credits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.credit-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.credit-artist {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 500;
		color: inherit;
		text-decoration: none;
	}

	.credit-artist:hover {
		text-decoration: underline;
	}

	.role-chip {
		font-size: 11px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--muted-foreground);
		white-space: nowrap;
	}

	.license-badge {
		display: inline-flex;
		font-size: 12px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		color: var(--foreground);
	}

	.actions {
		display: flex;
		gap: 12px;
	}

	.external-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--card);
		font-size: 14px;
		color: var(--foreground);
		text-decoration: none;
		transition: border-color 0.15s;
	}

	.external-card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	@media (max-width: 768px) {
		.avatar-page {
			padding: 16px;
		}

		.breadcrumb {
			margin-bottom: 16px;
			font-size: 13px;
		}

		.avatar-layout {
			grid-template-columns: 1fr;
			gap: 20px;
		}

		.avatar-meta h1 {
			font-size: 20px;
		}

		.avatar-meta {
			gap: 16px;
		}

		.actions .btn {
			width: 100%;
		}
	}
</style>
