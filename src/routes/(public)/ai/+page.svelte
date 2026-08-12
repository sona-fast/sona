<script lang="ts">
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import { defaultAiDisclosure } from '$lib/ai-disclosure';
	import { splitParagraphs } from '$lib/legal';
	import { formatDate } from '$lib';
	import * as m from '$lib/paraglide/messages';

	// `settings` (siteName) comes from the (public) layout load; the toggle gate
	// AND the override text live in this route's +page.server.ts (the text rides
	// only this page's payload, not every public page). Mirrors the /privacy
	// override pattern: a non-empty owner override (plain text, blank-line
	// paragraphs) replaces the default disclosure copy wholesale.
	let { data } = $props();
	let settings = $derived(data.settings);
	const disclosure = defaultAiDisclosure();
	let override = $derived(data.aiPageText);

	// "Last updated" only for owner overrides, from the save stamp (the
	// LegalPage idiom). The default copy shows no date — it has no per-release
	// date constant of its own.
	let updatedAt = $derived(override.trim() ? data.aiPageUpdatedAt : '');

	// Meta description: cut at a word boundary, ellipsis only when truncated.
	let description = $derived.by(() => {
		const text = override.trim() || disclosure.intro;
		if (text.length <= 200) return text;
		const cut = text.slice(0, 200);
		const lastSpace = cut.lastIndexOf(' ');
		return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
	});
</script>

<Meta
	title={m.ai_meta_title({ siteName: settings.siteName })}
	{description}
	url={`${page.url.origin}${page.url.pathname}`}
	siteName={settings.siteName}
/>

<div class="container ai-page">
	<h1>{m.ai_page_title()}</h1>
	{#if updatedAt}
		<p class="ai-updated">{m.legal_last_updated({ date: formatDate(updatedAt) })}</p>
	{/if}

	{#if override.trim()}
		<!-- Auto-escaped plain text split into paragraphs on blank lines, exactly
		     like the LegalPage override path (CRLF normalized first). -->
		{#each splitParagraphs(override) as paragraph}
			<p class="ai-override">{paragraph}</p>
		{/each}
	{:else}
		<p class="intro">{disclosure.intro}</p>
		{#each disclosure.topics as topic}
			<!-- Real headings for the a11y outline; CSS runs each one into its body
			     text so the approved bold-mono lead-in look is unchanged. -->
			<section class="topic">
				<h2 class="lead">{topic.lead}</h2>
				<p>{topic.body}</p>
			</section>
		{/each}
		<p class="closer">{disclosure.closer}</p>
	{/if}
</div>

<style>
	.ai-page {
		max-width: 720px;
		padding-top: 32px;
		padding-bottom: 64px;
	}

	.ai-page h1 {
		margin-bottom: 14px;
	}

	.ai-updated {
		color: var(--muted-foreground);
		font-size: 0.875rem;
		margin-bottom: 24px;
	}

	.intro {
		font-size: 1.05rem;
		line-height: 1.75;
		margin-bottom: 26px;
	}

	.ai-page p {
		color: var(--foreground);
		line-height: 1.7;
		margin-bottom: 16px;
		text-wrap: pretty;
	}

	.topic {
		line-height: 1.7;
		margin-bottom: 16px;
		text-wrap: pretty;
	}

	/* Run-in effect: heading and body render as one flowing paragraph, keeping
	   the approved inline bold-mono lead-in while the outline gets real h2s. */
	.topic .lead,
	.topic p {
		display: inline;
	}

	.topic .lead {
		font-family: var(--font-primary);
		font-size: 0.95em;
		font-weight: 700;
		color: var(--foreground);
	}

	.closer {
		margin-top: 26px;
		color: var(--muted-foreground);
	}

	.ai-override {
		white-space: pre-wrap;
	}
</style>
