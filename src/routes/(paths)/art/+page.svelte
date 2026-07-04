<script lang="ts">
	import { page } from '$app/state';
	import { Image as ImageIcon, Palette, CircleCheck, CircleAlert, ArrowRight } from 'lucide-svelte';
	import Callout from '$lib/components/Callout.svelte';
	import Meta from '$lib/components/Meta.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

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
		<a class="ref-sheet" href={`/gallery/${data.refSheet.slug}`}>
			<img src={data.refSheet.imageUrl} alt={data.refSheet.title} />
		</a>
		<p class="caption">
			{m.art_ref_caption()}
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
</style>
