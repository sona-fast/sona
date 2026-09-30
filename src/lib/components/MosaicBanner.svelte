<script lang="ts">
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';
	import { mosaicLayout, mosaicSlots, SSR_BANNER_WIDTH } from '$lib/mosaic-layout';

	interface Props {
		images: string[];
		subtitle: string;
		siteName?: string;
	}

	let { images, subtitle, siteName }: Props = $props();

	// The server lays the strip out for SSR_BANNER_WIDTH and the stylesheet
	// draws that same geometry, which also covers every narrower banner. A
	// client whose banner measures wider re-lays the strip for its own size and
	// overrides the stylesheet inline; nothing else ever emits the inline
	// style, so the phone media query keeps its own numbers.
	let bannerWidth: number | undefined = $state();
	let bannerHeight: number | undefined = $state();
	let wide = $derived(bannerWidth !== undefined && bannerWidth > SSR_BANNER_WIDTH);
	let layout = $derived(wide ? mosaicLayout(bannerWidth, bannerHeight) : mosaicLayout());
	let slots = $derived(mosaicSlots(images, layout.rows));
</script>

<section class="mosaic-banner" bind:clientWidth={bannerWidth} bind:clientHeight={bannerHeight}>
	<div
		class="mosaic-tilt"
		style={wide ? `width: ${layout.stripWidth}px; top: ${layout.top}px; left: ${layout.left}px;` : undefined}
	>
		{#each layout.rows as row, rowIdx}
			<div
				class="mosaic-row"
				style="height: {row.height}px; margin-left: {row.marginLeft}px;"
			>
				{#each row.widths as width, colIdx}
					<div class="mosaic-cell" style="width: {width}px; min-width: {width}px;">
						{#if slots[rowIdx]?.[colIdx]}
							<img src={cdnImage(slots[rowIdx][colIdx], 800)} alt="" loading="lazy" />
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</div>

	<div class="hero-overlay">
		{#if siteName}
			<h1 class="site-name">{siteName}</h1>
		{/if}
		<p class="hero-tagline">{subtitle}</p>
		<a href="/gallery" class="btn btn-primary btn-lg">{m.browse_gallery()}</a>
	</div>
</section>

<style>
	.mosaic-banner {
		position: relative;
		width: 100%;
		height: 600px;
		overflow: hidden;
		background: var(--background);
	}

	/* The geometry mosaicLayout() produces for SSR_BANNER_WIDTH (1920): the
	   strip reaches 140px past that banner's right edge, and the top edge sits
	   high enough that the 3-degree tilt, which drops the strip's left end,
	   still keeps the top-left corner covered. Wider banners get these three
	   values inline from the component instead. */
	.mosaic-tilt {
		position: absolute;
		top: -60px;
		left: -60px;
		width: 2120px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		transform: rotate(-3deg);
		transform-origin: center center;
	}

	.mosaic-row {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.mosaic-cell {
		flex-shrink: 0;
		height: 100%;
		border-radius: 5px;
		overflow: hidden;
		background: var(--secondary);
	}

	.mosaic-cell img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.hero-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		align-items: center;
		text-align: center;
		padding: 48px;
		gap: 16px;
		/* The text band starts much higher than the old 78% plateau did: the site
		   name sits above the tagline and the Browse button, so with the real fonts
		   its top lands near 44% of the banner on a wide viewport and near 37% on a
		   phone with a two-line name over a three-line tagline. The scrim therefore
		   has to be dark by 40%, not by 78%. One continuous ramp from clear at 5%
		   to 0.80 at 48%, with no step in the middle: the old jump from 0.2 to 0.7
		   across ten percent of the height showed as a seam over pale artwork. The
		   ramp starts at 5% rather than 15% because a long site name wraps to two
		   lines on a phone and lands at 37.5%, where the old ramp was only 0.45
		   alpha and white read 3.36:1. These stops give 0.65 alpha at 40% and 0.80
		   from 48% down, so over the brightest possible artwork white measures
		   5.83:1 at the highest offset the text reaches and 12.63:1 at the lowest,
		   and the #D4D4D4 tagline 8.52:1 at worst.
		   theme-contrast.test.ts interpolates these stops at the offsets the layout
		   actually produces, so changing them moves the measured numbers. */
		background: linear-gradient(
			to bottom,
			transparent 5%,
			rgba(0, 0, 0, 0.8) 48%,
			rgba(0, 0, 0, 0.8) 100%
		);
	}

	/* Two lines at most, for the same reason the tagline clamps: the settings form
	   accepts a 100-character site name, which wraps to three or four lines on a
	   phone and lifts the heading into the light part of the scrim. Two lines is
	   what the contrast model in theme-contrast.test.ts measures, so the clamp is
	   what keeps its worst case the real worst case. */
	.site-name {
		font-family: var(--font-primary);
		font-size: 48px;
		font-weight: 700;
		color: #FFFFFF;
		margin-bottom: 0;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	/* Opaque, not white at 0.67 alpha: a translucent label composites with whatever
	   the visitor uploaded, so its contrast moved with the artwork under it. This
	   grey renders the same everywhere and lands close to what the old alpha looked
	   like over the scrim, while staying a step quieter than the white site name.
	   Not var(--foreground): the overlay is dark in every theme, and --foreground is
	   near-black in the light modes. */
	/* Three lines at most. The about text has no length limit, and every extra line
	   pushes the site name higher into the lighter part of the scrim; the full text
	   lives on /about. The contrast model in theme-contrast.test.ts measures up to
	   three lines, so the clamp is what keeps its worst case the real worst case. */
	.hero-tagline {
		font-family: var(--font-secondary);
		font-size: 16px;
		color: #D4D4D4;
		max-width: 500px;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
	}

	@media (max-width: 768px) {
		.mosaic-banner {
			height: 360px;
		}

		/* Five server-rendered rows make the strip taller than the four the
		   phone used to get, so its centre, and with it the tilt's drop at the
		   left end, moves down: -30px keeps the top-left corner covered. */
		.mosaic-tilt {
			width: 1000px;
			top: -30px;
			left: -100px;
		}

		.site-name {
			font-size: 28px;
		}

		.hero-tagline {
			font-size: 13px;
		}

		.hero-overlay {
			padding: 20px;
			gap: 10px;
		}
	}
</style>
