<script lang="ts">
	// The Tags field with its "Suggest tags" control (SONA-220), on /admin/upload
	// and /admin/images/[id]/edit.
	//
	// The component renders the whole field — label, input, pill, hint, tray —
	// because the pill sits inside the input group beside the input and the tray
	// hangs off the group. The Tags value is bound out to the form, so the field
	// keeps working exactly as it did when the operator never touches the pill.
	//
	// Nothing here saves. Accepted tags are written into the Tags input and the
	// form's own Save is what persists them. The lookup is fail-soft in every
	// direction: a slow, rate-limited, or dead entail.dev leaves the field and
	// the form untouched.
	import { tick } from 'svelte';
	import { Check, LoaderCircle, RefreshCw, Tag } from 'lucide-svelte';
	import TagSuggestionChips from './TagSuggestionChips.svelte';
	import { classifySourceUrl } from '$lib/tags';
	import {
		applyTo,
		fromResponse,
		parseTagInput,
		readingLabel,
		requestSuggestions,
		selectedTags,
		sentenceFor,
		toggleTag,
		trayFor,
		type EntailRating,
		type SuggestionState
	} from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let {
		value = $bindable(''),
		sourceUrl = '',
		rating = $bindable(null),
		existingTags = [],
		placeholder = '',
		firstTileOnly = false
	}: {
		/** The Tags input's value, bound out to the form that submits it. */
		value: string;
		/** The Source Post URL field's current value. It decides whether the pill
		 *  runs AND is what the lookup reads, so the pill, the hint and the answer
		 *  always describe the same post — on the edit page too, where a stored
		 *  URL may differ from what the operator has typed since. */
		sourceUrl?: string;
		/** The rating the last lookup returned, for the note beside "Mark as NSFW". */
		rating?: EntailRating | null;
		/** Tag names already in the site, listed under the field. */
		existingTags?: string[];
		placeholder?: string;
		/** Multi-tile uploads suggest for the parent tile only; say so. */
		firstTileOnly?: boolean;
	} = $props();

	// One Tags field per form, so the ids are fixed.
	const inputId = 'tags-input';
	const hintId = 'tags-hint';
	const statusId = 'tags-status';
	const eyebrowId = 'tags-eyebrow';
	const helpId = 'tags-help';
	const appliedId = 'tags-applied';

	let suggestion = $state<SuggestionState>({ kind: 'idle' });
	// The one live region on this field. It is rendered empty on page load and
	// every status sentence is written INTO it — a role=status element inserted
	// with its text already inside announces nothing in NVDA or JAWS.
	let announcement = $state('');
	let pill = $state<HTMLButtonElement | null>(null);
	let statusLine = $state<HTMLElement | null>(null);
	// Guards a second click while a lookup is in flight, and lets a stale answer
	// be dropped when the operator has already asked again.
	let requestSeq = 0;

	// The pill is enabled by the same rule the endpoint applies, so a URL the
	// server would refuse never looks clickable.
	const source = $derived(classifySourceUrl(sourceUrl));
	const searching = $derived(suggestion.kind === 'searching');
	const disabled = $derived(source === null || searching);
	const chosen = $derived(selectedTags(suggestion));

	const hint = $derived(
		source === null || suggestion.kind === 'noSource'
			? m.admin_tag_suggest_hint_no_source()
			: m.admin_tag_suggest_hint()
	);

	// The pill points at the sentence that explains its current state: the hint
	// normally, the "Reading the …" line while a lookup runs, and the applied
	// line once tags have landed.
	const pillDescribedBy = $derived(
		suggestion.kind === 'applied' ? appliedId : suggestion.kind === 'searching' ? statusId : hintId
	);

	async function suggest() {
		// aria-disabled leaves the pill focusable, so the refusal happens here.
		if (disabled || source === null) return;
		const seq = ++requestSeq;
		rating = null;
		suggestion = { kind: 'searching', source: source.kind };
		announcement = readingLabel(source.kind);
		// "Try again" lives in the tray, and the tray just turned into the
		// searching skeleton: keep focus on the pill rather than letting it drop
		// to <body>. A click on the pill itself already has focus there.
		await tick();
		pill?.focus();

		const { status, body } = await requestSuggestions({ sourcePostUrl: sourceUrl });

		// The operator asked again while this was in flight; that answer wins.
		if (seq !== requestSeq) return;

		const next = fromResponse(status, body, parseTagInput(value));
		suggestion = next;
		rating = next.kind === 'suggested' ? next.rating : null;
		announcement = sentenceFor(next);
	}

	function onToggle(tag: string) {
		suggestion = toggleTag(suggestion, tag);
	}

	async function add() {
		if (suggestion.kind !== 'suggested') return;
		const accepted = chosen;
		if (accepted.length === 0) return;
		value = applyTo(value, accepted);
		suggestion = { kind: 'applied', count: accepted.length };
		announcement = m.admin_tag_suggest_applied({ count: accepted.length });
		// The tray the button lived in is gone; land focus on the line that says
		// what happened rather than dropping it to <body>.
		await tick();
		statusLine?.focus();
	}

	function dismiss() {
		requestSeq++;
		suggestion = { kind: 'idle' };
		rating = null;
		announcement = '';
		pill?.focus();
	}
</script>

<div class="field">
	<label class="field-label" for={inputId}>
		{m.admin_field_tags()}
		{#if suggestion.kind === 'applied'}<span class="tag">{m.admin_tag_suggest_from_suggestions()}</span>{/if}
	</label>

	<div class="input-group">
		<input
			type="text"
			class="input"
			id={inputId}
			name="tags"
			{placeholder}
			bind:value
		/>
		<button
			bind:this={pill}
			type="button"
			class="tag-pill"
			aria-disabled={disabled}
			aria-describedby={pillDescribedBy}
			onclick={suggest}
		>
			{#if searching}
				<LoaderCircle size={14} class="tag-spin" />
				{m.admin_tag_suggest_searching()}
			{:else}
				<Tag size={14} />
				{m.admin_tag_suggest_button()}
			{/if}
		</button>
	</div>

	<!-- One persistent live region for this field. Always rendered, always
	     empty until a status sentence is written into it. -->
	<p class="sr-only" role="status" id={statusId}>{announcement}</p>

	{#if suggestion.kind === 'applied'}
		<!-- Focus lands here after Add: the tray that held the button is gone, so
		     the line that says what happened is where the operator resumes. -->
		<p class="tag-status-line" id={appliedId} tabindex="-1" bind:this={statusLine}>
			<Check size={14} />
			{m.admin_tag_suggest_applied({ count: suggestion.count })}
		</p>
	{:else}
		<p class="hint" id={hintId}>
			{hint}{#if firstTileOnly && source !== null}&nbsp;{m.admin_tag_suggest_hint_first_tile()}{/if}
		</p>
	{/if}

	{#if existingTags.length > 0}
		<!-- The tag names already on the site, as both forms showed them before the
		     suggestion control moved this field into a component. A tooltip hides it
		     from touch and from keyboard users entirely. -->
		<small class="hint">{m.admin_upload_existing_tags({ tags: existingTags.join(', ') })}</small>
	{/if}

	{#if suggestion.kind !== 'idle' && suggestion.kind !== 'applied' && suggestion.kind !== 'noSource'}
		<div class="tag-tray" role="region" aria-label={m.admin_tag_suggest_region_label()}>
			{#if suggestion.kind === 'searching'}
				<p class="tag-eyebrow">{readingLabel(suggestion.source)}</p>
				<div class="tag-chiprow" aria-hidden="true">
					<span class="tag-skel-chip"></span>
					<span class="tag-skel-chip"></span>
					<span class="tag-skel-chip"></span>
					<span class="tag-skel-chip"></span>
					<span class="tag-skel-chip"></span>
				</div>
			{:else if suggestion.kind === 'suggested'}
				<!-- The group is named from this line, the one a sighted operator reads,
				     rather than from the live region: the backfill rows already do it
				     this way, and a name only screen readers can see drifts. -->
				<p class="tag-eyebrow" id={eyebrowId}>{m.admin_tag_suggest_eyebrow({ count: suggestion.tags.length })}</p>
				<TagSuggestionChips
					tags={suggestion.tags}
					leftOut={suggestion.leftOut}
					labelledBy={eyebrowId}
					describedBy={helpId}
					ontoggle={onToggle}
				/>
				<p class="tag-panel-sub" id={helpId}>{m.admin_tag_suggest_help()}</p>
				{#if suggestion.skippedExisting}
					<p class="tag-panel-sub">{m.admin_tag_suggest_help_existing()}</p>
				{/if}
				{#if suggestion.imageCount > 1}
					<p class="tag-panel-sub">{m.admin_tag_suggest_multi_image({ count: suggestion.imageCount })}</p>
				{/if}
				<div class="tag-actions">
					<button
						type="button"
						class="btn btn-primary tag-btn-sm"
						disabled={chosen.length === 0}
						onclick={add}
					>
						{m.admin_tag_suggest_add({ count: chosen.length })}
					</button>
					<button type="button" class="tag-btn-text" onclick={dismiss}>
						{m.admin_tag_suggest_dismiss()}
					</button>
				</div>
			{:else}
				<!-- Every other finished state is the same tray: an eyebrow, a
				     sentence, and Try again only where another click could answer
				     differently. trayFor decides which, for this and the backfill row. -->
				{@const tray = trayFor(suggestion)}
				<p class="tag-eyebrow" class:warn={tray.warn}>{tray.title}</p>
				<p class="tag-panel-body">{tray.body}</p>
				<div class="tag-actions">
					{#if tray.retry}
						<button type="button" class="tag-pill" onclick={suggest}>
							<RefreshCw size={14} />
							{m.admin_tag_suggest_try_again()}
						</button>
					{/if}
					{#if tray.signIn}
						<!-- A dead session: another lookup sends the same cookie, so the way
						     out is the login page. -->
						<a class="tag-pill" href="/admin/login">{m.admin_tag_suggest_sign_in()}</a>
					{/if}
					<button
						type="button"
						class="tag-btn-text"
						class:tag-btn-text-flush={!tray.retry && !tray.signIn}
						onclick={dismiss}
					>
						{m.admin_tag_suggest_dismiss()}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 14px;
		font-weight: 500;
	}

	.input-group {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.input-group .input {
		flex: 1;
		min-width: 0;
	}

	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	@media (max-width: 640px) {
		.input-group {
			flex-wrap: wrap;
		}

		.input-group .tag-pill {
			width: 100%;
			justify-content: center;
		}
	}
</style>
