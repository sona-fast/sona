<script lang="ts">
	import { page } from '$app/state';
	import { Download, Share2, ExternalLink } from 'lucide-svelte';
	import { formatDate } from '$lib';
	import Meta from '$lib/components/Meta.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
	const { image, tags } = data;

	let revealed = $state(!image.nsfw);
	let copied = $state(false);

	async function share() {
		const url = window.location.href;
		const title = `${image.title} — sparky.ink`;

		if (navigator.share) {
			try {
				await navigator.share({ title, url });
			} catch {
				// User cancelled
			}
		} else {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		}
	}

	function formatFileSize(bytes: number | null): string {
		if (!bytes) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}


	const siteName = data.settings?.siteName ?? 'sparky.ink';
	const canonicalUrl = `${page.url.origin}${page.url.pathname}`;
	const metaTitle = `${image.title} — ${siteName}`;
	const tagSuffix = tags.length > 0 ? ` · ${tags.slice(0, 6).join(', ')}` : '';
	const metaDescription = `Commission by ${image.artistName ?? 'unknown artist'}${tagSuffix}`;
	const oembedUrl = `${page.url.origin}/api/oembed?url=${encodeURIComponent(canonicalUrl)}`;

	const socialLinks = [
		{ url: image.artistTwitter, icon: TwitterIcon, label: 'Twitter' },
		{ url: image.artistBluesky, icon: BlueskyIcon, label: 'Bluesky' },
		{ url: image.artistTelegram, icon: TelegramIcon, label: 'Telegram' },
		{ url: image.artistFurAffinity, icon: FurAffinityIcon, label: 'FurAffinity' },
		{ url: image.artistDeviantArt, icon: DeviantArtIcon, label: 'DeviantArt' },
		{ url: image.artistPatreon, icon: PatreonIcon, label: 'Patreon' },
		{ url: image.artistInstagram, icon: InstagramIcon, label: 'Instagram' },
	].filter((l) => l.url);
</script>

<Meta
	title={metaTitle}
	description={metaDescription}
	url={canonicalUrl}
	image={image.imageUrl}
	imageWidth={image.width}
	imageHeight={image.height}
	type="article"
	{siteName}
	{oembedUrl}
/>

<div class="container image-page">
	<nav class="breadcrumb">
		<a href="/gallery">{m.nav_gallery()}</a>
		<span>/</span>
		{#if image.collectionName}
			<a href="/collections/{image.collectionSlug}">{image.collectionName}</a>
			<span>/</span>
		{/if}
		<span>{image.title}</span>
	</nav>

	<div class="image-layout">
		<div class="image-preview">
			{#if image.nsfw && !revealed}
				<div class="nsfw-overlay">
					<img src={image.imageUrl} alt={image.title} class="blurred" />
					<button class="reveal-btn" onclick={() => (revealed = true)}>
						<span class="nsfw-label">{m.gallery_nsfw_content()}</span>
						<span>{m.gallery_click_reveal()}</span>
					</button>
				</div>
			{:else}
				<img src={image.imageUrl} alt={image.title} />
			{/if}
		</div>

		<div class="image-meta">
			<h1>{image.title}</h1>
			<p class="commission-info">
				{m.gallery_commission_by()} <a href="/gallery?artist={encodeURIComponent(image.artistName ?? '')}"><strong>{image.artistName}</strong></a>
			</p>

			<div class="artist-card">
				<div class="avatar">
					{#if image.artistAvatar}
						<img src={image.artistAvatar} alt={image.artistName} />
					{/if}
				</div>
				<div>
					<a class="artist-name" href="/gallery?artist={encodeURIComponent(image.artistName ?? '')}">{image.artistName}</a>
					{#if image.commissionedAt}
						<p class="commission-date">{m.gallery_commissioned_date({ date: formatDate(image.commissionedAt) })}</p>
					{/if}
				</div>
			</div>

			{#if socialLinks.length > 0}
				<div class="artist-socials">
					{#each socialLinks as link}
						<a href={link.url} target="_blank" rel="noopener" aria-label={link.label} class="social-icon">
							<link.icon size={18} />
						</a>
					{/each}
				</div>
			{/if}

			{#if image.sourcePostUrl}
				<div class="meta-section">
					<h3>{m.gallery_source()}</h3>
					<a href={image.sourcePostUrl} target="_blank" rel="noopener" class="source-link">
						<ExternalLink size={14} /> {m.gallery_view_original()}
					</a>
				</div>
			{/if}

			{#if tags.length > 0}
				<div class="meta-section">
					<h3>{m.gallery_tags()}</h3>
					<div class="tags">
						{#each tags as tag}
							<a href="/gallery?tag={tag}" class="tag">{tag}</a>
						{/each}
					</div>
				</div>
			{/if}

			{#if data.characters.length > 0}
				<div class="meta-section">
					<h3>{m.gallery_featured_characters()}</h3>
					<div class="characters-list">
						{#each data.characters as char}
							<div class="character-row">
								<a href="/gallery?character={encodeURIComponent(char.name)}" class="character-chip">
									{#if char.avatarUrl}<img class="char-avatar" src={char.avatarUrl} alt="" />{/if}
									{char.name}
									{#if char.ownerName}<span class="char-owner">({char.ownerName})</span>{/if}
								</a>
								{#if char.url}
									<a href={char.url} target="_blank" rel="noopener" class="char-profile-link" aria-label={m.gallery_character_profile()}>
										<ExternalLink size={14} />
									</a>
								{/if}
								<div class="char-socials">
									{#if char.twitterUrl}<a href={char.twitterUrl} target="_blank" rel="noopener" class="char-social"><TwitterIcon size={14} /></a>{/if}
									{#if char.blueskyUrl}<a href={char.blueskyUrl} target="_blank" rel="noopener" class="char-social"><BlueskyIcon size={14} /></a>{/if}
									{#if char.telegramUrl}<a href={char.telegramUrl} target="_blank" rel="noopener" class="char-social"><TelegramIcon size={14} /></a>{/if}
									{#if char.furAffinityUrl}<a href={char.furAffinityUrl} target="_blank" rel="noopener" class="char-social"><FurAffinityIcon size={14} /></a>{/if}
									{#if char.deviantArtUrl}<a href={char.deviantArtUrl} target="_blank" rel="noopener" class="char-social"><DeviantArtIcon size={14} /></a>{/if}
									{#if char.patreonUrl}<a href={char.patreonUrl} target="_blank" rel="noopener" class="char-social"><PatreonIcon size={14} /></a>{/if}
									{#if char.instagramUrl}<a href={char.instagramUrl} target="_blank" rel="noopener" class="char-social"><InstagramIcon size={14} /></a>{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="meta-section">
				<h3>{m.gallery_details()}</h3>
				<dl class="details">
					{#if image.width && image.height}
						<dt>{m.gallery_resolution()}</dt><dd>{image.width} x {image.height}</dd>
					{/if}
					{#if image.fileSize}
						<dt>{m.gallery_file_size()}</dt><dd>{formatFileSize(image.fileSize)}</dd>
					{/if}
					<dt>{m.gallery_uploaded()}</dt><dd>{formatDate(image.createdAt)}</dd>
					{#if image.collectionName}
						<dt>{m.gallery_collection()}</dt><dd><a href="/collections/{image.collectionSlug}">{image.collectionName}</a></dd>
					{/if}
				</dl>
			</div>

			<div class="actions">
				<a href={image.imageUrl} download class="btn btn-primary"><Download size={16} /> {m.gallery_download()}</a>
				<button class="btn btn-outline" onclick={share}>
					<Share2 size={16} /> {copied ? m.gallery_copied() : m.gallery_share()}
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.image-page {
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

	.image-layout {
		display: grid;
		grid-template-columns: 1fr 380px;
		gap: 40px;
		align-items: start;
	}

	.image-preview {
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.image-preview img {
		width: 100%;
		display: block;
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

	.nsfw-label {
		font-weight: 600;
		font-size: 16px;
	}

	.image-meta {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.image-meta h1 {
		font-size: 24px;
	}

	.commission-info {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.artist-card {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--secondary);
		overflow: hidden;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.artist-name {
		font-weight: 600;
		font-size: 14px;
		color: inherit;
		text-decoration: none;
	}

	.artist-name:hover {
		text-decoration: underline;
	}

	.commission-info a {
		color: inherit;
	}

	.commission-info a:hover {
		text-decoration: underline;
	}

	.commission-date {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.artist-socials {
		display: flex;
		gap: 12px;
	}

	.social-icon {
		color: var(--muted-foreground);
		display: flex;
		transition: color 0.15s;
	}

	.social-icon:hover {
		color: var(--foreground);
		text-decoration: none;
	}

	.meta-section h3 {
		font-size: 12px;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 8px;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.tags a {
		text-decoration: none;
		color: inherit;
	}

	.tags a:hover {
		text-decoration: none;
		opacity: 0.8;
	}

	.characters-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.character-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.char-socials {
		display: flex;
		gap: 10px;
	}

	.char-social {
		color: var(--muted-foreground);
		display: flex;
		transition: color 0.15s;
	}

	.char-social:hover {
		color: var(--foreground);
	}

	.character-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 12px 4px 4px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--foreground);
		font-size: 13px;
		text-decoration: none;
		transition: background 0.15s;
	}

	.character-chip .char-avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.char-profile-link {
		display: inline-flex;
		align-items: center;
		color: var(--muted-foreground);
	}

	.char-profile-link:hover {
		color: var(--foreground);
	}

	a.character-chip:hover {
		background: var(--muted);
		text-decoration: none;
	}

	.char-owner {
		color: var(--muted-foreground);
		font-size: 11px;
	}

	.details {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 16px;
		font-size: 14px;
	}

	.details dt {
		color: var(--muted-foreground);
	}

	.source-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
	}

	.actions {
		display: flex;
		gap: 12px;
	}

	@media (max-width: 768px) {
		.image-page {
			padding: 16px;
		}

		.breadcrumb {
			margin-bottom: 16px;
			font-size: 13px;
		}

		.image-layout {
			grid-template-columns: 1fr;
			gap: 20px;
		}

		.image-meta h1 {
			font-size: 20px;
		}

		.image-meta {
			gap: 16px;
		}

		.actions {
			flex-direction: column;
		}

		.actions .btn {
			width: 100%;
		}
	}
</style>
