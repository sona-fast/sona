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
		selectedTags,
		toggleTag,
		type EntailRating,
		type SuggestionState
	} from '$lib/tag-suggestions';
	import * as m from '$lib/paraglide/messages';

	let {
		value = $bindable(''),
		sourceUrl = '',
		imageId = null,
		rating = $bindable(null),
		existingTags = [],
		placeholder = '',
		firstTileOnly = false,
		idPrefix = 'tags'
	}: {
		/** The Tags input's value, bound out to the form that submits it. */
		value: string;
		/** The Source Post URL field's current value; decides whether the pill runs. */
		sourceUrl?: string;
		/** Set on the edit page, where the URL is already stored server-side. */
		imageId?: number | null;
		/** The rating the last lookup returned, for the note beside "Mark as NSFW". */
		rating?: EntailRating | null;
		/** Tag names already in the site, offered as the input's tooltip. */
		existingTags?: string[];
		placeholder?: string;
		/** Multi-tile uploads suggest for the parent tile only; say so. */
		firstTileOnly?: boolean;
		idPrefix?: string;
	} = $props();

	const inputId = `${idPrefix}-input`;
	const hintId = `${idPrefix}-hint`;
	const statusId = `${idPrefix}-status`;
	const helpId = `${idPrefix}-help`;
	const appliedId = `${idPrefix}-applied`;

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
	// server would refuse never looks clickable. On the edit page the stored URL
	// is what gets used, but the field is what the operator is looking at.
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

	function setAnnouncement(text: string) {
		announcement = text;
	}

	function readingLabel(kind: 'bluesky' | 'x') {
		return kind === 'bluesky' ? m.admin_tag_suggest_reading_bluesky() : m.admin_tag_suggest_reading_x();
	}

	/** The sentence a finished state puts in the live region. */
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
			case 'noSource':
				return m.admin_tag_suggest_hint_no_source();
			default:
				return '';
		}
	}

	async function suggest() {
		// aria-disabled leaves the pill focusable, so the refusal happens here.
		if (disabled || source === null) return;
		const seq = ++requestSeq;
		rating = null;
		suggestion = { kind: 'searching', source: source.kind };
		setAnnouncement(readingLabel(source.kind));

		let status = 0;
		let body: unknown = null;
		try {
			const res = await fetch('/api/admin/tag-suggestions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(imageId === null ? { sourcePostUrl: sourceUrl } : { imageId })
			});
			status = res.status;
			// A 202 carries no suggestions and a 5xx may carry no JSON at all;
			// neither is a reason to put a parser's message on the form.
			try {
				body = await res.json();
			} catch {
				body = null;
			}
		} catch {
			// Offline, aborted, blocked: the same answer as a dead upstream.
			status = 0;
		}

		// The operator asked again while this was in flight; that answer wins.
		if (seq !== requestSeq) return;

		const next = fromResponse(status, body, parseTagInput(value));
		suggestion = next;
		rating = next.kind === 'suggested' ? next.rating : null;
		setAnnouncement(sentenceFor(next));
	}

	function onToggle(tag: string) {
		suggestion = toggleTag(suggestion, tag);
	}

	async function add() {
		if (suggestion.kind !== 'suggested') return;
		const accepted = chosen;
		if (accepted.length === 0) return;
		value = applyTo(value, accepted);
		suggestion = { kind: 'applied', count: accepted.length, rating: suggestion.rating };
		setAnnouncement(m.admin_tag_suggest_applied({ count: accepted.length }));
		// The tray the button lived in is gone; land focus on the line that says
		// what happened rather than dropping it to <body>.
		await tick();
		statusLine?.focus();
	}

	function dismiss() {
		requestSeq++;
		suggestion = { kind: 'idle' };
		rating = null;
		setAnnouncement('');
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
			title={existingTags.length > 0
				? m.admin_upload_existing_tags({ tags: existingTags.join(', ') })
				: undefined}
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
				<p class="tag-eyebrow">{m.admin_tag_suggest_eyebrow({ count: suggestion.tags.length })}</p>
				<TagSuggestionChips
					tags={suggestion.tags}
					leftOut={suggestion.leftOut}
					labelledBy={statusId}
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
			{:else if suggestion.kind === 'empty'}
				<p class="tag-eyebrow">{m.admin_tag_suggest_empty_title()}</p>
				<p class="tag-panel-body">{m.admin_tag_suggest_empty_body()}</p>
				<div class="tag-actions">
					<button type="button" class="tag-btn-text tag-btn-text-flush" onclick={dismiss}>
						{m.admin_tag_suggest_dismiss()}
					</button>
				</div>
			{:else if suggestion.kind === 'notFound'}
				<p class="tag-eyebrow warn">{m.admin_tag_suggest_unavailable_title()}</p>
				<p class="tag-panel-body">{m.admin_tag_suggest_not_found_body()}</p>
				<div class="tag-actions">
					<button type="button" class="tag-btn-text tag-btn-text-flush" onclick={dismiss}>
						{m.admin_tag_suggest_dismiss()}
					</button>
				</div>
			{:else}
				<!-- notReady, unavailable, rateLimited: same shape, different sentence,
				     and all three are worth another click. -->
				<p class="tag-eyebrow warn">
					{suggestion.kind === 'notReady'
						? m.admin_tag_suggest_not_yet_title()
						: m.admin_tag_suggest_unavailable_title()}
				</p>
				<p class="tag-panel-body">
					{#if suggestion.kind === 'notReady'}{m.admin_tag_suggest_not_yet_body()}
					{:else if suggestion.kind === 'rateLimited'}{m.admin_tag_suggest_rate_limited_body()}
					{:else}{m.admin_tag_suggest_unavailable_body()}{/if}
				</p>
				<div class="tag-actions">
					<button type="button" class="tag-pill" onclick={suggest}>
						<RefreshCw size={14} />
						{m.admin_tag_suggest_try_again()}
					</button>
					<button type="button" class="tag-btn-text" onclick={dismiss}>
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

	/* The loader turns while a lookup runs; a spinner that never stops is exactly
	   the motion prefers-reduced-motion is asking about, so it holds still. */
	.input-group :global(.tag-spin) {
		animation: tag-spin 1s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.input-group :global(.tag-spin) {
			animation: none;
		}
	}

	@keyframes tag-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
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
