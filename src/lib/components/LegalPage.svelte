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
		(override.trim() || sections[0]?.body[0] || title).slice(0, 200)
	);
</script>

<Meta title={metaTitle} description={description} url={`${page.url.origin}${page.url.pathname}`} {siteName} />

<div class="container legal-page">
	<h1>{title}</h1>

	{#if override.trim()}
		<!-- Auto-escaped plain text; whitespace preserved via CSS (no {@html}). -->
		<p class="legal-override">{override}</p>
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
		font-size: 1.15rem;
		margin-bottom: 10px;
	}

	.legal-page p {
		color: var(--muted-foreground);
		line-height: 1.7;
		margin-bottom: 10px;
	}

	.legal-override {
		white-space: pre-wrap;
	}
</style>
