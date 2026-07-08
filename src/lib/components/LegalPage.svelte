<script lang="ts">
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import type { LegalSection } from '$lib/legal';

	let {
		title,
		metaTitle,
		siteName,
		/** Owner override (plain text). When non-empty, replaces the sections. */
		override,
		sections
	}: {
		title: string;
		metaTitle: string;
		siteName: string;
		override: string;
		sections: LegalSection[];
	} = $props();

	// Meta description: first paragraph of the override, else the first default
	// section's first paragraph. Trimmed to a sane length for social cards.
	let description = $derived(
		(override.trim() || sections[0]?.body[0]).slice(0, 200)
	);
</script>

<Meta title={metaTitle} description={description} url={`${page.url.origin}${page.url.pathname}`} {siteName} />

<div class="container legal-page">
	<h1>{title}</h1>

	{#if override.trim()}
		<!-- Auto-escaped plain text split into paragraphs on blank lines; single
		     newlines within a paragraph are preserved via CSS (no {@html}). -->
		{#each override.trim().split(/\n{2,}/) as paragraph}
			<p class="legal-override">{paragraph}</p>
		{/each}
	{:else}
		{#each sections as section}
			<section>
				<h2>{section.heading}</h2>
				{#each section.body as paragraph}
					<p>{paragraph}</p>
				{/each}
			</section>
		{/each}
	{/if}
</div>

<style>
	.legal-page {
		max-width: 720px;
		padding-top: 32px;
		padding-bottom: 64px;
	}

	.legal-page h1 {
		margin-bottom: 24px;
	}

	.legal-page section {
		margin-bottom: 28px;
	}

	.legal-page h2 {
		font-size: 1.25rem;
		margin-bottom: 10px;
	}

	.legal-page p {
		color: var(--foreground);
		line-height: 1.7;
		margin-bottom: 10px;
	}

	.legal-override {
		white-space: pre-wrap;
	}
</style>
