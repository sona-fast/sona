import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the #58 Treatment-B markup against the page source (same spirit as
// lcp-image.test.ts / reactivity-guard.test.ts): the Featured block replaces
// the recent-art section when featuredArt is non-empty, renders a hero + a
// supporting row through the CDN transform with a raw-URL fallback, and the
// existing recent-art section still renders in the {:else} branch untouched.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('art page Featured block markup (#58)', () => {
	it('branches on data.featuredArt.length, with recent art in the else branch', () => {
		const ifIdx = pageSrc.indexOf('{#if data.featuredArt.length > 0}');
		expect(ifIdx).toBeGreaterThan(-1);
		// The recent-art section (its label + grid) sits after this branch's else.
		const elseIdx = pageSrc.indexOf('{:else}', ifIdx);
		expect(elseIdx).toBeGreaterThan(ifIdx);
		expect(pageSrc.indexOf('m.art_existing()')).toBeGreaterThan(elseIdx);
		expect(pageSrc.indexOf('class="art-grid"')).toBeGreaterThan(elseIdx);
	});

	it('labels the section with a star and the Featured message', () => {
		expect(pageSrc).toContain('m.art_featured()');
		expect(pageSrc).toMatch(/<Star[^>]*\/>/);
	});

	it('routes hero and supporting tiles through one cdnImage+rawFallback snippet, hero at 1200 and supporting at 400', () => {
		// Hero and supporting tiles share a single {#snippet featuredTile(art, size, extra)}.
		expect(pageSrc).toContain('src={cdnImage(src, size)}');
		expect(pageSrc).toContain('use:rawFallback={src}');
		expect(pageSrc).toContain("{@render featuredTile(featuredHero, 1200, 'featured-hero')}");
		expect(pageSrc).toContain("{@render featuredTile(art, 400, '')}");
		// Never the untransformed original as a featured <img> src.
		expect(pageSrc).not.toContain('src={src}');
	});

	it('captions each tile with the title and the by-artist credit', () => {
		expect(pageSrc).toContain('m.art_featured_by({ artist: art.artistName })');
	});

	it('links tiles to the gallery detail page and keeps the full-gallery link', () => {
		expect(pageSrc).toContain('href={`/gallery/${art.slug}`}');
		expect(pageSrc).toContain('m.art_view_gallery()');
	});
});
