<script lang="ts">
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import { ExternalLink, Share2, ShieldCheck } from 'lucide-svelte';
	import FurTrackIcon from '$lib/components/icons/FurTrackIcon.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import { formatDate } from '$lib';
	import * as m from '$lib/paraglide/messages';
	import { licenseTerms } from '$lib/furtrack/license-terms';

	let { data } = $props();
	const { photo } = data;

	let copied = $state(false);

	const characterTitle = photo.character
		? photo.character.charAt(0).toUpperCase() + photo.character.slice(1)
		: m.fursuit_default_title();

	// FurTrack shows the post's description as the heading, or "No description"
	// (muted) when it's empty — mirror that rather than echoing the character tag.
	const description = photo.description?.trim();

	const siteName = data.settings?.siteName ?? APP_NAME;
	const canonicalUrl = `${page.url.origin}${page.url.pathname}`;
	const metaTitle = `${characterTitle} — fursuit photo by ${photo.photographer} — ${siteName}`;
	const metaDescription = `Fursuit photo of ${characterTitle} by ${photo.photographer}${photo.event ? ` at ${photo.event}` : ''}. ${photo.license.label}.`;

	async function share() {
		const url = window.location.href;
		if (navigator.share) {
			try {
				await navigator.share({ title: metaTitle, url });
			} catch {
				/* cancelled */
			}
		} else {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		}
	}
</script>

<Meta
	title={metaTitle}
	description={metaDescription}
	url={canonicalUrl}
	image={photo.imageUrl}
	imageWidth={photo.width}
	imageHeight={photo.height}
	type="article"
	{siteName}
/>

<div class="container photo-page">
	<nav class="breadcrumb">
		<a href="/gallery">{m.nav_gallery()}</a>
		<span>/</span>
		<a href="/gallery?view=fursuit">{m.gallery_view_fursuit()}</a>
		<span>/</span>
		<span>{characterTitle}</span>
	</nav>

	<div class="photo-layout">
		<!-- contain, never crop: respects ND-licensed photos -->
		<div class="photo-preview">
			<img src={photo.imageUrl} alt={m.fursuit_alt({ character: characterTitle, photographer: photo.photographer })} />
		</div>

		<div class="photo-meta">
			<p class="eyebrow">{m.fursuit_eyebrow()}</p>
			<h1 class:no-description={!description}>{description || m.fursuit_no_description()}</h1>

			<a class="photographer-card" href={photo.photographerUrl} target="_blank" rel="noopener">
				<span class="avatar"><FurTrackIcon size={18} /></span>
				<span>
					<span class="photographer-name">{photo.photographer}</span>
					<span class="photographer-sub">{m.fursuit_photographer_sub()}</span>
				</span>
			</a>

			<div class="meta-section">
				<h3>{m.fursuit_license()}</h3>
				<div class="license">
					<div class="license-badges">
						<span class="license-badge"><ShieldCheck size={13} /> {photo.license.label}</span>
						{#if photo.permissionSource}<span class="license-badge permission" title={m.fursuit_permission_source({ source: photo.permissionSource })}><ShieldCheck size={13} /> {m.fursuit_permission_badge()}</span>{/if}
					</div>
					<p class="license-terms">{licenseTerms(photo.license)}</p>
				</div>
			</div>

			{#if photo.event || photo.character || photo.tags.length > 0}
				<div class="meta-section">
					<h3>{m.fursuit_tags()}</h3>
					<div class="tags">
						{#if photo.character}<span class="tag">{photo.character}</span>{/if}
						{#each photo.tags as tag}<span class="tag">{tag}</span>{/each}
						{#if photo.event}<span class="tag">{photo.event}</span>{/if}
					</div>
				</div>
			{/if}

			<div class="meta-section">
				<h3>{m.fursuit_details()}</h3>
				<dl class="details">
					{#if photo.width && photo.height}
						<dt>{m.fursuit_resolution()}</dt><dd>{photo.width} x {photo.height}</dd>
					{/if}
					{#if photo.takenAt}
						<dt>{m.fursuit_date_taken()}</dt><dd>{formatDate(photo.takenAt)}</dd>
					{/if}
					{#if photo.event}
						<dt>{m.fursuit_event()}</dt><dd>{photo.event}</dd>
					{/if}
				</dl>
			</div>

			<div class="actions">
				<a href={photo.furtrackUrl} target="_blank" rel="noopener" class="btn btn-primary">
					<ExternalLink size={16} /> {m.fursuit_view_on_furtrack()}
				</a>
				<button class="btn btn-outline" onclick={share}>
					<Share2 size={16} /> {copied ? m.fursuit_copied() : m.fursuit_share()}
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.photo-page {
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

	.photo-layout {
		display: grid;
		grid-template-columns: 1fr 380px;
		gap: 40px;
		align-items: start;
	}

	.photo-preview {
		background: var(--secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		max-height: 80vh;
	}

	.photo-preview img {
		max-width: 100%;
		max-height: 80vh;
		object-fit: contain;
	}

	.photo-meta h1 {
		font-size: 28px;
		margin: 0 0 16px;
	}

	.photo-meta h1.no-description {
		font-size: 22px;
		font-weight: 400;
		font-style: italic;
		color: var(--muted-foreground);
	}

	.eyebrow {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted-foreground);
		margin: 0;
	}

	.photographer-card {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		text-decoration: none;
		color: inherit;
		margin-bottom: 24px;
	}

	.photographer-card:hover {
		border-color: var(--muted-foreground);
		text-decoration: none;
	}

	.avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--secondary);
		color: var(--muted-foreground);
		flex-shrink: 0;
	}

	.photographer-name {
		display: block;
		font-weight: 600;
	}

	.photographer-sub {
		display: block;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.meta-section {
		margin-bottom: 20px;
	}

	.meta-section h3 {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-foreground);
		margin: 0 0 8px;
	}

	.license-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		font-size: 13px;
		color: var(--foreground);
	}

	.license-badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.license-badge.permission {
		border-color: var(--primary);
		color: var(--primary);
		cursor: help;
	}

	.license-terms {
		margin: 8px 0 0;
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.tag {
		padding: 2px 8px;
		background: var(--secondary);
		border-radius: var(--radius-s);
		font-size: 12px;
		color: var(--foreground);
	}

	.details {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 16px;
		font-size: 14px;
		margin: 0;
	}

	.details dt {
		color: var(--muted-foreground);
	}

	.details dd {
		margin: 0;
		text-align: right;
	}

	.actions {
		display: flex;
		gap: 12px;
		margin-top: 24px;
	}

	@media (max-width: 768px) {
		.photo-layout {
			grid-template-columns: 1fr;
			gap: 24px;
		}
	}
</style>
