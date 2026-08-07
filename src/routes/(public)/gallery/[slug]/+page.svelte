<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import { onNavigate } from '$app/navigation';
	import { Download, Share2, ExternalLink } from 'lucide-svelte';
	import { formatDate } from '$lib';
	import { heroSrc, heroSrcset, heroSizes, variantThumbSrc, rawFallback } from './hero-image';
	import Meta from '$lib/components/Meta.svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
	let image = $derived(data.image);
	let tags = $derived(data.tags);

	// Reveal is keyed to the shown image id. onNavigate clears it before the next
	// page renders, so returning to a revealed image (strip or browser history)
	// re-blurs with no unblurred flash; a same-slug load re-run fires no nav, so
	// it stays revealed.
	let revealedId = $state<number | null>(null);
	const revealed = $derived(revealedId === image.id);
	onNavigate(() => {
		revealedId = null;
	});
	let copied = $state(false);

	// Strip tile caption: the group parent reads "Original"; unlabeled variants
	// fall back to "Variant N", numbering variants only (the parent isn't one).
	function stripLabel(variant: (typeof data.variants)[number]): string {
		if (variant.parentImageId === null) return m.gallery_variant_original();
		if (variant.variantLabel) return variant.variantLabel;
		const n = data.variants.filter((v) => v.parentImageId !== null).indexOf(variant) + 1;
		return m.gallery_variant_n({ n });
	}

	// Fire-and-forget beacon so the admin dashboard can count download presses. The
	// anchor's own navigation starts the file transfer; `keepalive` lets this POST
	// outlive that. Never awaited and never surfaced — a failed count must not cost
	// the visitor their download, and an offline visitor should see no error.
	function countDownload() {
		void fetch('/api/metrics/download', { method: 'POST', keepalive: true }).catch(() => {});
	}

	async function share() {
		const url = window.location.href;
		const title = `${image.title} — ${siteName}`;

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


	const siteName = $derived(data.settings?.siteName ?? APP_NAME);
	const canonicalUrl = $derived(`${page.url.origin}${page.url.pathname}`);
	const metaTitle = $derived(`${image.title} — ${siteName}`);
	const tagSuffix = $derived(tags.length > 0 ? ` · ${tags.slice(0, 6).join(', ')}` : '');
	const metaDescription = $derived(`Commission by ${image.artistName ?? 'unknown artist'}${tagSuffix}`);
	const oembedUrl = $derived(`${page.url.origin}/api/oembed?url=${encodeURIComponent(canonicalUrl)}`);

	const socialLinks = $derived([
		{ url: image.artistTwitter, icon: TwitterIcon, label: 'Twitter' },
		{ url: image.artistBluesky, icon: BlueskyIcon, label: 'Bluesky' },
		{ url: image.artistTelegram, icon: TelegramIcon, label: 'Telegram' },
		{ url: image.artistFurAffinity, icon: FurAffinityIcon, label: 'FurAffinity' },
		{ url: image.artistDeviantArt, icon: DeviantArtIcon, label: 'DeviantArt' },
		{ url: image.artistPatreon, icon: PatreonIcon, label: 'Patreon' },
		{ url: image.artistInstagram, icon: InstagramIcon, label: 'Instagram' },
	].filter((l) => l.url));
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
					<img src={heroSrc(image.imageUrl)} srcset={heroSrcset(image.imageUrl)} sizes={heroSizes(image.imageUrl)} alt={image.title} width={image.width} height={image.height} fetchpriority="high" use:rawFallback={image.imageUrl} class="blurred" />
					<button class="reveal-btn" onclick={() => (revealedId = image.id)}>
						<span class="nsfw-label">{m.gallery_nsfw_content()}</span>
						<span>{m.gallery_click_reveal()}</span>
					</button>
				</div>
			{:else}
				<img src={heroSrc(image.imageUrl)} srcset={heroSrcset(image.imageUrl)} sizes={heroSizes(image.imageUrl)} alt={image.title} width={image.width} height={image.height} fetchpriority="high" use:rawFallback={image.imageUrl} />
			{/if}
		</div>

		<div class="image-meta">
			<h1>{image.title}</h1>
			<p class="commission-info">
				{m.gallery_commission_by()} <a href="/gallery?artist={encodeURIComponent(image.artistName ?? '')}"><strong>{image.artistName}</strong></a>
			</p>

			<div class="artist-card">
				<ArtistAvatar name={image.artistName ?? ''} avatarUrl={image.artistAvatar} size={40} />
				<div>
					<a class="artist-name" href="/gallery?artist={encodeURIComponent(image.artistName ?? '')}">{image.artistName}</a>
					{#if data.formerNames.length > 0}
						<div class="aka">{m.gallery_aka_formerly()} {data.formerNames.join(', ')}</div>
					{/if}
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

			{#if data.variants.length > 0}
				<div class="meta-section">
					<h3>{m.gallery_variants()}</h3>
					<div class="variant-strip">
						{#each data.variants as variant}
							<a
								href="/gallery/{variant.slug}"
								class="variant-tile"
								class:current={variant.slug === image.slug}
								aria-current={variant.slug === image.slug ? 'page' : undefined}
								data-sveltekit-keepfocus
								data-sveltekit-noscroll
							>
								<span class="variant-thumb">
									<img
										src={variant.thumbnailUrl || variantThumbSrc(variant.imageUrl)}
										alt={stripLabel(variant)}
										class:blurred-thumb={variant.nsfw && !revealed}
										loading="lazy"
										use:rawFallback={variant.imageUrl}
									/>
									{#if variant.nsfw && !revealed}
										<span class="variant-badge">NSFW</span>
									{/if}
								</span>
								<span class="variant-label">{stripLabel(variant)}</span>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			<div class="actions">
				<a href={image.imageUrl} download class="btn btn-primary" onclick={countDownload}><Download size={16} /> {m.gallery_download()}</a>
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
		/* The intrinsic width/height attributes reserve layout space (no CLS);
		   height:auto stops the height attribute from fixing the rendered height
		   when CSS scales the width. */
		height: auto;
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
		align-items: flex-start;
		gap: 12px;
	}

	/* AKA — a quiet mono annotation under the name. */
	.aka {
		font-family: var(--font-primary);
		font-size: 12px;
		color: var(--muted-foreground);
		margin-top: 2px;
		letter-spacing: -0.01em;
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
		text-decoration: none;
	}

	.social-icon:hover {
		color: var(--foreground);
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

	.variant-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.variant-tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 84px;
		text-decoration: none;
		color: var(--muted-foreground);
		font-size: 11px;
	}

	/* The ring lives on the wrapper (not the img) so overflow:hidden clips the
	   NSFW blur to the tile instead of letting it bleed over the current ring. */
	.variant-thumb {
		position: relative;
		display: block;
		width: 84px;
		height: 84px;
		border-radius: var(--radius-xs);
		overflow: hidden;
		border: 2px solid transparent;
		transition: border-color 0.15s;
	}

	.variant-tile img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.variant-tile:hover .variant-thumb {
		border-color: var(--border);
	}

	.variant-tile.current .variant-thumb {
		border-color: var(--primary);
	}

	.variant-badge {
		position: absolute;
		top: 4px;
		right: 4px;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.03em;
		padding: 1px 4px;
		border-radius: var(--radius-xs);
		pointer-events: none;
	}

	.variant-tile.current .variant-label {
		color: var(--foreground);
	}

	.variant-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.blurred-thumb {
		filter: blur(8px);
	}
</style>
