<script lang="ts">
	import { Camera, ArrowRight, ShieldCheck } from 'lucide-svelte';
	import type { FursuitPhoto } from '$lib/furtrack/types';
	import * as m from '$lib/paraglide/messages';
	import { licenseTerms } from '$lib/furtrack/license-terms';

	let { photo }: { photo: FursuitPhoto } = $props();
</script>

<!--
  The card links to the internal detail page; the detail page (and the explicit
  link below) point out to FurTrack. Image uses object-fit: contain (never
  cropped) so ND-licensed photos are shown unmodified — cropping counts as an edit.
-->
<a class="card" href="/gallery/fursuit/{photo.id}">
	<div class="image-wrapper">
		<img src={photo.imageUrl} alt={m.fursuit_card_alt({ photographer: photo.photographer })} loading="lazy" />
	</div>
	<div class="card-body">
		<p class="photographer">
			<Camera size={14} aria-hidden="true" />
			<span>{m.fursuit_card_by({ photographer: photo.photographer })}</span>
		</p>
		<div class="chips">
			{#if photo.event}
				<span class="chip event">{photo.event}</span>
			{/if}
			<span class="chip license" title={licenseTerms(photo.license)}>
				<ShieldCheck size={12} aria-hidden="true" />
				{photo.license.label}
			</span>
			{#if photo.permissionSource}
				<span class="chip permission" title={m.fursuit_permission_source({ source: photo.permissionSource })}>
					<ShieldCheck size={12} aria-hidden="true" />
					{m.fursuit_permission_badge()}
				</span>
			{/if}
		</div>
		<span class="furtrack-link">
			{m.fursuit_card_view_details()}
			<ArrowRight size={12} aria-hidden="true" />
		</span>
	</div>
</a>

<style>
	.card {
		display: flex;
		flex-direction: column;
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

	.image-wrapper {
		aspect-ratio: 1;
		overflow: hidden;
		background: var(--secondary);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	img {
		width: 100%;
		height: 100%;
		/* contain, not cover: never crop the photographer's image (respects ND) */
		object-fit: contain;
	}

	.card-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
	}

	.photographer {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.15rem 0.5rem;
		border-radius: var(--radius-s);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.chip.event {
		background: var(--secondary);
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
	}

	.chip.license {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--muted-foreground);
		cursor: help;
	}

	.chip.permission {
		background: transparent;
		border: 1px solid var(--primary);
		color: var(--primary);
		cursor: help;
	}

	.furtrack-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.card:hover .furtrack-link {
		color: var(--primary, var(--foreground));
	}
</style>
