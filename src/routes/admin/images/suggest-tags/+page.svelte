<script lang="ts">
	// The tag backfill list (SONA-220): images that already have a Bluesky or X
	// source post but no tags.
	//
	// The two forms stage suggestions until their own Save. This page does not —
	// accepting a row writes that image's tags right away, which is why the row
	// action reads "Save N tags" rather than "Add", and why the saved row says
	// what landed instead of collapsing back to nothing.
	//
	// One row at a time: each row owns its own lookup, its own chips and its own
	// live region, so a slow or failed lookup on one image leaves the rest of the
	// page alone.
	import { enhance } from '$app/forms';
	import { Check, LoaderCircle, RefreshCw, Tag } from 'lucide-svelte';
	import TagSuggestionChips from '$lib/components/TagSuggestionChips.svelte';
	import {
		fromResponse,
		selectedTags,
		toggleTag,
		type SuggestionState
	} from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	// Keyed by image id so a row keeps its own suggestions while the operator
	// works down the list. Rows with no entry have not been asked about.
	let states = $state<Record<number, SuggestionState>>({});
	let saved = $state<Record<number, string[]>>({});
	let saving = $state<number | null>(null);
	// One live region for the list, written into rather than replaced.
	let announcement = $state('');
	// $state, not plain objects: bind:this writes into a property here, and Svelte
	// warns (and stops tracking) when the container it writes into is not reactive.
	let pills = $state<Record<number, HTMLButtonElement | null>>({});
	let statusLines = $state<Record<number, HTMLElement | null>>({});
	const requestSeq: Record<number, number> = {};

	const stateOf = (id: number): SuggestionState => states[id] ?? { kind: 'idle' };

	function readingLabel(kind: 'bluesky' | 'x') {
		return kind === 'bluesky'
			? m.admin_tag_suggest_reading_bluesky()
			: m.admin_tag_suggest_reading_x();
	}

	function sourceLabel(kind: 'bluesky' | 'x') {
		return kind === 'bluesky'
			? m.admin_suggest_tags_source_bluesky()
			: m.admin_suggest_tags_source_x();
	}

	function ratingLabel(rating: string | null) {
		return rating === 'explicit'
			? m.admin_tag_suggest_rated_explicit()
			: rating === 'questionable'
				? m.admin_tag_suggest_rated_questionable()
				: m.admin_tag_suggest_rated_safe();
	}

	function sentenceFor(next: SuggestionState): string {
		switch (next.kind) {
			case 'suggested':
				return m.admin_tag_suggest_eyebrow({ count: next.tags.length });
			case 'empty':
				return `${m.admin_tag_suggest_empty_title()} ${m.admin_tag_suggest_empty_body()}`;
			case 'notReady':
				return `${m.admin_tag_suggest_not_yet_title()} ${m.admin_tag_suggest_not_yet_body()}`;
			case 'rateLimited':
				return `${m.admin_tag_suggest_unavailable_title()} ${m.admin_tag_suggest_rate_limited_body()}`;
			case 'notFound':
				return `${m.admin_tag_suggest_unavailable_title()} ${m.admin_tag_suggest_not_found_body()}`;
			case 'unavailable':
				return `${m.admin_tag_suggest_unavailable_title()} ${m.admin_tag_suggest_unavailable_body()}`;
			default:
				return '';
		}
	}

	async function suggest(id: number, source: 'bluesky' | 'x') {
		if (stateOf(id).kind === 'searching') return;
		const seq = (requestSeq[id] = (requestSeq[id] ?? 0) + 1);
		states = { ...states, [id]: { kind: 'searching', source } };
		announcement = readingLabel(source);

		let status = 0;
		let body: unknown = null;
		try {
			const res = await fetch('/api/admin/tag-suggestions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageId: id })
			});
			status = res.status;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
		} catch {
			status = 0;
		}
		if (seq !== requestSeq[id]) return;

		// The row is on this page because it has no tags, so nothing is excluded.
		const next = fromResponse(status, body, []);
		states = { ...states, [id]: next };
		announcement = sentenceFor(next);
	}

	function onToggle(id: number, tag: string) {
		states = { ...states, [id]: toggleTag(stateOf(id), tag) };
	}

	function dismiss(id: number) {
		requestSeq[id] = (requestSeq[id] ?? 0) + 1;
		const { [id]: _dropped, ...rest } = states;
		states = rest;
		announcement = '';
		pills[id]?.focus();
	}
</script>

<div class="page-header">
	<h1>{m.admin_suggest_tags_title()}</h1>
</div>

<!-- Persistent live region for the list: written into, never inserted with
     text already inside. -->
<p class="sr-only" role="status">{announcement}</p>

{#if data.rows.length === 0}
	<div class="rowcard empty">
		<div class="rowhead">
			<Tag size={16} class="empty-icon" />
			<h2 class="rowtitle">{m.admin_suggest_tags_empty_title()}</h2>
		</div>
		<p class="rowmeta">{m.admin_suggest_tags_empty_body()}</p>
		<a class="btn btn-secondary self-start" href="/admin/images">{m.admin_suggest_tags_back()}</a>
	</div>
{:else}
	<p class="explainer">{m.admin_suggest_tags_explainer({ count: data.total })}</p>

	<ul class="rows">
		{#each data.rows as row (row.id)}
			{@const rowState = stateOf(row.id)}
			{@const chosen = selectedTags(rowState)}
			{@const savedTags = saved[row.id]}
			<li class="rowcard">
				<div class="rowhead">
					<div class="rowthumb">
						<!-- Empty alt: the heading beside it already names the image. -->
						<img src={row.thumbnailUrl || row.imageUrl} alt="" />
					</div>
					<div class="rowbody">
						<h2 class="rowtitle">
							{row.title}
							{#if savedTags}<span class="tag">{m.admin_suggest_tags_saved_tag()}</span>{/if}
						</h2>
						<p class="rowmeta">{row.artistName ?? ''} &middot; {sourceLabel(row.source)}</p>
					</div>
					{#if rowState.kind === 'idle' && !savedTags}
						<button
							bind:this={pills[row.id]}
							type="button"
							class="tag-pill"
							aria-label={m.admin_suggest_tags_row_suggest({ title: row.title })}
							onclick={() => suggest(row.id, row.source)}
						>
							<Tag size={14} />
							{m.admin_tag_suggest_button()}
						</button>
					{/if}
				</div>

				{#if savedTags}
					<p
						class="tag-status-line"
						tabindex="-1"
						bind:this={statusLines[row.id]}
					>
						<Check size={14} />
						{m.admin_suggest_tags_saved({ count: savedTags.length })}
					</p>
					<div class="tag-chiprow">
						{#each savedTags as tag (tag)}
							<span class="tag-chip tag-chip-static">{tag}</span>
						{/each}
					</div>
					<div class="tag-actions">
						<a
							class="tag-btn-text tag-btn-text-flush"
							href="/admin/images/{row.id}/edit"
							aria-label={m.admin_suggest_tags_edit_image_label({ title: row.title })}
						>
							{m.admin_suggest_tags_edit_image()}
						</a>
					</div>
				{:else if rowState.kind === 'searching'}
					<p class="tag-eyebrow">{readingLabel(rowState.source)}</p>
					<div class="tag-chiprow" aria-hidden="true">
						<span class="tag-skel-chip"></span>
						<span class="tag-skel-chip"></span>
						<span class="tag-skel-chip"></span>
						<span class="tag-skel-chip"></span>
						<span class="tag-skel-chip"></span>
					</div>
				{:else if rowState.kind === 'suggested'}
					<p class="tag-eyebrow" id="row-{row.id}-status">
						{m.admin_tag_suggest_eyebrow({ count: rowState.tags.length })}
					</p>
					<TagSuggestionChips
						tags={rowState.tags}
						leftOut={rowState.leftOut}
						labelledBy="row-{row.id}-status"
						describedBy="row-{row.id}-help"
						ontoggle={(tag) => onToggle(row.id, tag)}
					/>
					<p class="tag-panel-sub" id="row-{row.id}-help">{m.admin_tag_suggest_help()}</p>
					{#if rowState.rating}
						<p class="tag-rating-note" class:warn={rowState.rating !== 'safe'}>
							{ratingLabel(rowState.rating)}
						</p>
					{/if}
					<p class="rowmeta">{m.admin_suggest_tags_nsfw_note()}</p>
					{#if rowState.imageCount > 1}
						<p class="tag-panel-sub">
							{m.admin_tag_suggest_multi_image({ count: rowState.imageCount })}
						</p>
					{/if}
					<form
						method="POST"
						action="?/save"
						use:enhance={() => {
							saving = row.id;
							const accepted = chosen;
							return async ({ result }) => {
								saving = null;
								if (result.type !== 'success') {
									announcement = m.admin_suggest_tags_save_failed();
									return;
								}
								const written = (result.data?.savedTags as string[] | undefined) ?? accepted;
								saved = { ...saved, [row.id]: written };
								const { [row.id]: _dropped, ...rest } = states;
								states = rest;
								announcement = m.admin_suggest_tags_saved({ count: written.length });
								// The button that was clicked is gone with the tray;
								// land focus on the line that says what happened.
								statusLines[row.id]?.focus();
							};
						}}
						class="tag-actions"
					>
						<input type="hidden" name="id" value={row.id} />
						<input type="hidden" name="tags" value={chosen.join(', ')} />
						<button
							type="submit"
							class="btn btn-primary tag-btn-sm"
							disabled={chosen.length === 0 || saving === row.id}
							aria-label={m.admin_suggest_tags_row_save_label({
								count: chosen.length,
								title: row.title
							})}
						>
							{#if saving === row.id}<LoaderCircle size={14} />{/if}
							{m.admin_suggest_tags_row_save({ count: chosen.length })}
						</button>
						<button
							type="button"
							class="tag-btn-text"
							aria-label={m.admin_suggest_tags_row_dismiss({ title: row.title })}
							onclick={() => dismiss(row.id)}
						>
							{m.admin_tag_suggest_dismiss()}
						</button>
					</form>
				{:else if rowState.kind === 'empty'}
					<p class="tag-eyebrow">{m.admin_tag_suggest_empty_title()}</p>
					<p class="tag-panel-body">{m.admin_tag_suggest_empty_body()}</p>
					<div class="tag-actions">
						<button
							type="button"
							class="tag-btn-text tag-btn-text-flush"
							aria-label={m.admin_suggest_tags_row_dismiss({ title: row.title })}
							onclick={() => dismiss(row.id)}
						>
							{m.admin_tag_suggest_dismiss()}
						</button>
					</div>
				{:else if rowState.kind !== 'idle' && rowState.kind !== 'applied' && rowState.kind !== 'noSource'}
					<p class="tag-eyebrow warn">
						{rowState.kind === 'notReady'
							? m.admin_tag_suggest_not_yet_title()
							: m.admin_tag_suggest_unavailable_title()}
					</p>
					<p class="tag-panel-body">
						{#if rowState.kind === 'notReady'}{m.admin_tag_suggest_not_yet_body()}
						{:else if rowState.kind === 'rateLimited'}{m.admin_tag_suggest_rate_limited_body()}
						{:else if rowState.kind === 'notFound'}{m.admin_tag_suggest_not_found_body()}
						{:else}{m.admin_tag_suggest_unavailable_body()}{/if}
					</p>
					<div class="tag-actions">
						{#if rowState.kind !== 'notFound'}
							<button
								type="button"
								class="tag-pill"
								aria-label={m.admin_suggest_tags_row_suggest({ title: row.title })}
								onclick={() => suggest(row.id, row.source)}
							>
								<RefreshCw size={14} />
								{m.admin_tag_suggest_try_again()}
							</button>
						{/if}
						<button
							type="button"
							class="tag-btn-text"
							class:tag-btn-text-flush={rowState.kind === 'notFound'}
							aria-label={m.admin_suggest_tags_row_dismiss({ title: row.title })}
							onclick={() => dismiss(row.id)}
						>
							{m.admin_tag_suggest_dismiss()}
						</button>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if data.total > data.rows.length}
		<p class="hint">
			{m.admin_suggest_tags_showing({ shown: data.rows.length, total: data.total })}
		</p>
		<!-- A link, not a fetch: the next page of rows comes from the same load,
		     and the browser's back button then returns to the shorter list. The
		     rows already on screen keep their place because the page grows. -->
		<a class="tag-pill load-more" href="?pages={data.pages + 1}" data-sveltekit-noscroll>
			{m.admin_suggest_tags_load_more()}
		</a>
	{/if}
{/if}

<style>
	.page-header {
		margin-bottom: 24px;
	}

	h1 {
		font-size: 24px;
	}

	.explainer {
		max-width: 62ch;
		margin: -12px 0 20px;
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-width: 800px;
	}

	.rowcard {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.rowcard.empty {
		max-width: 800px;
	}

	.self-start {
		align-self: flex-start;
	}

	.rowhead {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.rowthumb {
		width: 56px;
		height: 56px;
		flex: none;
		overflow: hidden;
		border-radius: var(--radius-xs);
		background: var(--secondary);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
	}

	:global([data-theme='light']) .rowthumb {
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
	}

	.rowthumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.rowbody {
		flex: 1;
		min-width: 0;
	}

	.rowtitle {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: 0;
		font-size: 14px;
		font-weight: 500;
	}

	.rowmeta {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.hint {
		margin: 16px 0 8px;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.load-more {
		text-decoration: none;
	}

	@media (max-width: 640px) {
		.rowhead {
			flex-wrap: wrap;
		}

		.rowhead .tag-pill {
			width: 100%;
			justify-content: center;
		}
	}
</style>
