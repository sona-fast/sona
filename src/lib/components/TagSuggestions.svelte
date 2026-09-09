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
	import { tick, untrack } from 'svelte';
	import { Check, LoaderCircle, LogIn, RefreshCw, Tag } from 'lucide-svelte';
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
		sourceKey,
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
		firstTileOnly = false,
		sourceDescribedBy = $bindable(undefined)
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
		/** The id the form should hang off its Source Post URL input while the
		 *  refusal under this field is about that URL, or undefined. The hint
		 *  lives here; the field it refuses lives in the form, and a screen
		 *  reader that lands on that field finds nothing otherwise. */
		sourceDescribedBy?: string | undefined;
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
	// Which post the answer on screen is about, as its sourceKey, or null where there is
	// no answer that a change of URL could invalidate. Set only for the two states
	// that describe the post itself — chips and "nothing to suggest" — so the
	// failures, which are true whatever the field holds, keep their tray.
	let answeredFor: string | null = null;

	// The pill is enabled by the same rule the endpoint applies, so a URL the
	// server would refuse never looks clickable.
	const source = $derived(classifySourceUrl(sourceUrl));
	// Which post the field names, or null. Two URLs that name the same post — a
	// trailing slash, a tracking query string, an X status under another handle —
	// give the same key, so an edit that changes nothing about the post does not
	// throw the answer away.
	const post = $derived(sourceKey(source));
	const searching = $derived(suggestion.kind === 'searching');
	const disabled = $derived(source === null || searching);
	const chosen = $derived(selectedTags(suggestion));

	// Two different refusals, two different sentences. An empty or unrecognised
	// field is the operator's to fill in; a 422 means the client recogniser
	// accepted the link and the server's refused it before sending anything, and
	// "add a post URL" would then describe a field that is not empty.
	const hint = $derived(
		source === null
			? m.admin_tag_suggest_hint_no_source()
			: suggestion.kind === 'noSource'
				? m.admin_tag_suggest_bad_link_body()
				: m.admin_tag_suggest_hint()
	);

	// The batch sentence rides on the ordinary hint, and only there: appended to
	// the refusal it would answer a link the site cannot look up with a note about
	// where accepted tags go. The two sentences are joined through a message
	// rather than with a literal space — both already carry their own full stop,
	// and Japanese sets no space after one.
	const hintLine = $derived(
		firstTileOnly && source !== null && suggestion.kind !== 'noSource'
			? m.admin_tag_suggest_hint_join({
					first: hint,
					second: m.admin_tag_suggest_hint_first_tile()
				})
			: hint
	);

	// The tray body swaps to the no-source sentence exactly here: a finished
	// failure whose Try again could answer differently, over a URL that has
	// since stopped being a post. Derived rather than written inline, so the
	// effect below announces the same transition the body draws.
	// The four kinds this passes over are the ones the tray answers itself, with
	// the skeleton, the chips, or nothing at all; trayFor hands every one of them
	// its retry:true default, so they cannot be read off the mapping.
	const retryTrayOpen = $derived(
		suggestion.kind !== 'idle' &&
			suggestion.kind !== 'applied' &&
			suggestion.kind !== 'searching' &&
			suggestion.kind !== 'suggested' &&
			trayFor(suggestion).retry
	);

	// A sighted operator sees the body swap; a screen reader gets nothing unless
	// the sentence is written into the live region, so the announcement runs off
	// the same condition the body draws from rather than off a keystroke: a tray
	// that opens over a URL the operator already cleared says the sentence too.
	// Once per entry into the state — the source field changes on every
	// keystroke, and a region rewritten with the sentence it already holds
	// announces it all over again — and leaving the state arms it again, so
	// clearing the field a second time is announced a second time.
	// The one condition the effect below and the tray body both read: a retryable
	// tray still open over a field that no longer holds a post.
	const noPostToRetry = $derived(retryTrayOpen && source === null);

	let spoken = false;
	$effect(() => {
		const sentence = m.admin_tag_suggest_retry_needs_post_body();
		if (noPostToRetry) {
			if (spoken) return;
			spoken = true;
			announcement = sentence;
			return;
		}
		if (!spoken) return;
		spoken = false;
		// On the way out the sentence stops being true, and a region still
		// holding it is a region that cannot announce it again: rewriting a live
		// region with the text it already has is not a change, so nothing is
		// read. Cleared only while it is still this sentence — a lookup that
		// started in the meantime has written its own. No UI path reaches that
		// today (a lookup refuses to start while the field holds no post, so the
		// exit has already run by the time one can), so the guard is defensive
		// and is not driven by a test. Untracked, or the write below would re-run
		// the effect that made it.
		if (untrack(() => announcement) === sentence) announcement = '';
	});

	// A 422 is about the link that was in the field when the lookup ran. Once
	// the operator edits the URL, the hint under the field would go on refusing
	// a link that is no longer there, so the state goes back to idle and the
	// hint back to the one that says what a URL has to be. The refused URL is
	// not kept: the effect re-runs because it reads the field, and untrack keeps
	// the state it clears out of its dependencies — read plainly, the reset
	// would undo every 422 the moment it arrived.
	//
	// An answer about the post itself goes the same way, and for the same reason:
	// chips from post A left standing over post B would be added to B, with A's
	// rating driving the NSFW prompt, and A's "nothing to suggest" would be a
	// verdict on a post nobody is looking at. Compared by the post each names, so
	// a trailing slash or a tracking parameter on the same post keeps the answer. Accepted
	// tags stay in the field either way — they are the operator's now — but the
	// line that confirmed them and the rating behind the NSFW prompt go, because
	// both are about the post that was looked up.
	$effect(() => {
		void sourceUrl;
		untrack(() => {
			if (suggestion.kind === 'noSource') {
				suggestion = { kind: 'idle' };
				// The live region still holds what that state announced, about a link
				// that has since left the field. It goes with the state, so a screen
				// reader is not left the refusal as the field's last word. Cleared only
				// while it is still that sentence.
				if (announcement === m.admin_tag_suggest_bad_link_body()) announcement = '';
				return;
			}
			// `post` is read off the `source` derived, which already classified the
			// field, rather than classifying the same string a second time.
			if (answeredFor === null || answeredFor === post) return;
			answeredFor = null;
			suggestion = { kind: 'idle' };
			// The rating belongs to the answer, and the note beside the NSFW box
			// reads it: left behind it would offer to mark the post now in the field
			// on the strength of a lookup of another one.
			rating = null;
			// Said out loud, the way a drop mid-flight is: the region last named
			// the answer, and a screen reader is otherwise not told it went. Once
			// per change of post — the answeredFor guard above sees to that.
			announcement = m.admin_tag_suggest_dropped_body();
		});
	});

	// A 422 refuses the URL in the other field, so that field points at the hint
	// saying so for as long as the refusal stands. Cleared with the state, which
	// the effect above resets as soon as the operator edits the URL.
	$effect(() => {
		sourceDescribedBy = suggestion.kind === 'noSource' ? hintId : undefined;
	});

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
		answeredFor = null;
		suggestion = { kind: 'searching', source: source.kind };
		announcement = readingLabel(source.kind);
		// "Try again" lives in the tray, and the tray just turned into the
		// searching skeleton: keep focus on the pill rather than letting it drop
		// to <body>. A click on the pill itself already has focus there.
		await tick();
		pill?.focus();

		// What the lookup went out with, and which post that names. Every answer
		// is an answer about THIS link, so it has to be checked against the field
		// it came from; nothing keeps the URL past this call.
		const asked = sourceUrl;
		const askedPost = post;
		const { status, body } = await requestSuggestions({ sourcePostUrl: asked });

		// The operator asked again while this was in flight; that answer wins.
		if (seq !== requestSeq) return;

		const next = fromResponse(status, body, parseTagInput(value));
		// The field moved on while the answer was in flight, and these three
		// outcomes each describe the POST the lookup went out with: chips would be
		// offered as tags for the post now in the field, with their rating driving
		// the NSFW prompt; "found nothing" would be a verdict on a post nobody can
		// see; and a refusal would leave the hint refusing a URL that is gone. The
		// reset effect below has already run for that edit, so any of them would
		// stay. Dropped instead: back to idle, and said so. The lookup
		// FAILURES are kept — "the lookup failed" is true whatever the field now
		// holds, and their tray reads the current field for what to offer next.
		if (
			post !== askedPost &&
			(next.kind === 'suggested' || next.kind === 'empty' || next.kind === 'noSource')
		) {
			suggestion = { kind: 'idle' };
			// Not blanked: the region last said "Reading the …", and a screen reader
			// left with that has no way to know the lookup ended. Say that it was set
			// aside instead, which is what happened.
			announcement = m.admin_tag_suggest_dropped_body();
			return;
		}
		suggestion = next;
		// Which post this answer is about, so an edit to the URL that lands on
		// another post takes it away again.
		answeredFor = next.kind === 'suggested' || next.kind === 'empty' ? askedPost : null;
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
		answeredFor = null;
		suggestion = { kind: 'idle' };
		rating = null;
		announcement = '';
		pill?.focus();
	}
</script>

<div class="field">
	<!-- The badge sits beside the label, not inside it: inside, it joins the
	     input's accessible name and the field reads "Tags From suggestions". -->
	<div class="label-row">
		<label class="field-label" for={inputId}>{m.admin_field_tags()}</label>
		{#if suggestion.kind === 'applied'}<span class="tag">{m.admin_tag_suggest_from_suggestions()}</span>{/if}
	</div>

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
				<LoaderCircle size={14} class="tag-spin" aria-hidden="true" />
				{m.admin_tag_suggest_searching()}
			{:else}
				<Tag size={14} aria-hidden="true" />
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
			<Check size={14} aria-hidden="true" />
			{m.admin_tag_suggest_applied({ count: suggestion.count })}
		</p>
	{:else}
		<!-- A refused link is a warning, not a note: in the tray the same sentence
		     gets the warn eyebrow, and left in the plain hint colour here it reads
		     like the "Existing:" line under it. -->
		<p class="hint" class:warn={suggestion.kind === 'noSource'} id={hintId}>
			{hintLine}
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
				<!-- Once the URL under an open tray stops being a post, what stands between
				     the operator and another answer is the URL, not the failure the body
				     describes. The eyebrow keeps saying what happened; the body says what
				     is true instead. Its own sentence, not the field's: the hint asking
				     for a post sits about 60px from this line, and a body echoing it word
				     for word would read as the same line printed twice. -->
				<p class="tag-panel-body">
					{noPostToRetry ? m.admin_tag_suggest_retry_needs_post_body() : tray.body}
				</p>
				<div class="tag-actions">
					{#if tray.retry}
						<!-- The URL can be edited to something unrecognisable while this
						     tray is open, and then suggest() refuses. Say so the way the
						     pill does rather than leaving a button that does nothing:
						     aria-disabled, and the hint that names what a URL has to be. -->
						<button
							type="button"
							class="tag-pill"
							aria-disabled={disabled}
							aria-describedby={hintId}
							onclick={suggest}
						>
							<RefreshCw size={14} aria-hidden="true" />
							{m.admin_tag_suggest_try_again()}
						</button>
					{/if}
					{#if tray.signIn}
						<!-- A dead session: another lookup sends the same cookie, so the way
						     out is the login page. -->
						<a class="tag-pill" href="/admin/login">
							<LogIn size={14} aria-hidden="true" />
							{m.admin_tag_suggest_sign_in()}
						</a>
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

	.label-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.field-label {
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

	/* The tray eyebrow's warn colour, held to 4.5:1 on the card in every theme
	   by theme-contrast.test.ts. */
	.hint.warn {
		color: var(--status-warn);
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
