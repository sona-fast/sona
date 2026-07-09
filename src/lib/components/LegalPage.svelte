<script lang="ts">
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import { formatDate } from '$lib';
	import { legalUpdatedDate, type LegalSection } from '$lib/legal';
	import * as m from '$lib/paraglide/messages';

	let {
		title,
		metaTitle,
		siteName,
		/** Owner override (plain text). When non-empty, replaces the sections. */
		override,
		/** Date (YYYY-MM-DD) an override was last saved; '' when none is set. */
		legalUpdatedAt,
		sections
	}: {
		title: string;
		metaTitle: string;
		siteName: string;
		override: string;
		legalUpdatedAt: string;
		sections: LegalSection[];
	} = $props();

	// Meta description: first paragraph of the override, else the first default
	// section's first paragraph. Trimmed to a sane length for social cards.
	let description = $derived(
		(override.trim() || sections[0]?.body[0]).slice(0, 200)
	);

	// "Last updated" date from a stable source (the owner's save stamp, or the
	// per-release defaults date) — never `new Date()`, which would always be today.
	let updatedAt = $derived(legalUpdatedDate(override, legalUpdatedAt));
</script>

<Meta title={metaTitle} description={description} url={`${page.url.origin}${page.url.pathname}`} {siteName} />

<div class="container legal-page">
	<h1>{title}</h1>
	{#if updatedAt}
		<p class="legal-updated">{m.legal_last_updated({ date: formatDate(updatedAt) })}</p>
	{/if}

	{#if override.trim()}
		<!-- Auto-escaped plain text split into paragraphs on blank lines; single
		     newlines within a paragraph are preserved via CSS (no {@html}).
		     Normalize CRLF first — browsers submit <textarea> line breaks as \r\n,
		     so a blank line arrives as \r\n\r\n and would otherwise never split. -->
		{#each override.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/) as paragraph}
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
		margin-bottom: 6px;
	}

	.legal-updated {
		color: var(--muted-foreground);
		font-size: 0.875rem;
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
