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
	import { applyAction, enhance } from '$app/forms';
	import { afterNavigate } from '$app/navigation';
	import { tick } from 'svelte';
	import { Check, ImageOff, LoaderCircle, LogIn, Pencil, RefreshCw, Tag } from 'lucide-svelte';
	import TagSuggestionChips from '$lib/components/TagSuggestionChips.svelte';
	import { cdnImage, THUMB_WIDTH } from '$lib/img';
	import { sanitizeTag } from '$lib/tags';
	import {
		fromResponse,
		ratingLabel,
		readingLabel,
		requestSuggestions,
		selectedTags,
		sentenceFor,
		toggleTag,
		trayFor,
		type SuggestionState
	} from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	// Keyed by image id so a row keeps its own suggestions while the operator
	// works down the list. Rows with no entry have not been asked about.
	let states = $state<Record<number, SuggestionState>>({});
	let saved = $state<Record<number, string[]>>({});
	// Rows whose thumbnail failed to load, so the card shows a placeholder rather
	// than the browser's broken-image glyph.
	let broken = $state<Record<number, true>>({});
	// Rows whose save was refused because the image picked up tags elsewhere
	// since the list loaded. The row keeps saying so until the page reloads.
	let conflicts = $state<Record<number, true>>({});
	// Rows whose save failed for any other reason — the image was deleted in
	// another tab, say. The live region alone leaves a sighted operator looking
	// at a row where nothing changed, so the row says so too.
	let failures = $state<Record<number, true>>({});
	// Every row with a save in flight, so a save landing on one row does not
	// re-enable another row's button mid-flight.
	let saving = $state(new Set<number>());
	// One live region for the list, written into rather than replaced.
	let announcement = $state('');
	// $state, not plain objects: bind:this writes into a property here, and Svelte
	// warns (and stops tracking) when the container it writes into is not reactive.
	let pills = $state<Record<number, HTMLButtonElement | null>>({});
	let statusLines = $state<Record<number, HTMLElement | null>>({});
	let rowTitles = $state<Record<number, HTMLElement | null>>({});
	const requestSeq: Record<number, number> = {};
	// The id of the last row on screen when Load more was clicked, so the row that
	// follows it can take focus once the longer list renders. An id rather than a
	// count: a row saved above it drops off the reloaded list, and a position would
	// then land focus one row too far down.
	let grewAfterId: number | null = null;

	const stateOf = (id: number): SuggestionState => states[id] ?? { kind: 'idle' };

	function sourceLabel(kind: 'bluesky' | 'x') {
		return kind === 'bluesky'
			? m.admin_suggest_tags_source_bluesky()
			: m.admin_suggest_tags_source_x();
	}

	/** One live region serves every row, so each sentence names its image. */
	function announce(title: string, body: string) {
		announcement = m.admin_suggest_tags_row_announce({ title, body });
	}

	async function suggest(id: number, source: 'bluesky' | 'x', title: string) {
		if (stateOf(id).kind === 'searching') return;
		// A lookup during a save would throw away the chips that save is writing,
		// and the save landing afterwards would have no tray to report into.
		if (saving.has(id)) return;
		const seq = (requestSeq[id] = (requestSeq[id] ?? 0) + 1);
		// A failed save leaves "Not saved" on the row. This lookup replaces what that
		// was about, so the eyebrow goes with it rather than sitting above fresh chips
		// as if they were the ones that would not save.
		setFailure(id, false);
		states = { ...states, [id]: { kind: 'searching', source } };
		announce(title, readingLabel(source));
		// "Try again" lived in the tray that just became the searching skeleton;
		// the row's pill is the control that survives, so focus stays there.
		await tick();
		pills[id]?.focus();

		const { status, body } = await requestSuggestions({ imageId: id });
		if (seq !== requestSeq[id]) return;

		// The row is on this page because it has no tags, so nothing is excluded.
		const next = fromResponse(status, body, []);
		states = { ...states, [id]: next };
		announce(title, sentenceFor(next));
		// An answer with no chips draws a tray, and the pill focus was sitting on
		// goes with it; land on the sentence that says why, where Try again is the
		// next tab stop.
		if (next.kind !== 'suggested') {
			await tick();
			statusLines[id]?.focus();
		}
	}

	function onToggle(id: number, tag: string) {
		states = { ...states, [id]: toggleTag(stateOf(id), tag) };
	}

	async function dismiss(id: number) {
		// Closing the tray under an in-flight save leaves the row with a heading and
		// nothing else once the save answers, so Dismiss waits for the answer.
		if (saving.has(id)) return;
		requestSeq[id] = (requestSeq[id] ?? 0) + 1;
		setFailure(id, false);
		const { [id]: _dropped, ...rest } = states;
		states = rest;
		announcement = '';
		// The pill only renders once the row is idle again.
		await tick();
		pills[id]?.focus();
	}

	/** Say a sentence the region may already be holding. Blanked first: a repeat
	 *  of the same sentence is not a change, and an unchanged region announces
	 *  nothing. The tick lets the emptying reach the DOM. */
	async function reannounce(title: string, body: string) {
		announcement = '';
		await tick();
		announce(title, body);
	}

	function setSaving(id: number, on: boolean) {
		const next = new Set(saving);
		if (on) next.add(id);
		else next.delete(id);
		saving = next;
	}

	function setFailure(id: number, on: boolean) {
		const { [id]: _dropped, ...rest } = failures;
		failures = on ? { ...rest, [id]: true } : rest;
	}

	// Load more is a link: the page grows, and the rows already on screen keep
	// their place. Focus would otherwise stay on a link that is now gone, which
	// drops it to the top of the document.
	afterNavigate(async () => {
		if (grewAfterId === null) return;
		const after = grewAfterId;
		grewAfterId = null;
		// After the longer list has rendered: `data` still holds the rows the page
		// arrived with while the callback runs.
		await tick();
		// The list grew under a click that leaves no visible confirmation of how far
		// it grew, so the region says what the hint says.
		announcement = m.admin_suggest_tags_showing({ shown: data.rows.length, total: data.total });
		const was = data.rows.findIndex((row) => row.id === after);
		// The row that followed the last one on screen — or the top of the list, if
		// that row has been saved off it since.
		const first = was === -1 ? data.rows[0] : data.rows[was + 1];
		if (first) rowTitles[first.id]?.focus();
	});
</script>

<div class="page-header">
	<h1>{m.admin_suggest_tags_title()}</h1>
</div>

<!-- Persistent live region for the list: written into, never inserted with
     text already inside. -->
<p class="sr-only" role="status">{announcement}</p>

<!-- The row's only action once it is saved or refused, so it takes the pill's
     shape rather than reading as muted body text. Both of those branches draw
     the same link. -->
{#snippet editLink(row: { id: number; title: string })}
	<a
		class="tag-pill tag-pill-action"
		href="/admin/images/{row.id}/edit"
		aria-label={m.admin_suggest_tags_edit_image_label({ title: row.title })}
	>
		<Pencil size={14} aria-hidden="true" />
		{m.admin_suggest_tags_edit_image()}
	</a>
{/snippet}

{#if data.rows.length === 0}
	<div class="rowcard empty">
		<div class="rowhead">
			<Tag size={20} class="empty-icon" aria-hidden="true" />
			<h2 class="emptytitle">{m.admin_suggest_tags_empty_title()}</h2>
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
						{#if broken[row.id]}
							<!-- A file that has gone from storage would otherwise show the
							     browser's broken-image glyph, which is louder than the row. -->
							<ImageOff size={18} class="thumb-fallback" aria-hidden="true" />
						{:else}
							<!-- Empty alt: the heading beside it already names the image. -->
							<img
								src={cdnImage(row.thumbnailUrl || row.imageUrl, THUMB_WIDTH)}
								alt=""
								loading="lazy"
								decoding="async"
								onerror={() => (broken = { ...broken, [row.id]: true })}
							/>
						{/if}
					</div>
					<div class="rowbody">
						<!-- Focusable so Load more can land focus on the first row it added,
						     rather than leaving it on a link that is gone. -->
						<h2 class="rowtitle" tabindex="-1" bind:this={rowTitles[row.id]}>
							{row.title}
						</h2>
						<p class="rowmeta">
							{#if row.artistName}{row.artistName} &middot;{' '}{/if}{sourceLabel(row.source)}
						</p>
					</div>
					{#if !savedTags && !conflicts[row.id] && !failures[row.id] && (rowState.kind === 'idle' || rowState.kind === 'searching' || rowState.kind === 'suggested')}
						<!-- Stays put while the row is idle, looking up, or showing chips, like
						     the forms' pill: aria-disabled through the lookup so focus has
						     somewhere to be while the tray shows the skeleton, and a second
						     click runs the lookup again. Aria-disabled through a save too,
						     where a fresh lookup would throw away the chips being saved. It
						     goes once a failure tray takes the
						     row over, because that tray carries Try again and one row does not
						     need two controls firing the same lookup — and for the same reason
						     while a save has failed, where Save is the retry and this pill would
						     throw the chips away instead. -->
						<button
							bind:this={pills[row.id]}
							type="button"
							class="tag-pill"
							aria-disabled={rowState.kind === 'searching' || saving.has(row.id)}
							aria-label={rowState.kind === 'searching'
								? m.admin_suggest_tags_row_searching({ title: row.title })
								: m.admin_suggest_tags_row_suggest({ title: row.title })}
							onclick={() => suggest(row.id, row.source, row.title)}
						>
							{#if rowState.kind === 'searching'}
								<LoaderCircle size={14} class="tag-spin" aria-hidden="true" />
								{m.admin_tag_suggest_searching()}
							{:else}
								<Tag size={14} aria-hidden="true" />
								{m.admin_tag_suggest_button()}
							{/if}
						</button>
					{/if}
				</div>

				{#if conflicts[row.id]}
					<!-- Split like the tray's failures: the eyebrow is a label, and a
					     whole sentence set in 11px uppercase is not readable as one. The
					     sentence is focusable for the same reason as the saved line — the
					     Save button that was clicked is gone with the tray. -->
					<p class="tag-eyebrow warn">{m.admin_suggest_tags_not_saved()}</p>
					<p class="tag-panel-body" tabindex="-1" bind:this={statusLines[row.id]}>
						{m.admin_suggest_tags_save_conflict()}
					</p>
					<div class="tag-actions">
						{@render editLink(row)}
					</div>
				{:else if savedTags}
					<p
						class="tag-status-line"
						tabindex="-1"
						bind:this={statusLines[row.id]}
					>
						<Check size={14} aria-hidden="true" />
						{m.admin_suggest_tags_saved({ count: savedTags.length })}
					</p>
					<div class="tag-chiprow">
						{#each savedTags as tag (tag)}
							<span class="tag-chip tag-chip-static">{tag}</span>
						{/each}
					</div>
					<div class="tag-actions">
						{@render editLink(row)}
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
					{#if failures[row.id]}
						<!-- Split like the conflict above: the eyebrow is a label, the
						     sentence is body text. The chips stay put, so the Save button
						     below is still the way to try again. -->
						<p class="tag-eyebrow warn">{m.admin_suggest_tags_not_saved()}</p>
						<p class="tag-panel-body" tabindex="-1" bind:this={statusLines[row.id]}>
							{m.admin_suggest_tags_save_failed()}
						</p>
					{/if}
					<form
						method="POST"
						action="?/save"
						use:enhance={({ cancel, formElement }) => {
							// The buttons are aria-disabled rather than disabled, so a click
							// still reaches the form. Refuse it here: a second save while one
							// is in flight, and a save with nothing picked, both do nothing.
							if (saving.has(row.id) || chosen.length === 0) {
								cancel();
								// A save refused for having nothing picked is otherwise silent:
								// the button stays where it was and the row does not move. Say
								// what to do first. A refusal during a save says nothing — the
								// region already holds the Saving sentence.
								if (chosen.length === 0 && !saving.has(row.id))
									reannounce(row.title, m.admin_suggest_tags_save_needs_tag());
								return;
							}
							// The label narrows from "Save 3 tags" to "Saving" for the round
							// trip, and a narrower button pulls Dismiss left out from under the
							// pointer that just pressed Save. Hold the width the resting label
							// gave it — measured rather than guessed, since the widest label
							// differs by locale and by count.
							const button = formElement.querySelector('button[type="submit"]');
							if (button instanceof HTMLElement) button.style.minWidth = `${button.offsetWidth}px`;
							setSaving(row.id, true);
							setFailure(row.id, false);
							const accepted = chosen;
							// The round trip can run long enough that a screen reader is left
							// on the sentence the row said before it, so the region says the
							// save is running.
							announce(row.title, m.admin_suggest_tags_saving({ count: chosen.length }));
							return async ({ result }) => {
								setSaving(row.id, false);
								// The resting label is back, so the button sizes itself again.
								if (button instanceof HTMLElement) button.style.minWidth = '';
								const { [row.id]: _dropped, ...rest } = states;
								if (result.type === 'failure' && result.data?.error === 'tagged_elsewhere') {
									// Another tab or the edit form tagged this image since the
									// list loaded; the action refused rather than overwrite.
									conflicts = { ...conflicts, [row.id]: true };
									states = rest;
									announce(row.title, m.admin_suggest_tags_save_conflict());
									await tick();
									statusLines[row.id]?.focus();
									return;
								}
								if (
									result.type === 'redirect' ||
									(result.type === 'error' && typeof result.status === 'number')
								) {
									// An expired session redirects to the login page and an error
									// the server answered with has its own page; "Couldn't save
									// those tags" would strand the operator on a list that cannot
									// save anything. A status-less error is enhance reporting a
									// fetch that never landed — offline, or a dropped connection —
									// and rendering the error page over the list for that would
									// throw away every row's staged chips, so it falls through to
									// the row failure below.
									await applyAction(result);
									return;
								}
								if (result.type !== 'success') {
									// The Not saved notice lives inside this row's suggestion tray.
									// If the row left that state while the save was in flight, there
									// is nowhere to render the notice and nothing to focus, so the
									// row keeps whatever it moved on to.
									if (stateOf(row.id).kind !== 'suggested') return;
									// The chips stay, so the same save can be tried again — but
									// the row has to show that nothing landed, not only say it
									// into the live region.
									setFailure(row.id, true);
									await reannounce(row.title, m.admin_suggest_tags_save_failed());
									// The sentence that says what happened is where the operator
									// resumes, the way the sibling branches land focus.
									statusLines[row.id]?.focus();
									return;
								}
								const written = (result.data?.savedTags as string[] | undefined) ?? accepted;
								// The action answers with the sanitized names it stored; show the
								// labels the chips showed, matched the way the sanitizer matches.
								const labels = written.map(
									(name) => accepted.find((tag) => sanitizeTag(tag) === name) ?? name
								);
								saved = { ...saved, [row.id]: labels };
								states = rest;
								announce(row.title, m.admin_suggest_tags_saved({ count: written.length }));
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
						<!-- aria-disabled, not disabled, for the reason the row's pill is: a
						     real disabled attribute drops focus to the body for the whole
						     round trip, and the operator who clicked Save has nowhere to be
						     while it runs. The submit handler refuses the click instead. -->
						<button
							type="submit"
							class="btn btn-primary tag-btn-sm"
							aria-disabled={chosen.length === 0 || saving.has(row.id)}
							aria-label={saving.has(row.id)
								? m.admin_suggest_tags_row_saving_label({ title: row.title })
								: m.admin_suggest_tags_row_save_label({
										count: chosen.length,
										title: row.title
									})}
						>
							{#if saving.has(row.id)}
								<!-- The spinner alone says the row is working to anyone watching
								     it; the label has to say so too, and the count it was
								     offering is no longer what the button does. The live region
								     carries the sentence with the count. -->
								<LoaderCircle size={14} class="tag-spin" aria-hidden="true" />
								{m.admin_suggest_tags_row_saving_short()}
							{:else}
								{m.admin_suggest_tags_row_save({ count: chosen.length })}
							{/if}
						</button>
						<!-- Refused while the save runs, like Save beside it: closing the
						     tray mid-save leaves the row with a heading and nothing else once
						     the save answers. aria-disabled, so it stays reachable and says
						     why; dismiss() returns early while the row is saving. -->
						<button
							type="button"
							class="tag-btn-text"
							aria-disabled={saving.has(row.id)}
							aria-label={m.admin_suggest_tags_row_dismiss({ title: row.title })}
							onclick={() => dismiss(row.id)}
						>
							{m.admin_tag_suggest_dismiss()}
						</button>
					</form>
				{:else if rowState.kind !== 'idle'}
					<!-- Every finished state that is not a suggestion: the same tray the
					     forms draw, from the same mapping, so a row and a form say the
					     same thing about the same answer. -->
					{@const tray = trayFor(rowState)}
					<p class="tag-eyebrow" class:warn={tray.warn}>{tray.title}</p>
					<!-- Focusable for the same reason as the conflict sentence: the row's
					     pill is gone with this tray, so focus lands on the line that says
					     what the lookup answered. -->
					<p class="tag-panel-body" tabindex="-1" bind:this={statusLines[row.id]}>{tray.body}</p>
					<div class="tag-actions">
						{#if tray.retry}
							<button
								type="button"
								class="tag-pill"
								aria-label={m.admin_suggest_tags_row_try_again({ title: row.title })}
								onclick={() => suggest(row.id, row.source, row.title)}
							>
								<RefreshCw size={14} aria-hidden="true" />
								{m.admin_tag_suggest_try_again()}
							</button>
						{/if}
						{#if tray.signIn}
							<!-- A dead session: another lookup sends the same cookie, so the
							     way out is the login page. -->
							<a class="tag-pill" href="/admin/login">
								<LogIn size={14} aria-hidden="true" />
								{m.admin_tag_suggest_sign_in()}
							</a>
						{/if}
						<button
							type="button"
							class="tag-btn-text"
							class:tag-btn-text-flush={!tray.retry && !tray.signIn}
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
		<a
			class="tag-pill load-more"
			href="?pages={data.pages + 1}"
			data-sveltekit-noscroll
			onclick={() => (grewAfterId = data.rows[data.rows.length - 1]?.id ?? null)}
		>
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

	/* The page's only content when the list is empty, so it sits above a row
	   title without reaching the page heading. */
	.emptytitle {
		margin: 0;
		font-size: 18px;
		font-weight: 500;
	}

	/* lucide renders the class onto its own svg, which scoped CSS cannot see. */
	.rowcard.empty :global(.empty-icon) {
		color: var(--muted-foreground);
		flex: none;
	}

	/* Same measure as the explainer: the card is wider than a line should be. */
	.empty-body {
		max-width: 62ch;
	}

	/* The icon belongs beside the heading at every width — the shared .rowhead
	   wraps below 640px, which would drop it onto its own line. */
	.rowcard.empty .rowhead {
		flex-wrap: nowrap;
		align-items: flex-start;
	}

	/* One left edge for the card: the body and the button line up with the
	   heading's text rather than with the icon. 20px of icon plus the 12px head
	   gap. */
	.rowcard.empty > :not(.rowhead) {
		margin-left: 32px;
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

	.rowthumb {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-foreground);
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

	/* Everything the row expands into lines up with the title rather than with
	   the card's padding: 56px of thumbnail plus the 12px row gap. The empty card
	   has no thumbnail to clear. */
	.rowcard:not(.empty) > :not(.rowhead) {
		margin-left: 68px;
	}

	.load-more {
		text-decoration: none;
	}

	/* The saved row's action sits under a row of static chips it must not read as
	   part of. The card's 12px gap alone reads as chip spacing, so the action row
	   takes a little more air than the lines above it. */
	.tag-chiprow + .tag-actions {
		margin-top: 4px;
	}

	@media (max-width: 640px) {
		/* The head wraps here, so there is no thumbnail column to line up with. */
		.rowcard:not(.empty) > :not(.rowhead) {
			margin-left: 0;
		}

		.rowhead {
			flex-wrap: wrap;
		}

		.rowhead .tag-pill {
			width: 100%;
			justify-content: center;
		}
	}
</style>
