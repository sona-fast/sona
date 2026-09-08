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
	import { tick } from 'svelte';
	import { Check, LoaderCircle, RefreshCw, Tag } from 'lucide-svelte';
	import TagSuggestionChips from '$lib/components/TagSuggestionChips.svelte';
	import { cdnImage, THUMB_WIDTH } from '$lib/img';
	import {
		fromResponse,
		ratingLabel,
		readingLabel,
		requestSuggestions,
		selectedTags,
		sentenceFor,
		toggleTag,
		type SuggestionState
	} from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	// Keyed by image id so a row keeps its own suggestions while the operator
	// works down the list. Rows with no entry have not been asked about.
	let states = $state<Record<number, SuggestionState>>({});
	let saved = $state<Record<number, string[]>>({});
	// Rows whose save was refused because the image picked up tags elsewhere
	// since the list loaded. The row keeps saying so until the page reloads.
	let conflicts = $state<Record<number, true>>({});
	// Every row with a save in flight, so a save landing on one row does not
	// re-enable another row's button mid-flight.
	let saving = $state(new Set<number>());
	// One live region for the list, written into rather than replaced.
	let announcement = $state('');
	// $state, not plain objects: bind:this writes into a property here, and Svelte
	// warns (and stops tracking) when the container it writes into is not reactive.
	let pills = $state<Record<number, HTMLButtonElement | null>>({});
	let statusLines = $state<Record<number, HTMLElement | null>>({});
	const requestSeq: Record<number, number> = {};

	const stateOf = (id: number): SuggestionState => states[id] ?? { kind: 'idle' };

	function sourceLabel(kind: 'bluesky' | 'x') {
		return kind === 'bluesky'
			? m.admin_suggest_tags_source_bluesky()
			: m.admin_suggest_tags_source_x();
	}

	async function suggest(id: number, source: 'bluesky' | 'x') {
		if (stateOf(id).kind === 'searching') return;
		const seq = (requestSeq[id] = (requestSeq[id] ?? 0) + 1);
		states = { ...states, [id]: { kind: 'searching', source } };
		announcement = readingLabel(source);
		// "Try again" lived in the tray that just became the searching skeleton;
		// the row's pill is the control that survives, so focus stays there.
		await tick();
		pills[id]?.focus();

		const { status, body } = await requestSuggestions({ imageId: id });
		if (seq !== requestSeq[id]) return;

		// The row is on this page because it has no tags, so nothing is excluded.
		const next = fromResponse(status, body, []);
		states = { ...states, [id]: next };
		announcement = sentenceFor(next);
	}

	function onToggle(id: number, tag: string) {
		states = { ...states, [id]: toggleTag(stateOf(id), tag) };
	}

	async function dismiss(id: number) {
		requestSeq[id] = (requestSeq[id] ?? 0) + 1;
		const { [id]: _dropped, ...rest } = states;
		states = rest;
		announcement = '';
		// The pill only renders once the row is idle again.
		await tick();
		pills[id]?.focus();
	}

	function setSaving(id: number, on: boolean) {
		const next = new Set(saving);
		if (on) next.add(id);
		else next.delete(id);
		saving = next;
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
		<p class="rowmeta empty-body">{m.admin_suggest_tags_empty_body()}</p>
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
						<img
							src={cdnImage(row.thumbnailUrl || row.imageUrl, THUMB_WIDTH)}
							alt=""
							loading="lazy"
							decoding="async"
						/>
					</div>
					<div class="rowbody">
						<h2 class="rowtitle">
							{row.title}
							{#if savedTags}<span class="tag">{m.admin_suggest_tags_saved_tag()}</span>{/if}
						</h2>
						<p class="rowmeta">
							{#if row.artistName}{row.artistName} &middot;{' '}{/if}{sourceLabel(row.source)}
						</p>
					</div>
					{#if !savedTags && !conflicts[row.id]}
						<!-- Stays put until the row is saved, like the forms' pill: aria-disabled
						     through the lookup so focus has somewhere to be while the tray shows
						     the skeleton, and a second click runs the lookup again. -->
						<button
							bind:this={pills[row.id]}
							type="button"
							class="tag-pill"
							aria-disabled={rowState.kind === 'searching'}
							aria-label={m.admin_suggest_tags_row_suggest({ title: row.title })}
							onclick={() => suggest(row.id, row.source)}
						>
							{#if rowState.kind === 'searching'}
								<LoaderCircle size={14} class="tag-spin" />
								{m.admin_tag_suggest_searching()}
							{:else}
								<Tag size={14} />
								{m.admin_tag_suggest_button()}
							{/if}
						</button>
					{/if}
				</div>

				{#if conflicts[row.id]}
					<!-- Focusable for the same reason as the saved line: the Save button
					     that was clicked is gone with the tray. -->
					<p class="tag-eyebrow warn" tabindex="-1" bind:this={statusLines[row.id]}>
						{m.admin_suggest_tags_save_conflict()}
					</p>
					<div class="tag-actions">
						<a
							class="tag-btn-text tag-btn-text-flush"
							href="/admin/images/{row.id}/edit"
							aria-label={m.admin_suggest_tags_edit_image_label({ title: row.title })}
						>
							{m.admin_suggest_tags_edit_image()}
						</a>
					</div>
				{:else if savedTags}
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
					<!-- One line: the rating and the note that it changes nothing here. -->
					<p class="rowmeta">
						{#if rowState.rating}<span class="tag-rating-note" class:warn={rowState.rating !== 'safe'}>{ratingLabel(rowState.rating)}</span>{' '}{/if}{m.admin_suggest_tags_nsfw_note()}
					</p>
					{#if rowState.imageCount > 1}
						<p class="tag-panel-sub">
							{m.admin_tag_suggest_multi_image({ count: rowState.imageCount })}
						</p>
					{/if}
					<form
						method="POST"
						action="?/save"
						use:enhance={() => {
							setSaving(row.id, true);
							const accepted = chosen;
							return async ({ result }) => {
								setSaving(row.id, false);
								const { [row.id]: _dropped, ...rest } = states;
								if (result.type === 'failure' && result.data?.error === 'tagged_elsewhere') {
									// Another tab or the edit form tagged this image since the
									// list loaded; the action refused rather than overwrite.
									conflicts = { ...conflicts, [row.id]: true };
									states = rest;
									announcement = m.admin_suggest_tags_save_conflict();
									await tick();
									statusLines[row.id]?.focus();
									return;
								}
								if (result.type !== 'success') {
									announcement = m.admin_suggest_tags_save_failed();
									return;
								}
								const written = (result.data?.savedTags as string[] | undefined) ?? accepted;
								saved = { ...saved, [row.id]: written };
								states = rest;
								announcement = m.admin_suggest_tags_saved({ count: written.length });
								// The button that was clicked is gone with the tray; land focus
								// on the line that says what happened, once it exists.
								await tick();
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
							disabled={chosen.length === 0 || saving.has(row.id)}
							aria-label={m.admin_suggest_tags_row_save_label({
								count: chosen.length,
								title: row.title
							})}
						>
							{#if saving.has(row.id)}<LoaderCircle size={14} class="tag-spin" />{/if}
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
								aria-label={m.admin_suggest_tags_row_try_again({ title: row.title })}
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

	/* Same measure as the explainer: the card is wider than a line should be. */
	.empty-body {
		max-width: 62ch;
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
