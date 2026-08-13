<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { Image as ImageIcon, Palette, CircleCheck, CircleAlert, ArrowRight, Star } from 'lucide-svelte';
	import Callout from '$lib/components/Callout.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import { cdnImage, rawFallback } from '$lib';
	import { refSheetSrc, refSheetSrcset, refSheetSizes } from './ref-sheet-image';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	type FeaturedItem = (typeof data.featuredArt)[number];

	// Only rows the admin actually filled in — a fresh fork has none.
	const details = $derived(
		[
			{ label: m.art_species(), value: data.sona.species },
			{ label: m.art_build(), value: data.sona.build },
			{ label: m.art_features(), value: data.sona.keyFeatures }
		].filter((d) => d.value)
	);

	// Pad to 3 slots so the existing-art grid keeps its shape when sparse.
	const artSlots = $derived([...data.recentArt, null, null, null].slice(0, 3));

	// Featured (#58): the first curated image is the hero, the rest the supporting row.
	const featuredHero = $derived(data.featuredArt[0] ?? null);
	const featuredRest = $derived(data.featuredArt.slice(1));

	// SONA-18: an operator may designate (or tag) an NSFW image as the ref sheet.
	// The designation is honored, but the image renders behind the same
	// blur-and-reveal shield as the gallery hero. Shielded, the frame is the
	// reveal button rather than a link — nesting a button inside the
	// gallery <a> would leave two competing targets on one image.
	let revealed = $state(false);
	let revealAnnouncement = $state('');
	// The button unmounts itself on reveal: announce the change and land focus on
	// the now-linked ref sheet instead of dropping it to <body>.
	let revealedRef = $state<HTMLAnchorElement>();
	async function reveal() {
		revealed = true;
		revealAnnouncement = m.mature_revealed();
		await tick();
		revealedRef?.focus();
	}
</script>

<Meta
	title={`${m.art_details()} — ${data.settings.siteName}`}
	description={[data.sona.species, data.sona.keyFeatures].filter(Boolean).join(' · ') ||
		data.settings.aboutText}
	url={`${page.url.origin}/art`}
	image={data.refSheet?.imageUrl || null}
	siteName={data.settings.siteName}
/>

<section class="section">
	<h2 class="section-label">{m.art_ref_sheet()}</h2>
	{#if data.refSheet}
		<!-- Always-mounted status region: a live region inserted together with its
		     first content is often not announced. -->
		<p class="sr-only" role="status">{revealAnnouncement}</p>
		<!-- Both branches render the same LCP contract on the <img>: transform it
		     (not the raw multi-MB original), reserve its box with intrinsic
		     width/height, and prioritize its fetch. rawFallback swaps in the
		     original if the transform 403s off-zone. -->
		{#if data.refSheet.nsfw && !revealed}
			<div class="ref-sheet shielded">
				<img
					src={refSheetSrc(data.refSheet.imageUrl)}
					srcset={refSheetSrcset(data.refSheet.imageUrl)}
					sizes={refSheetSizes(data.refSheet.imageUrl)}
					use:rawFallback={data.refSheet.imageUrl}
					alt={data.refSheet.title}
					width={data.refSheet.width}
					height={data.refSheet.height}
					fetchpriority="high"
					decoding="async"
					class="blurred"
				/>
				<button class="reveal-btn" onclick={reveal}>
					<span class="nsfw-label">{m.gallery_nsfw_content()}</span>
					<span>{m.gallery_click_reveal()}</span>
				</button>
			</div>
		{:else}
			<a class="ref-sheet" href={`/gallery/${data.refSheet.slug}`} bind:this={revealedRef}>
				<img
					src={refSheetSrc(data.refSheet.imageUrl)}
					srcset={refSheetSrcset(data.refSheet.imageUrl)}
					sizes={refSheetSizes(data.refSheet.imageUrl)}
					use:rawFallback={data.refSheet.imageUrl}
					alt={data.refSheet.title}
					width={data.refSheet.width}
					height={data.refSheet.height}
					fetchpriority="high"
					decoding="async"
				/>
			</a>
		{/if}
		<!-- The first caption sentence carries the separator (a trailing space in en,
		     nothing in ja, which takes none after 。), so the markup emits no
		     whitespace of its own. Keeping the separator in the text means it
		     survives into the accessibility tree and the clipboard, which a CSS
		     margin would not; keeping it on the FIRST sentence keeps it out of the
		     link text below, where it would sit under the underline.

		     Shielded, the frame is a button rather than the gallery link, so that
		     sentence is a real link — the only route onward, and the only one that
		     works without JS, where the reveal button does nothing. It says "open in
		     the gallery" because that page shields the same image again. -->
		<p class="caption">
			{m.art_ref_caption()}{#if data.refSheet.nsfw && !revealed}<a href={`/gallery/${data.refSheet.slug}`}>{m.art_ref_open_gallery()}</a>{:else}{m.art_ref_view_full()}{/if}
			{#if data.refSheet.artistName}
				<span class="credit"> · {m.art_ref_by({ artist: data.refSheet.artistName })}</span>
			{/if}
		</p>
	{:else}
		<div class="ref-sheet placeholder"><ImageIcon size={32} /></div>
	{/if}
</section>

<hr class="divider" />

{#if details.length || data.sona.colors.length}
	<section class="section">
		<h2 class="section-label">{m.art_details()}</h2>
		<div class="panel details">
			{#each details as d}
				<div class="detail-row">
					<span class="detail-label">{d.label}</span>
					<span class="detail-value">{d.value}</span>
				</div>
			{/each}
			{#if data.sona.colors.length}
				{#if details.length}
					<hr class="divider" />
				{/if}
				<div class="detail-row">
					<span class="detail-label">{m.art_colors()}</span>
					<span class="swatches">
						{#each data.sona.colors as c}
							<span class="swatch" style="background:{c.hex}" title={c.name}></span>
						{/each}
					</span>
				</div>
			{/if}
		</div>
	</section>

	<hr class="divider" />
{/if}

{#if data.sona.dos.length || data.sona.donts.length}
	<section class="section">
		<h2 class="section-label">{m.art_dos_donts()}</h2>
		{#if data.sona.dos.length}
			<Callout
				icon={CircleCheck}
				variant="success"
				title={m.art_dos_title()}
				text={data.sona.dos.join(' · ')}
			/>
		{/if}
		{#if data.sona.donts.length}
			<Callout
				icon={CircleAlert}
				variant="primary"
				title={m.art_donts_title()}
				text={data.sona.donts.join(' · ')}
			/>
		{/if}
	</section>

	<hr class="divider" />
{/if}

{#snippet featuredTile(art: FeaturedItem, size: number, extra: string)}
	{@const src = art.thumbnailUrl || art.imageUrl}
	<a class="tile {extra}" href={`/gallery/${art.slug}`}>
		<img src={cdnImage(src, size)} use:rawFallback={src} loading="lazy" alt={art.title} />
		<span class="tile-cap">
			{art.title}
			{#if art.artistName}
				<span class="tile-by">{m.art_featured_by({ artist: art.artistName })}</span>
			{/if}
		</span>
	</a>
{/snippet}

{#if data.featuredArt.length > 0}
	<section class="section">
		<div class="featured">
			<h2 class="section-label featured-label">
				<Star size={13} fill="currentColor" /> {m.art_featured()}
			</h2>
			{#if featuredHero}
				{@render featuredTile(featuredHero, 1200, 'featured-hero')}
			{/if}
			{#if featuredRest.length}
				<div class="featured-row">
					{#each featuredRest as art}
						{@render featuredTile(art, 400, '')}
					{/each}
				</div>
			{/if}
			<a class="gallery-link" href="/gallery">
				{m.art_view_gallery()}<ArrowRight size={14} />
			</a>
		</div>
	</section>
{:else}
	<section class="section">
		<h2 class="section-label">{m.art_existing()}</h2>
		<div class="art-grid">
			{#each artSlots as art}
				{#if art}
					<a class="art-thumb" href={`/gallery/${art.slug}`}>
						<img src={art.thumbnailUrl || art.imageUrl} alt={art.title} />
					</a>
				{:else}
					<div class="art-thumb placeholder"><Palette size={16} /></div>
				{/if}
			{/each}
		</div>
		<a class="gallery-link" href="/gallery">
			{m.art_view_gallery()}<ArrowRight size={14} />
		</a>
	</section>
{/if}

<style>
	.ref-sheet {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-height: 240px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--card);
		overflow: hidden;
	}

	.ref-sheet.placeholder {
		color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
	}

	/* NSFW shield (SONA-18) — same blur radius and overlay as the gallery hero. */
	.ref-sheet.shielded {
		position: relative;
	}

	/* Reveal moves focus here programmatically, where Safari's :focus-visible
	   heuristic is unreliable — draw the ring rather than trust the UA default.
	   Outset is safe: an element's own overflow does not clip its own outline. */
	a.ref-sheet:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.ref-sheet img.blurred {
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

	/* .ref-sheet clips overflow, so an outset ring on this inset:0 button survives
	   only as slivers — draw it inside the clip region instead. White rather than
	   --ring: the ring sits on the dark shield scrim over arbitrary artwork, where
	   --ring (tuned for page surfaces) measures ~1.7:1, under the 3:1 SC 1.4.11
	   wants. The dark outer stroke keeps it visible if the scrim ever lightens. */
	.reveal-btn:focus-visible {
		outline: 2px solid #fff;
		outline-offset: -4px;
		box-shadow: inset 0 0 0 6px rgba(0, 0, 0, 0.8);
	}

	.nsfw-label {
		font-weight: 600;
		font-size: 16px;
	}

	.ref-sheet img {
		width: 100%;
		height: auto;
		object-fit: contain;
	}

	.caption {
		font-family: var(--font-secondary);
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}

	/* --primary fails AA on small text in ember light (2.20:1); --status-attention
	   is the token that tracks it and passes 4.5:1 everywhere (SONA-162). */
	.caption a {
		color: var(--status-attention);
	}

	.details {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px;
	}

	.detail-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.detail-label {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 12px;
		letter-spacing: 1px;
		color: var(--muted-foreground);
		flex-shrink: 0;
	}

	.detail-value {
		font-family: var(--font-secondary);
		font-size: 13px;
		color: var(--foreground);
		text-align: right;
	}

	.swatches {
		display: flex;
		gap: 8px;
	}

	.swatch {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--foreground) 20%, transparent);
	}

	.art-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.art-thumb {
		display: flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		border-radius: 8px;
		background: var(--card);
		overflow: hidden;
	}

	.art-thumb.placeholder {
		color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
	}

	.art-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.gallery-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 12px;
		letter-spacing: 1px;
		color: var(--primary);
		text-decoration: none;
	}

	/* Featured (#58): a subtly primary-tinted frame that takes over the art
	   section when the operator has curated images. */
	.featured {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border-radius: var(--radius-m);
		border: 1px solid color-mix(in srgb, var(--primary) 50%, var(--border));
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--primary) 9%, transparent), transparent 70%),
			var(--card);
	}

	.featured-label {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0;
	}

	.featured-label :global(svg) {
		color: var(--primary);
	}

	.tile {
		position: relative;
		display: block;
		border-radius: var(--radius-s);
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
		background: var(--secondary);
		text-decoration: none;
		color: inherit;
	}

	.tile.featured-hero {
		aspect-ratio: 16 / 10;
	}

	.tile img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.tile-cap {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 16px 10px 9px;
		font-family: var(--font-secondary);
		font-size: 12px;
		line-height: 1.3;
		color: #fff;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
		background: linear-gradient(transparent, rgba(0, 0, 0, 0.85));
	}

	.tile-by {
		display: block;
		margin-top: 1px;
		font-size: 10.5px;
		color: rgba(255, 255, 255, 0.72);
	}

	.featured-row {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
	}

	.featured-row .tile {
		aspect-ratio: 1;
	}

	/* A lone or odd trailing tile spans both columns as a short banner so the
	   2-col row never leaves a conspicuous empty cell. */
	.featured-row .tile:last-child:nth-child(odd) {
		grid-column: 1 / -1;
		aspect-ratio: 2 / 1;
	}
</style>
