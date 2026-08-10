<script lang="ts">
	import { tick } from 'svelte';
	import { APP_NAME } from '$lib/config';
	import { page } from '$app/state';
	import { Box, Download, ExternalLink, Play } from 'lucide-svelte';
	import Meta from '$lib/components/Meta.svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import VrViewer from '$lib/components/VrViewer.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';
	import { cdnImage, rawFallback, responsiveSrc, responsiveSrcset, responsiveSizes } from '$lib/img';
	import type { ResponsiveImage } from '$lib/img';
	import { creditRoleLabel, formatBytes, licenseLabel, modelFormatLabel, platformLabel } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();
	const avatar = $derived(data.avatar);

	// Responsive poster spec, mirroring the gallery hero (hero-image.ts): the
	// poster fills the 1fr column beside the 380px meta panel — full-width on
	// mobile, then calc(100vw - 468px) (380px meta + 40px gap + 48px padding)
	// until the container cap, where it settles at ~810 CSS px.
	const POSTER: ResponsiveImage = {
		widths: [800, 1200, 1600],
		sizes: '(max-width: 768px) 100vw, (max-width: 1280px) calc(100vw - 468px), 810px',
		quality: 80,
		srcWidth: 1200
	};

	// NSFW poster reveal — client state only, deliberately not persisted.
	let revealed = $state(false);
	let mediaFrame = $state<HTMLDivElement>();
	let revealAnnouncement = $state('');
	async function reveal() {
		revealed = true;
		// The reveal button unmounts itself: announce the change politely and
		// land focus on the revealed frame instead of letting it fall to <body>
		// (the gallery detail twin got the same fix, R2-A7).
		revealAnnouncement = m.mature_revealed();
		await tick();
		mediaFrame?.focus();
	}

	// Media strip selection: null = the poster. Selecting a thumbnail swaps the
	// main display; the poster stays the initial render (and the page's LCP).
	let selected = $state<number | null>(null);
	const current = $derived(selected === null ? null : data.media[selected]);

	// While the 3D stage covers the poster, selecting a strip thumb has no
	// visible effect — the strip is disabled for the duration (R2-D12).
	let viewerActive = $state(false);

	// Durations read client-side from each video thumb's metadata (the schema
	// stores no duration), keyed by media index. Non-finite durations are
	// skipped — MediaRecorder-produced WebMs declare Infinity, and an
	// "Infinity:NaN" badge is worse than none (R2-D4).
	let durations = $state<Record<number, number>>({});

	// Same-route navigation (/vr/a → /vr/b, e.g. browser back/forward) reuses
	// this component, so per-avatar state must not survive the slug change: a
	// stale `revealed` would render the next NSFW avatar pre-revealed, a stale
	// `selected` can index past a shorter media list, and `durations` keys
	// would label the wrong clips. Gallery precedent: the fursuitPage reset.
	$effect(() => {
		void avatar.slug;
		revealed = false;
		revealAnnouncement = '';
		selected = null;
		viewerActive = false;
		durations = {};
	});
	function noteDuration(i: number, el: HTMLVideoElement) {
		if (Number.isFinite(el.duration)) durations = { ...durations, [i]: el.duration };
	}

	// Video-thumb action: metadata is fetched only once the thumb scrolls into
	// view (the observer upgrades preload none→metadata) — a strip of clips
	// below the fold must not cost one metadata request per <video> at page
	// load. The mount-time readyState check covers a cached hard load, where
	// loadedmetadata fires before any listener attaches (DS1).
	let thumbObserver: IntersectionObserver | undefined;
	function videoThumb(el: HTMLVideoElement, i: number) {
		const onMeta = () => noteDuration(i, el);
		el.addEventListener('loadedmetadata', onMeta);
		if (el.readyState >= 1) noteDuration(i, el);
		thumbObserver ??= new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const video = entry.target as HTMLVideoElement;
				video.preload = 'metadata';
				// Flipping preload after the element settled on none doesn't
				// reliably start the metadata fetch — load() forces it.
				video.load();
				thumbObserver?.unobserve(video);
			}
		});
		thumbObserver.observe(el);
		return {
			destroy() {
				el.removeEventListener('loadedmetadata', onMeta);
				thumbObserver?.unobserve(el);
			}
		};
	}

	function formatDuration(seconds: number): string {
		const s = Math.round(seconds);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	// CC BY 4.0 §3(a)(1): redistribution must carry attribution — keep the full
	// credit string right next to the download button so it travels with the
	// decision to save the file. Credited artists, else the character's name.
	const ccByAttribution = $derived(
		avatar.license === 'cc-by' && data.downloadAllowed
			? m.vr_ccby_attribution({
					names: data.credits.map((c) => c.artistName).join(', ') || avatar.characterName
				})
			: null
	);

	// Per-row social icons — the gallery's credited-artist treatment (see
	// gallery/[slug] socialLinks), named per row ("Kestrel on Twitter") because
	// several credit rows can carry identically-platformed links.
	function creditSocials(credit: (typeof data.credits)[number]) {
		return [
			{ url: credit.artistTwitter, icon: TwitterIcon, label: 'Twitter' },
			{ url: credit.artistBluesky, icon: BlueskyIcon, label: 'Bluesky' },
			{ url: credit.artistTelegram, icon: TelegramIcon, label: 'Telegram' },
			{ url: credit.artistFurAffinity, icon: FurAffinityIcon, label: 'FurAffinity' },
			{ url: credit.artistDeviantArt, icon: DeviantArtIcon, label: 'DeviantArt' },
			{ url: credit.artistPatreon, icon: PatreonIcon, label: 'Patreon' },
			{ url: credit.artistInstagram, icon: InstagramIcon, label: 'Instagram' }
		].filter((l) => l.url);
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
	{#if avatar.nsfw && !revealed}
		<!-- Mature gate covers the WHOLE main frame (poster or a selected media
		     item alike) until revealed — the strip thumbs blur under the same
		     condition and the 3D entry point stays hidden (VrViewer nsfw prop). -->
		<div class="nsfw-overlay">
			{#if avatar.posterUrl}
				<img
					src={responsiveSrc(avatar.posterUrl, POSTER)}
					srcset={responsiveSrcset(avatar.posterUrl, POSTER)}
					sizes={responsiveSizes(avatar.posterUrl, POSTER)}
					alt={avatar.name}
					width={avatar.posterWidth}
					height={avatar.posterHeight}
					fetchpriority="high"
					use:rawFallback={avatar.posterUrl}
					class="blurred"
				/>
			{:else}
				<div class="poster-placeholder"><Box size={40} aria-hidden="true" /></div>
			{/if}
			<button class="reveal-btn" onclick={reveal}>
				<span class="mature-label">{m.vr_mature_chip()}</span>
				<span>{m.vr_show_avatar()}</span>
			</button>
		</div>
	{:else if current}
		{#if current.kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -- muted on purpose: showcase
			     clips can't carry a captions track, so the player enforces
			     default-silent (matching the strip thumbs and the admin preview);
			     admin_vr_media_hint tells admins nothing important may live in
			     speech/audio, and the visible controls still allow unmuting. -->
			<video src={current.url} controls muted playsinline width={current.width} height={current.height}></video>
		{:else}
			<img src={cdnImage(current.url, 1200)} alt={avatar.name} width={current.width} height={current.height} use:rawFallback={current.url} />
		{/if}
	{:else if avatar.posterUrl}
		<img
			src={responsiveSrc(avatar.posterUrl, POSTER)}
			srcset={responsiveSrcset(avatar.posterUrl, POSTER)}
			sizes={responsiveSizes(avatar.posterUrl, POSTER)}
			alt={avatar.name}
			width={avatar.posterWidth}
			height={avatar.posterHeight}
			fetchpriority="high"
			use:rawFallback={avatar.posterUrl}
		/>
	{:else}
		<!-- Box glyph like the index grid's placeholder — a bare grey slab reads
		     as a broken image. -->
		<div class="poster-placeholder"><Box size={40} aria-hidden="true" /></div>
	{/if}
{/snippet}

<div class="container avatar-page">
	<nav class="breadcrumb" aria-label={m.vr_breadcrumb_label()}>
		<a href="/vr">{m.vr_title()}</a>
		<span>/</span>
		<span>{avatar.name}</span>
	</nav>

	<div class="avatar-layout">
		<div class="avatar-media">
			<!-- Always-mounted status region for the reveal announcement (a region
			     inserted with its first content is often not announced). -->
			<p class="sr-only" role="status">{revealAnnouncement}</p>
			{#if data.viewerPath}
				<!-- Keyed on the slug: a live 3D scene (or in-flight model download)
				     must not carry over to another avatar on client-side navigation —
				     remounting runs the viewer's teardown (abort + dispose). -->
				{#key avatar.slug}
					<VrViewer
						modelPath={data.viewerPath}
						modelSizeBytes={avatar.modelSizeBytes}
						name={avatar.name}
						nsfw={avatar.nsfw}
						{revealed}
						posterWidth={avatar.posterWidth}
						posterHeight={avatar.posterHeight}
						bind:active={viewerActive}
					>
						<!-- tabindex="-1": the reveal handler lands focus here after its
						     button unmounts — never a tab stop. -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div class="media-frame" tabindex="-1" bind:this={mediaFrame}>{@render mainMedia()}</div>
					</VrViewer>
				{/key}
			{:else}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="media-frame" tabindex="-1" bind:this={mediaFrame}>{@render mainMedia()}</div>
			{/if}

			{#if data.media.length > 0}
				<!-- Disabled while the 3D stage is up: selecting a thumb would have
				     no visible effect until Exit 3D (R2-D12). -->
				<div class="media-strip">
					<!-- Thumb buttons carry the accessible names: the video thumbs have
					     no text at all, and an image alt would double-announce. -->
					<button
						class="media-thumb"
						class:current={selected === null}
						aria-current={selected === null}
						aria-label={m.vr_media_poster()}
						disabled={viewerActive}
						onclick={() => (selected = null)}
					>
						{#if avatar.posterUrl}
							<img src={cdnImage(avatar.posterUrl, 200)} alt="" loading="lazy" class:blurred-thumb={avatar.nsfw && !revealed} use:rawFallback={avatar.posterUrl} />
						{/if}
					</button>
					{#each data.media as item, i}
						<button
							class="media-thumb"
							class:current={selected === i}
							aria-current={selected === i}
							aria-label={m.vr_media_item({ name: avatar.name, n: i + 1 })}
							disabled={viewerActive}
							onclick={() => (selected = i)}
						>
							{#if item.kind === 'video'}
								<video
									src={item.url}
									muted
									playsinline
									preload="none"
									class:blurred-thumb={avatar.nsfw && !revealed}
									use:videoThumb={i}
								></video>
								<!-- Static play glyph: the clip affordance must not depend on
								     metadata timing (DS1); the duration joins it when known. -->
								<span class="play-glyph" aria-hidden="true"><Play size={16} /></span>
								{#if durations[i] !== undefined}
									<span class="duration-badge">{formatDuration(durations[i])}</span>
								{/if}
							{:else}
								<img src={cdnImage(item.url, 200)} alt="" loading="lazy" class:blurred-thumb={avatar.nsfw && !revealed} use:rawFallback={item.url} />
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
				{#if data.viewerPath || avatar.modelSizeBytes}
					<span class="chip format-chip">{modelFormatLabel(avatar.modelFormat)} · {formatBytes(avatar.modelSizeBytes)}</span>
				{/if}
			</div>

			{#if data.credits.length > 0}
				<div class="meta-section">
					<h2>{m.vr_credits()}</h2>
					<ul class="credits">
						{#each data.credits as credit}
							<li class="credit-row">
								<a
									href="/gallery?artist={encodeURIComponent(credit.artistName)}"
									class="credit-artist"
									title={credit.artistName}
								>
									<ArtistAvatar name={credit.artistName} avatarUrl={credit.artistAvatar} size={24} cdn lazy />
									<span class="credit-name">{credit.artistName}</span>
								</a>
								{#if creditSocials(credit).length > 0}
									<span class="credit-socials">
										{#each creditSocials(credit) as link}
											<a
												href={link.url}
												target="_blank"
												rel="noopener"
												aria-label={m.common_social_link({ name: credit.artistName, platform: link.label })}
												class="social-icon"
											>
												<link.icon size={14} />
											</a>
										{/each}
									</span>
								{/if}
								<span class="role-chip">{creditRoleLabel(credit.role, credit.roleLabel)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if licenseLabel(avatar.license)}
				<div class="meta-section">
					<h2>{m.vr_license()}</h2>
					{#if avatar.license === 'cc-by'}
						<!-- CC BY 4.0 §3(a)(1)(C): reusers must be pointed at the license
						     text, so the badge links the deed wherever it renders —
						     display counts, not just download. -->
						<a
							href="https://creativecommons.org/licenses/by/4.0/"
							target="_blank"
							rel="license noopener"
							class="license-badge"
						>
							{licenseLabel(avatar.license)}
							<ExternalLink size={11} aria-hidden="true" />
							<span class="sr-only">{m.link_opens_new_tab()}</span>
						</a>
					{:else}
						<span class="license-badge">{licenseLabel(avatar.license)}</span>
					{/if}
				</div>
			{/if}

			{#if data.downloadAllowed}
				<div class="actions">
					<!-- aria-describedby ties the CC BY attribution terms to the action
					     they govern (R2-A12). -->
					<!-- One filled primary per view: beside "View in 3D" the download is
					     the outlined secondary; on viewer-less pages (FBX, or a model the
					     viewer can't render) it IS the view's primary and takes the fill. -->
					<a
						href="/vr/{avatar.slug}/download"
						class="btn {data.viewerPath ? 'btn-outline' : ''}"
						download
						aria-describedby={ccByAttribution ? 'ccby-attribution' : undefined}
					>
						<Download size={16} /> {m.vr_download_model()}
					</a>
				</div>
				{#if ccByAttribution}
					<p class="attribution-note" id="ccby-attribution">{ccByAttribution}</p>
				{/if}
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
		/* The sidebar yields below its ideal instead of outweighing the media
		   column in the 769–900px band (DS2): a percentage max actually shrinks
		   with the container, where the earlier minmax(300px, 380px) never left
		   its bounds in that band and was inert. min 0 on the media track so
		   long content can't force sideways scroll. */
		grid-template-columns: minmax(0, 1fr) minmax(260px, 32%);
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
		/* Cap the frame so a tall/square poster can't push the primary content
		   (title, credits, download) off the first viewport — a 1128px-tall
		   hero was measured at 1128px wide (DS3). contain keeps the full image
		   visible inside the cap. */
		max-height: min(70vh, 720px);
		object-fit: contain;
		display: block;
	}

	.media-frame:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}

	.poster-placeholder {
		/* Wide and capped: a posterless avatar renders an affordance, not a
		   full-height empty slab (DS4). max-height narrows the box below the
		   full column width, so centre it optically. */
		aspect-ratio: 16 / 9;
		max-height: 360px;
		margin-inline: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-foreground);
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

	/* Disabled while the 3D stage is active (R2-D12). */
	.media-thumb:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.media-thumb:disabled:hover {
		border-color: transparent;
	}

	.play-glyph {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
		pointer-events: none;
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
		/* Grid items default to min-width:auto — without 0 a long unbroken
		   avatar name overflows the 390px viewport sideways (R2-B3). */
		min-width: 0;
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
		/* --foreground, not --muted-foreground: muted on --secondary is 3.96:1
		   on the terracotta light theme (Ember light passes at 4.67:1 — see the
		   SONA-124 block in theme-contrast.test.ts). */
		color: var(--foreground);
	}

	.format-chip {
		font-family: var(--font-primary);
		font-variant-numeric: tabular-nums;
	}

	/* h2s (visually small labels): h1 → h3 would skip a heading level. */
	.meta-section h2 {
		font-size: 12px;
		font-weight: 600;
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
		gap: 8px 12px;
		/* min-width:0 lets the name column actually shrink — without it a long
		   name makes the whole page scroll sideways at 390px. */
		min-width: 0;
		/* Socials + chip wrap under the name instead of clipping at narrow widths. */
		flex-wrap: wrap;
	}

	/* Socials + chip group at the trailing edge, so the icons start at one
	   consistent x position instead of ragged per-row offsets. */
	.credit-row .credit-socials {
		margin-left: auto;
	}

	.credit-row:not(:has(.credit-socials)) .role-chip {
		margin-left: auto;
	}

	.credit-artist {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 500;
		color: inherit;
		text-decoration: none;
		/* A long artist name shrinks instead of pushing the socials/chip off the
		   row (title carries the full name). */
		flex: 0 1 auto;
		min-width: 0;
	}

	/* Truncation lives on a plain span, NOT the inline-flex anchor: text-overflow
	   can't ellipsize an anonymous flex item, which clipped mid-glyph at 1440. */
	.credit-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.credit-socials {
		display: flex;
		gap: 2px;
		flex: none;
	}

	.credit-socials .social-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-xs);
		color: var(--muted-foreground);
		transition: color 0.15s;
	}

	.credit-socials .social-icon:hover {
		color: var(--foreground);
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
		/* --foreground for AA contrast on --secondary (see .chip note). */
		color: var(--foreground);
		white-space: nowrap;
	}

	.license-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		color: var(--foreground);
	}

	a.license-badge {
		text-decoration: none;
		transition: border-color 0.15s;
	}

	a.license-badge:hover {
		border-color: var(--muted-foreground);
	}

	.actions {
		display: flex;
		gap: 12px;
	}

	/* CC BY attribution string kept with the download button (license terms). */
	.attribution-note {
		font-size: 12px;
		color: var(--muted-foreground);
		line-height: 1.5;
		margin-top: -8px;
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
