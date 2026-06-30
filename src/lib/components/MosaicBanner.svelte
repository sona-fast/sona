<script lang="ts">
	import { cdnImage } from '$lib';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		images: string[];
		subtitle: string;
		siteName?: string;
	}

	let { images, subtitle, siteName }: Props = $props();

	// Row configs matching the mockup: varied widths per slot, different row heights
	const rowConfigs = [
		{ height: 185, padLeft: 0, widths: [340, 180, 280, 220, 310, 190, 300, 250] },
		{ height: 130, padLeft: 80, widths: [260, 350, 200, 290, 170, 320, 240, 280] },
		{ height: 170, padLeft: 0, widths: [200, 330, 240, 370, 190, 310, 260] },
		{ height: 145, padLeft: 120, widths: [300, 210, 350, 180, 290, 230, 320] }
	];

	// Distribute images across slots, alternating direction per row
	let slots = $derived.by(() => {
		if (images.length === 0) return rowConfigs.map(() => []);

		const result: string[][] = [];
		let imgIdx = 0;

		for (let r = 0; r < rowConfigs.length; r++) {
			const row: string[] = [];
			// Offset each row's starting image to avoid repeating patterns
			const rowOffset = r * 3;
			for (let s = 0; s < rowConfigs[r].widths.length; s++) {
				row.push(images[(imgIdx + rowOffset) % images.length]);
				imgIdx++;
			}
			// Reverse odd rows for alternating direction
			if (r % 2 === 1) row.reverse();
			result.push(row);
		}
		return result;
	});
</script>

<section class="mosaic-banner">
	<div class="mosaic-tilt">
		{#each rowConfigs as row, rowIdx}
			<div
				class="mosaic-row"
				style="height: {row.height}px; padding-left: {row.padLeft}px;"
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

	.mosaic-tilt {
		position: absolute;
		top: -40px;
		left: -60px;
		width: 1700px;
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
		background: linear-gradient(to bottom, transparent 0%, rgba(0, 0, 0, 0.8) 100%);
	}

	.site-name {
		font-family: var(--font-primary);
		font-size: 48px;
		font-weight: 700;
		color: #FFFFFF;
		margin-bottom: 0;
	}

	.hero-tagline {
		font-family: var(--font-secondary);
		font-size: 16px;
		color: rgba(255, 255, 255, 0.67);
		max-width: 500px;
	}

	@media (max-width: 768px) {
		.mosaic-banner {
			height: 360px;
		}

		.mosaic-tilt {
			width: 1000px;
			top: -20px;
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
