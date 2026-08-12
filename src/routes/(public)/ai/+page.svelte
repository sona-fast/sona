<script lang="ts">
	import { page } from '$app/state';
	import Meta from '$lib/components/Meta.svelte';
	import { defaultAiDisclosure } from '$lib/ai-disclosure';
	import * as m from '$lib/paraglide/messages';

	// `settings` comes from the (public) layout load; the toggle gate lives in
	// this route's +page.server.ts. Mirrors the /privacy override pattern: a
	// non-empty owner override (plain text, blank-line paragraphs) replaces the
	// default disclosure copy wholesale.
	let { data } = $props();
	let settings = $derived(data.settings);
	let disclosure = $derived(defaultAiDisclosure());
	let override = $derived(settings.aiPageText);

	let description = $derived((override.trim() || disclosure.intro).slice(0, 200));
</script>

<Meta
	title={m.ai_meta_title({ siteName: settings.siteName })}
	{description}
	url={`${page.url.origin}${page.url.pathname}`}
	siteName={settings.siteName}
/>

<div class="container ai-page">
	<h1>{m.ai_page_title()}</h1>

	{#if override.trim()}
		<!-- Auto-escaped plain text split into paragraphs on blank lines, exactly
		     like the LegalPage override path (CRLF normalized first). -->
		{#each override.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/) as paragraph}
			<p class="ai-override">{paragraph}</p>
		{/each}
	{:else}
		<p class="intro">{disclosure.intro}</p>
		{#each disclosure.topics as topic}
			<p><b>{topic.lead}</b> {topic.body}</p>
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

	.ai-page p b {
		font-family: var(--font-primary);
		font-size: 0.95em;
	}

	.closer {
		margin-top: 26px;
		color: var(--muted-foreground);
	}

	.ai-override {
		white-space: pre-wrap;
	}
</style>
