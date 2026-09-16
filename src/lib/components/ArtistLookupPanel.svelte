<script lang="ts">
	// The "Look up artist" result panel (SONA-156), shared by the upload page and
	// the image edit page. It renders a lookup's state and reports what the
	// operator chose; it owns no form fields of its own — every prefill and every
	// artist change happens in the page, so the two pages keep their own idea of
	// what "empty" means and what a click may overwrite.
	import { tick } from 'svelte';
	import { Check, Globe, Info, Loader2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import {
		bandLabel,
		candidateArtists,
		clearedLine,
		isCrossSiteAmbiguity,
		matchForArtist,
		matchHandle,
		matchHandles,
		matchKey,
		nameMatchArtists,
		namesNoSite,
		pickPrefillMatch,
		postDateToInput,
		ratingLabel,
		resolveOutcome,
		seedStatusKind,
		siteLabel,
		statusLineKind,
		statusSentence,
		type ArtistChoice,
		type LookupCleared,
		type LookupEdited,
		type LookupFields,
		type LookupMatch,
		type LookupSite,
		type LookupState,
		type NewArtistSeed,
		type SeedEdited,
		type SourceClash
	} from '$lib/artist-lookup';

	interface Props {
		lookup: LookupState;
		/** Multi-tile only: the parent tile's file name, appended to the eyebrow. */
		fileName?: string;
		/** What the page's prefill actually wrote, for the status line. This record
		 * is immutable — it describes the lookup, not the form as it stands now. */
		filled?: LookupFields;
		/** Which of the two fields holds the operator's own text: one they typed
		 * over since, or one they filled that no lookup had. An edited field is
		 * no longer the lookup's, so the sentence stops claiming it, stops saying
		 * it was left alone, and stops saying Sona cleared it. */
		edited?: LookupEdited;
		/** What the page seeded into an inline new-artist form, for the status
		 * line — the seed is subject to the same never-overwrite rule, so the
		 * sentence has to say which of the two fields it actually filled. */
		seeded?: NewArtistSeed;
		/** Which of the two fields this result EMPTIED, because the last lookup
		 * filled them and this one has nothing to put in their place (SONA-220).
		 * A snapshot like `filled`: the sentence says what this result did. Read
		 * against `edited`, which is live — a field the operator has filled since
		 * is theirs, and no sentence may still say Sona cleared it. */
		cleared?: LookupCleared;
		/** `edited`, for the seeded fields — same rule, same reason. */
		seedEdited?: SeedEdited;
		/** Whether the source post URL field held anything when the prefill ran.
		 * Under a clash the prefill skips that field whatever it holds, so this is
		 * what tells "left it empty" from "left what was already there alone". A
		 * snapshot, like `filled`, not a live read: the sentence describes what the
		 * lookup did once, and typing into the field afterwards must not rewrite
		 * it. */
		sourceUrlHeld?: boolean;
		/** The artist currently applied from this result, if any. */
		appliedArtist?: { id: number; name: string } | null;
		/** The image is private and the file went out anyway — say so. */
		privateNotice?: boolean;
		/** The edit page fills only empty fields and never touches the artist, so
		 * its status line says what it left alone rather than what it changed. */
		editMode?: boolean;
		/** The image being edited already has variants of its own, so it cannot
		 * become a variant of another piece: the page renders no parent select for
		 * it and "Add as a variant" would be a silent no-op. The clash panel says why instead of offering it. */
		variantBlocked?: boolean;
		onclose: () => void;
		onretry: () => void;
		oncancel: () => void;
		onuseartist: (artist: { id: number; name: string }) => void;
		onaddnew: (seed: { handle: string; site: LookupSite; linkable: boolean }) => void;
		onaddvariant: (clash: SourceClash) => void;
	}

	let {
		lookup,
		fileName = '',
		filled = {},
		edited = {},
		cleared = {},
		seeded = {},
		seedEdited = {},
		sourceUrlHeld = false,
		appliedArtist = null,
		privateNotice = false,
		editMode = false,
		variantBlocked = false,
		onclose,
		onretry,
		oncancel,
		onuseartist,
		onaddnew,
		onaddvariant
	}: Props = $props();

	const data = $derived(lookup.kind === 'results' ? lookup.data : null);
	const prefill = $derived(data ? pickPrefillMatch(data.matches) : null);
	const handle = $derived(matchHandle(prefill));
	const outcome = $derived(data ? resolveOutcome(data) : 'none');
	const candidates = $derived<ArtistChoice[]>(data ? candidateArtists(data) : []);
	// The handle in the "already in your list" line comes from the match whose
	// hit produced that candidate, not from the prefill match: the candidates are
	// unioned across every confident match, so pairing the prefill handle with a
	// candidate's name can read "alice is already in your list as Bob".
	const existing = $derived(candidates.length === 1 ? candidates[0] : null);
	const existingHandle = $derived(
		data && existing ? matchHandle(matchForArtist(data, existing.id)) || handle : handle
	);
	const crossSite = $derived(data ? isCrossSiteAmbiguity(data) : false);
	const nameHits = $derived(data ? nameMatchArtists(data) : []);
	const clash = $derived(data?.sourceClash ?? null);
	const siteCount = $derived(data ? new Set(data.matches.map((x) => x.site)).size : 0);
	const statusKind = $derived(
		statusLineKind(filled, { clash: !!clash, edited, urlHeld: sourceUrlHeld, cleared })
	);
	// The one sentence for that kind, from the mapping the upload page's
	// announcement reads too — picked by hand on either side, the two named
	// different reasons for the same move (SONA-220).
	const statusText = $derived(
		statusSentence(statusKind, prefill?.site ?? null, { title: clash?.title ?? '', editMode })
	);
	// The kinds that report an emptied field and NOTHING else, off the same test
	// the mapping uses to answer them without a site: a second list here could
	// disagree with that one about which kinds get rendered in their own
	// paragraph, and the sentence would land in the arm that has no site to name.
	const emptiedOnly = $derived(namesNoSite(statusKind));
	// The same fields, said without a reason, for the searching arm: a move onto
	// a tile whose lookup is still out empties them right then, and every
	// status-line sentence blames a lookup that has not answered yet ("because
	// this lookup filled neither one"). Off the chooser the upload page's own
	// announcement of that move reads, so the two name the same fields.
	const movedEmptied = $derived(clearedLine(cleared, edited));
	// Every sentence that reports a field going blank, and not only the three
	// that report nothing else — the single answer to "does this line describe a
	// change the operator's fields just made".
	const reportsEmptied = $derived(
		emptiedOnly ||
			statusKind === 'url_and_date_emptied' ||
			statusKind === 'date_and_url_emptied' ||
			statusKind === 'clash_emptied' ||
			statusKind === 'clash_date_url_emptied'
	);
	// The two failure reasons that carry advice under the lead. Held as text so
	// the emptied sentence can go ABOVE it: a parent move onto a tile whose
	// lookup failed empties the fields, and what just happened to the form is
	// read before what to do about the failure. This list and the failed arm's
	// own reason branches have to stay in step — a reason that grows a hint in
	// one and not the other renders nothing.
	const failedHint = $derived(
		lookup.kind !== 'failed'
			? ''
			: lookup.reason === 'rate_limited'
				? m.admin_lookup_paused_hint()
				: lookup.reason === 'key_refused'
					? m.admin_lookup_refused_hint()
					: ''
	);
	const seedKind = $derived(seedStatusKind(seeded, seedEdited));
	// The "Sets the artist to {name}." sentence and the button it
	// names render on the same condition, so the button can describe itself with
	// it — an operator who tabs straight to the action row otherwise hears only
	// "Use {name}", with nothing saying what pressing it does.
	const artistHintShown = $derived(
		editMode && outcome === 'existing' && !appliedArtist && !!candidates[0]
	);
	// "Uploaded {date} · {artist} · {w} x {h}", with any part dropped when the row
	// has no answer for it rather than spelled out as a blank.
	const clashMeta = $derived.by(() => {
		if (!clash) return '';
		const parts: string[] = [];
		const date = postDateToInput(clash.uploadedAt);
		if (date) parts.push(m.admin_lookup_clash_uploaded({ date }));
		if (clash.artistName) parts.push(clash.artistName);
		if (clash.width && clash.height) {
			parts.push(m.admin_lookup_clash_dimensions({ width: clash.width, height: clash.height }));
		}
		return parts.join(' · ');
	});

	// The ambiguous state's radio list. Reset whenever the result changes so a
	// stale pick can't be applied to a different lookup.
	let picked = $state('');
	$effect(() => {
		void data;
		picked = '';
	});

	const pickedArtist = $derived(candidates.find((c) => String(c.id) === picked) ?? null);

	function useSelected() {
		if (pickedArtist) onuseartist({ id: pickedArtist.id, name: pickedArtist.name });
	}

	/** The metadata line under a result row, with unknown segments dropped
	 * rather than spelled out as blanks. */
	function metaFor(match: Pick<LookupMatch, 'band' | 'postedAt' | 'rating'>) {
		const parts: string[] = [];
		const band = bandLabel(match.band);
		if (band) parts.push(band);
		const date = postDateToInput(match.postedAt);
		if (date) parts.push(m.admin_lookup_posted({ date }));
		if (match.rating) parts.push(ratingLabel(match.rating));
		return parts.join(' · ');
	}
</script>

<!-- The panel and its live region are ALWAYS in the DOM, collapsed to nothing
     while idle. A role="status" inserted together with its first content is
     commonly missed by screen readers, and that first content is "Sending the
     image to FuzzySearch." — the one message that says the lookup started.

     The region is atomic, so every change to the status line re-speaks the whole
     panel. What the lookup filled is a fixed record and only the edited-since
     flags move, and a flag flips the first time a field holds text of the
     operator's and not again: the tag half is dropped by the first keystroke
     over a filled field, and the typed-into half is latched by the page on the
     first non-empty input rather than derived from the text, so deleting what
     they typed does not flip it back (SONA-220). An operator revising a field
     hears the panel once for it, not once per keystroke. -->
<div
	class="lookup-panel"
	class:idle={lookup.kind === 'idle'}
	role="region"
	aria-label={m.admin_lookup_panel_label()}
>
	<div class="lookup-body" role="status">
		{#if lookup.kind !== 'idle'}
			{#if lookup.kind === 'searching'}
				<div class="lookup-eyebrow">{m.admin_lookup_searching_eyebrow()}</div>
				<div class="skeletons" aria-hidden="true">
					<span class="skeleton"></span>
					<span class="skeleton"></span>
					<span class="skeleton"></span>
				</div>
				<!-- The spinner belongs to the progress the line describes, not to the
				     Cancel button, where it read as "cancelling in progress". -->
				<p class="lookup-status searching-line">
					<Loader2 size={14} class="spin" aria-hidden="true" />
					{m.admin_lookup_searching_body()}
				</p>
				<!-- A parent move onto a tile whose own lookup is still out empties
				     what the last parent's lookup filled, and this arm used to say
				     nothing about it: the two fields went blank while the panel talked
				     only about the search, so a sighted operator saw nothing until the
				     result landed. The reasonless sentence, not the status line's:
				     nothing is settled about a lookup still running. Under the progress
				     line, the way the no-match and failed arms put it under their
				     lead. -->
				{#if movedEmptied}
					<p class="lookup-status lookup-emptied">{movedEmptied}</p>
				{/if}
			{:else if lookup.kind === 'no_match'}
				<div class="lookup-eyebrow">{m.admin_lookup_no_match_eyebrow()}</div>
				<p class="lookup-lead">{m.admin_lookup_no_match_body()}</p>
				<!-- A no-match is a result with nothing to prefill, so it empties what
				     the last lookup filled. Said here, above the hint: the operator
				     watches the two fields go blank and this arm carries no status
				     line of its own. -->
				{#if emptiedOnly}
					<p class="lookup-status lookup-emptied">{statusText}</p>
				{/if}
				<p class="lookup-status">{m.admin_lookup_no_match_hint()}</p>
			{:else if lookup.kind === 'failed'}
				{#if lookup.reason === 'rate_limited'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_paused_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_paused_body()}</p>
				{:else if lookup.reason === 'key_refused'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_refused_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_refused_body()}</p>
				{:else if lookup.reason === 'too_large'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_too_large_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_too_large_body()}</p>
				{:else if lookup.reason === 'invalid_image'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_failed_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_invalid_body()}</p>
				{:else if lookup.reason === 'no_key'}
					<!-- The key went away after the page loaded, so the button is still
					     here. Nothing was sent, and the remedy is Settings, not a retry. -->
					<div class="lookup-eyebrow warn">{m.admin_lookup_no_key_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_no_key_body()}</p>
				{:else if lookup.reason === 'gone'}
					<!-- The image was deleted between the page load and the click. Nothing
					     was sent, FuzzySearch never saw it, and a retry would hit the same
					     missing row — so the body sends the operator to All Images, and
					     Close is the only action below. -->
					<div class="lookup-eyebrow warn">{m.admin_lookup_gone_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_gone_body()}</p>
				{:else if lookup.reason === 'signed_out'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_signed_out_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_signed_out_body()}</p>
				{:else}
					<div class="lookup-eyebrow">{m.admin_lookup_failed_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_failed_body()}</p>
				{/if}
				<!-- A failure fills nothing, but a parent move onto a tile that failed
				     still empties what the last parent's lookup filled. This arm carries
				     no status line of its own, so the sentence renders here — above the
				     advice, because the fields went blank under the operator and that is
				     the part nothing else on screen reports. -->
				{#if emptiedOnly}
					<p class="lookup-status lookup-emptied">{statusText}</p>
				{/if}
				{#if failedHint}
					<p class="lookup-status">{failedHint}</p>
				{/if}
			{:else if data}
				{#if clash}
					<div class="lookup-eyebrow warn">{m.admin_lookup_clash_eyebrow()}</div>
					<!-- The piece itself, so the operator recognizes it without opening it.
					     The thumbnail is decorative: the title beside it already names it. -->
					<div class="clash-row">
						{#if clash.thumbnailUrl}
							<img class="clash-thumb" src={clash.thumbnailUrl} alt="" />
						{/if}
						<span class="clash-id">
							<span class="clash-title">{clash.title}</span>
							{#if clashMeta}<span class="clash-meta">{clashMeta}</span>{/if}
						</span>
					</div>
					<!-- Gated on the prefill rather than defaulting its site: a clash only
					     exists because a prefill match produced the URL, so there is no
					     reachable state to guess for, and a guess would name the wrong site
					     if one ever appeared. -->
					{#if prefill}
						<p class="lookup-lead">
							{m.admin_lookup_clash_body({
								site: siteLabel(prefill.site),
								title: clash.title,
								variants:
									clash.variantCount > 0
										? m.admin_lookup_variants({ count: clash.variantCount })
										: ''
							})}
						</p>
					{/if}
					{#if variantBlocked}
						<!-- No "Add as a variant" below, so the panel says why rather than
						     leaving the offer out unexplained. -->
						<p class="lookup-status">{m.admin_lookup_clash_has_variants()}</p>
					{/if}
				{:else}
					<div class="lookup-eyebrow">
						{m.admin_lookup_found_on_sites({ count: siteCount })}{#if fileName}
							<span class="eyebrow-file">{m.admin_lookup_eyebrow_file({ fileName })}</span>
						{/if}
					</div>
				{/if}

				<ul class="match-list">
					{#each data.matches as match (matchKey(match))}
						{@const handles = matchHandles(match)}
						<li class="match-row">
							<!-- The brand mark, decorative: the line beside it names the site
							     in words. Weasyl and e621 have no mark here, so they get the
							     neutral globe rather than two letters of their name. -->
							<span class="match-site" aria-hidden="true">
								{#if match.site === 'FurAffinity'}
									<FurAffinityIcon size={14} />
								{:else if match.site === 'Twitter'}
									<TwitterIcon size={14} />
								{:else}
									<Globe size={14} />
								{/if}
							</span>
							<span class="match-id">
								{#if handles}
									<span class="match-who">{m.admin_lookup_match_line({ handles, site: siteLabel(match.site) })}</span>
								{:else}
									<span class="match-who muted">{m.admin_lookup_match_unknown({ site: siteLabel(match.site) })}</span>
								{/if}
								<span class="match-meta">{metaFor(match)}</span>
							</span>
							<a class="match-link" href={match.postUrl} target="_blank" rel="noopener noreferrer">
								{m.admin_lookup_view_post()}<span class="sr-only"
									>{m.admin_lookup_view_post_site({ site: siteLabel(match.site) })}</span
								>
							</a>
						</li>
					{/each}
				</ul>

				<!-- The clash panel asks the same question about the artist as any
				     other ambiguous result: a duplicate source URL says nothing about
				     WHICH of two same-named artists drew it, so the operator picks
				     rather than having the first candidate chosen for them. -->
				{#snippet ambiguousPick()}
					<p class="outcome">
						<Info size={14} aria-hidden="true" />
						{crossSite
							? m.admin_lookup_ambiguous_cross({ count: candidates.length })
							: m.admin_lookup_ambiguous({ handle, count: candidates.length })}
					</p>
					<fieldset class="pick-list">
						<legend class="sr-only">{m.admin_lookup_which_one()}</legend>
						{#each candidates as candidate (candidate.id)}
							<label class="pick-row">
								<input type="radio" name="lookup-artist-pick" value={String(candidate.id)} bind:group={picked} />
								<span>{candidate.name}</span>
								{#if candidate.pieces !== undefined}
									<span class="pick-meta">{m.admin_lookup_pieces({ count: candidate.pieces })}</span>
								{/if}
								{#if crossSite}
									<span class="pick-meta">{m.admin_lookup_via_site({ site: siteLabel(candidate.site) })}</span>
								{/if}
							</label>
						{/each}
					</fieldset>
				{/snippet}

				{#if clash}
					{#if outcome === 'ambiguous'}
						{@render ambiguousPick()}
					{/if}
				{:else}
					{#if outcome === 'existing'}
						<p class="outcome">
							<Check size={14} aria-hidden="true" />
							{m.admin_lookup_existing({ handle: existingHandle, name: existing?.name ?? '' })}
						</p>
					{:else if outcome === 'ambiguous'}
						{@render ambiguousPick()}
					{:else if outcome === 'new'}
						<p class="outcome">
							<Info size={14} aria-hidden="true" />
							{m.admin_lookup_new({ handle })}
						</p>
						{#if nameHits.length}
							<p class="callout">{m.admin_lookup_name_match({ handle, name: nameHits[0].name })}</p>
						{/if}
					{:else if outcome === 'unlinked'}
						<p class="outcome">
							<Info size={14} aria-hidden="true" />
							{m.admin_lookup_unlinked()}
						</p>
					{/if}
				{/if}

				{#if emptiedOnly}
					<p class="lookup-status lookup-emptied">{statusText}</p>
				{:else if statusText}
					<p class="lookup-status" class:lookup-emptied={reportsEmptied}>{statusText}</p>
				{/if}

				<!-- Its own paragraph, on its own condition: nested in the status sentence
				     above it disappeared whenever that sentence did, and the sentence goes
				     away as soon as the operator edits the field the lookup filled — which
				     has nothing to do with whether the artist is still unapplied. -->
				{#if artistHintShown && candidates[0]}
					<p class="lookup-status" id="lookup-artist-hint">
						{m.admin_lookup_status_artist_hint({ name: candidates[0].name })}
					</p>
				{/if}

				<!-- The seed obeys the same never-overwrite rule as the two fields
				     above, so the sentence names only what it actually wrote. -->
				{#if seedKind !== 'none' && prefill}
					<p class="lookup-status">
						{#if seedKind === 'both'}
							{m.admin_lookup_status_seed_both({ site: siteLabel(prefill.site) })}
						{:else if seedKind === 'name_only'}
							{m.admin_lookup_status_seed_name()}
						{:else}
							{m.admin_lookup_status_seed_link({ site: siteLabel(prefill.site) })}
						{/if}
					</p>
				{/if}
			{/if}

			{#if privateNotice}
				<p class="private-notice">{m.admin_lookup_private_notice()}</p>
			{/if}
		{/if}
		</div>

		{#if lookup.kind !== 'idle'}
		<div class="lookup-actions">
			<!-- One Use button for both action rows. Under a clash it used to render
			     unapplied whatever the state, so clicking it moved the select and the
			     live region while the button itself never changed — a sighted
			     operator had nothing saying it applied. -->
			{#snippet useArtistAction(artist: { id: number; name: string }, primary: boolean)}
				{#if appliedArtist && appliedArtist.id === artist.id}
					<!-- Named so a page can land focus here: creating the artist from the
					     lookup's dialog destroys the "Add {handle} as a new artist"
					     button this one replaces, and that button is the dialog's
					     captured opener (2.4.3). -->
					<button
						type="button"
						class="btn btn-secondary applied"
						id="lookup-applied-artist"
						onclick={() => onuseartist(artist)}
					>
						<Check size={14} aria-hidden="true" />
						{m.admin_lookup_using_artist({ name: artist.name })}
					</button>
				{:else}
					<button
						type="button"
						class="btn {primary ? 'btn-primary' : 'btn-secondary'}"
						aria-describedby={artistHintShown ? 'lookup-artist-hint' : undefined}
						onclick={async () => {
							onuseartist(artist);
							// Applying swaps this button for the "Using {name}" one above,
							// and the two branches compile to separate fragments: the
							// button the operator is standing on is destroyed, so without
							// this focus lands on <body> and the next Tab restarts at the
							// top of the page (2.4.3). Both pages get it from here.
							await tick();
							document.getElementById('lookup-applied-artist')?.focus();
						}}
					>
						{m.admin_lookup_use_artist({ name: artist.name })}
					</button>
				{/if}
			{/snippet}
			<!-- The ambiguous row's Use button, in both places it renders. It keeps
			     its own label, because the radio list is what names the artist, but
			     it applies through the same two branches as the snippet above: it
			     used to leave the operator with an unchanged button and, once the
			     swap destroyed it, focus on <body> (2.4.3, 4.1.2). -->
			{#snippet useSelectedAction(primary: boolean)}
				{#if appliedArtist && pickedArtist && appliedArtist.id === pickedArtist.id}
					<button
						type="button"
						class="btn btn-secondary applied"
						id="lookup-applied-artist"
						onclick={useSelected}
					>
						<Check size={14} aria-hidden="true" />
						{m.admin_lookup_using_artist({ name: pickedArtist.name })}
					</button>
				{:else}
					<!-- Two or more candidates: the radio list above is the answer,
					     and this stays disabled until one of them is picked. -->
					<button
						type="button"
						class="btn {primary ? 'btn-primary' : 'btn-secondary'}"
						disabled={!picked}
						onclick={async () => {
							useSelected();
							await tick();
							document.getElementById('lookup-applied-artist')?.focus();
						}}
					>
						{m.admin_lookup_use_selected()}
					</button>
				{/if}
			{/snippet}
			{#if lookup.kind === 'searching'}
				<button type="button" class="btn btn-secondary" onclick={oncancel}>
					{m.admin_lookup_cancel()}
				</button>
			{:else if lookup.kind === 'no_match'}
				<button type="button" class="btn btn-secondary" onclick={onretry}>{m.admin_lookup_try_again()}</button>
				<!-- The spec's third no_match action: nothing matched, so the way
				     forward is the artist by hand. An empty handle seeds nothing. -->
				<button
					type="button"
					class="btn btn-secondary"
					onclick={() => onaddnew({ handle: '', site: 'FurAffinity', linkable: false })}
				>
					{m.admin_upload_add_new_artist()}
				</button>
				<button type="button" class="btn btn-secondary" onclick={() => onclose()}>{m.admin_lookup_close()}</button>
			{:else if lookup.kind === 'failed'}
				{#if lookup.reason === 'key_refused' || lookup.reason === 'no_key'}
					<!-- A new tab, like the match links above: both pages that mount this
					     panel hold unsaved work — an upload batch, an edit in progress —
					     and navigating them away to fix the key would discard it. -->
					<a
						class="btn btn-secondary"
						href="/admin/settings?tab=connections"
						target="_blank"
						rel="noopener noreferrer"
						>{m.admin_lookup_open_settings()}<span class="sr-only"
							>{' '}{m.link_opens_new_tab()}</span
						></a
					>
				{:else if lookup.reason === 'rate_limited' || lookup.reason === 'unavailable'}
					<button type="button" class="btn btn-secondary" onclick={onretry}>{m.admin_lookup_try_again()}</button>
				{/if}
				<button type="button" class="btn btn-secondary" onclick={() => onclose()}>{m.admin_lookup_close()}</button>
			{:else if data}
				{#if clash}
					{#if !variantBlocked}
						<button type="button" class="btn btn-primary" onclick={() => onaddvariant(clash)}>
							{m.admin_lookup_clash_add_variant()}
						</button>
					{/if}
					{#if outcome === 'ambiguous'}
						{@render useSelectedAction(false)}
					{:else if candidates[0]}
						<!-- Secondary: "Add as a variant" above is this row's primary. -->
						{@render useArtistAction(candidates[0], false)}
					{/if}
					<!-- A text link, not a third button: the row reads primary,
					     secondary, link, so "Add as a variant" is visibly the action. -->
					<a class="text-action" href="/admin/images/{clash.imageId}/edit" target="_blank" rel="noopener noreferrer">
						{m.admin_lookup_clash_open({ title: clash.title })}<span class="sr-only"
							>{' '}{m.link_opens_new_tab()}</span
						>
					</a>
				{:else if outcome === 'existing' && candidates[0]}
					{@render useArtistAction(candidates[0], true)}
				{:else if outcome === 'ambiguous'}
					{@render useSelectedAction(true)}
				{:else if outcome === 'new' && prefill}
					{#if nameHits.length}
						<!-- The same snippet as the other two rows: rendered as its own
						     button this one never swapped to "Using {name}", so applying a
						     name-matched artist looked like nothing happened, and it kept
						     no landing spot for the focus the swap destroys. -->
						{@render useArtistAction(nameHits[0], true)}
						<button
							type="button"
							class="btn btn-secondary"
							onclick={() => onaddnew({ handle, site: prefill.site, linkable: true })}
						>
							{m.admin_lookup_add_instead()}
						</button>
					{:else}
						<button
							type="button"
							class="btn btn-primary"
							onclick={() => onaddnew({ handle, site: prefill.site, linkable: true })}
						>
							{m.admin_lookup_add_new({ handle })}
						</button>
					{/if}
				{:else if outcome === 'unlinked' && prefill}
					<button
						type="button"
						class="btn btn-primary"
						onclick={() => onaddnew({ handle, site: prefill.site, linkable: false })}
					>
						{m.admin_lookup_add_new({ handle })}
					</button>
				{/if}
				<button type="button" class="btn btn-secondary" onclick={() => onclose()}>{m.admin_lookup_close()}</button>
			{/if}
		</div>
		{/if}
</div>

<style>
	.lookup-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--card);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	/* Idle: no card, no space, but the live region above still exists so the
	   first message written into it is announced. Not display:none — a hidden
	   region is not a region a screen reader watches. */
	.lookup-panel.idle {
		border: 0;
		padding: 0;
		gap: 0;
	}
	.lookup-eyebrow {
		font-family: var(--font-primary);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--muted-foreground);
		margin-bottom: 12px;
	}
	/* The file name is a file name, not a label — it keeps its own casing. */
	.eyebrow-file {
		text-transform: none;
		letter-spacing: 0;
	}
	.lookup-eyebrow.warn {
		color: var(--status-warn);
	}
	.lookup-lead {
		font-size: 14px;
		color: var(--foreground);
		line-height: 1.55;
		margin: 0 0 10px;
		max-width: 62ch;
	}
	.lookup-status {
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.55;
		margin: 10px 0 0;
		max-width: 62ch;
	}
	/* A report of a change the operator's fields just made, not the advice the
	   muted status lines carry — at the hint's colour it reads as something to
	   consider rather than as something that happened. */
	.lookup-emptied {
		color: var(--foreground);
	}
	/* On the no-match and failed arms it lands under the lead that explains the
	   result, and on the searching arm under the progress line, a point of size
	   apart and margin-collapsed to the same 10px every status line sits at —
	   two subjects reading as one paragraph. Only there: under a result it
	   follows the outcome lines it belongs with. */
	.lookup-lead + .lookup-emptied,
	.searching-line + .lookup-emptied {
		margin-top: 18px;
	}
	/* The searching line carries the spinner, so it lines up with its text. */
	.searching-line {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* A busy indicator is still motion: stop it for anyone who asked the OS to. */
	@media (prefers-reduced-motion: reduce) {
		.searching-line :global(.spin) {
			animation: none;
		}
	}

	.private-notice {
		font-size: 13px;
		color: var(--status-warn);
		line-height: 1.55;
		margin: 10px 0 0;
		max-width: 62ch;
	}
	.skeletons {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.skeleton {
		height: 14px;
		border-radius: var(--radius-xs);
		background: var(--secondary);
	}
	.skeleton:nth-child(2) {
		width: 80%;
	}
	.skeleton:nth-child(3) {
		width: 60%;
	}
	.clash-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}
	.clash-thumb {
		width: 44px;
		height: 44px;
		object-fit: cover;
		border-radius: var(--radius-xs);
		flex: none;
	}
	.clash-id {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.clash-title {
		font-size: 14px;
		color: var(--foreground);
	}
	.clash-meta {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.match-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.match-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.match-site {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-foreground);
		width: 2.2em;
		flex: none;
		/* Baseline-aligned row: nudge the mark onto the text's baseline. */
		align-self: center;
	}
	.match-id {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}
	.match-who {
		font-size: 14px;
		color: var(--foreground);
	}
	.match-who.muted {
		color: var(--muted-foreground);
	}
	.match-meta {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.match-link {
		font-size: 13px;
		color: var(--link);
		flex: none;
	}
	.outcome {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		color: var(--foreground);
		margin: 0;
		line-height: 1.5;
	}
	.callout {
		font-size: 13px;
		color: var(--muted-foreground);
		border-left: 2px solid var(--border);
		padding-left: 10px;
		margin: 10px 0 0;
	}
	.pick-list {
		border: 0;
		margin: 10px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.pick-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}
	.pick-meta {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.lookup-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	/* "Use selected artist" is disabled until a radio is picked, and a
	   full-strength primary button that does nothing reads as broken. Same
	   pattern as .form-actions button:disabled on the upload page. */
	.lookup-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.text-action {
		font-size: 13px;
		color: var(--link);
	}

	.lookup-actions .applied {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
</style>
