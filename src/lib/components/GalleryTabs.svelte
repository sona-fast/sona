<script lang="ts">
	import { page } from '$app/state';
	import { galleryTabs, type GallerySection, type GalleryTabsInput } from '$lib/gallery-tabs';
	import * as m from '$lib/paraglide/messages';

	let props: Omit<GalleryTabsInput, 'currentHref'> = $props();

	const labels: Record<GallerySection, () => string> = {
		artwork: m.gallery_view_artwork,
		fursuit: m.gallery_view_fursuit,
		stickers: m.gallery_view_stickers,
		vr: m.gallery_view_vr
	};

	const tabs = $derived(galleryTabs({ ...props, currentHref: page.url.pathname + page.url.search }));
</script>

<!-- One bar on /gallery, /stickers and /vr. Every tab is a link to its own
     page, so this is navigation rather than a tablist: the current tab carries
     aria-current="page", the way the site nav marks its links. Not rendered
     when only one tab would show (see galleryTabs).
     On /gallery, Artwork and Fursuit are two views of one page, so switching
     between them updates in place, the way updateFilter changes a filter: the
     data-sveltekit attributes keep the scroll position and focus, and replace
     the history entry instead of pushing one. Stickers and VR, and every tab on
     /stickers and /vr, go to another page and navigate normally. -->
{#if tabs.length}
	<div class="tabs-wrap">
		<nav class="tabs" aria-label={m.nav_gallery()}>
			{#each tabs as tab (tab.section)}
				<a
					href={tab.href}
					class="tab"
					class:active={tab.current}
					aria-current={tab.current ? 'page' : undefined}
					data-sveltekit-noscroll={tab.inPlace ? '' : undefined}
					data-sveltekit-keepfocus={tab.inPlace ? '' : undefined}
					data-sveltekit-replacestate={tab.inPlace ? '' : undefined}
				>
					{labels[tab.section]()}
				</a>
			{/each}
		</nav>
	</div>
{/if}

<style>
	/* Full width, so the container queries below can measure the room the bar
	   has. The labels' size is set here: the queries' em is this font size. */
	.tabs-wrap {
		container: gallery-tabs / inline-size;
		font-size: 14px;
	}

	/* Pill segmented control. Its --input boundary is the edge the gallery's
	   selects and view toggle also carry, so the row reads as one family of
	   controls (SONA-126). */
	.tabs {
		display: inline-flex;
		/* Where :has or container queries aren't supported, the tabs wrap rather
		   than run off the screen. Elsewhere the grid below takes over first. */
		flex-wrap: wrap;
		/* Used once a query below makes the bar a grid; a flex row ignores it. */
		grid-template-columns: 1fr 1fr;
		max-width: 100%;
		gap: 8px;
		margin-bottom: 24px;
		padding: 4px;
		border: 1px solid var(--input);
		border-radius: var(--radius-pill);
		background: var(--secondary);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		font-family: var(--font-secondary);
		font-weight: 500;
		white-space: nowrap;
		color: var(--muted-foreground);
		transition: color 0.15s, background 0.15s;
		text-decoration: none;
	}

	.tab:hover {
		color: var(--foreground);
		text-decoration: none;
	}

	.tab.active {
		color: var(--foreground);
		background: var(--background);
		box-shadow: 0 1px 3.5px rgba(0, 0, 0, 0.06);
	}

	/* Too narrow for the tabs in one row: an even two-column grid at full
	   width, so no label breaks and no tab hangs alone at the end of a short
	   row. With three tabs the last one spans the second row. Each threshold
	   is the widest set of that many labels, Japanese or English, on one row
	   (about 29.4em for four, 22.7em for three, 15.3em for two), plus a
	   little room. */
	@container gallery-tabs (max-width: 30.5em) {
		.tabs:has(> .tab:nth-child(4)) {
			display: grid;
			gap: 4px;
			border-radius: 20px;
		}
	}

	@container gallery-tabs (max-width: 23em) {
		.tabs:has(> .tab:nth-child(3)) {
			display: grid;
			gap: 4px;
			border-radius: 20px;
		}

		.tab:nth-child(3):last-child {
			grid-column: 1 / -1;
		}
	}

	/* Two tabs. */
	@container gallery-tabs (max-width: 16em) {
		.tabs {
			display: grid;
			gap: 4px;
			border-radius: 20px;
		}
	}

	/* Text too large for two columns of the widest label (Fursuit Photos,
	   about 8.5em, so 18em for the pair), as with text-only zoom: one column.
	   In em, so it follows the text size. Two tabs stack here below 16em. */
	@container gallery-tabs (max-width: 18.5em) {
		.tabs {
			grid-template-columns: 1fr;
		}
	}
</style>
