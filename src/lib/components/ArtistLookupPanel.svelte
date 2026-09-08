<script lang="ts">
	// The "Look up artist" result panel (SONA-156), shared by the upload page and
	// the image edit page. It renders a lookup's state and reports what the
	// operator chose; it owns no form fields of its own — every prefill and every
	// artist change happens in the page, so the two pages keep their own idea of
	// what "empty" means and what a click may overwrite.
	import { Check, Info, Loader2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import {
		bandLabel,
		candidateArtists,
		isCrossSiteAmbiguity,
		matchHandle,
		matchHandles,
		nameMatchArtists,
		pickPrefillMatch,
		postDateToInput,
		ratingLabel,
		resolveOutcome,
		siteLabel,
		statusLineKind,
		type ArtistChoice,
		type LookupFields,
		type LookupSite,
		type LookupState,
		type SourceClash
	} from '$lib/artist-lookup';

	interface Props {
		lookup: LookupState;
		/** Multi-tile only: the parent tile's file name, appended to the eyebrow. */
		fileName?: string;
		/** What the page's prefill actually wrote, for the status line. */
		filled?: LookupFields;
		/** The artist currently applied from this result, if any. */
		appliedArtist?: { id: number; name: string } | null;
		/** The image is private and the file went out anyway — say so. */
		privateNotice?: boolean;
		/** The edit page fills only empty fields and never touches the artist, so
		 * its status line says what it left alone rather than what it changed. */
		editMode?: boolean;
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
		appliedArtist = null,
		privateNotice = false,
		editMode = false,
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
	const nameHits = $derived(data ? nameMatchArtists(data) : []);
	const clash = $derived(data?.sourceClash ?? null);
	const siteCount = $derived(data ? new Set(data.matches.map((x) => x.site)).size : 0);
	const statusKind = $derived(statusLineKind(filled, { clash: !!clash }));
	// "Uploaded {date} · {artist}", with either half dropped when the row has no
	// answer for it rather than spelled out as a blank.
	const clashMeta = $derived.by(() => {
		if (!clash) return '';
		const parts: string[] = [];
		const date = postDateToInput(clash.uploadedAt);
		if (date) parts.push(m.admin_lookup_clash_uploaded({ date }));
		if (clash.artistName) parts.push(clash.artistName);
		return parts.join(' · ');
	});

	// The ambiguous state's radio list. Reset whenever the result changes so a
	// stale pick can't be applied to a different lookup.
	let picked = $state('');
	$effect(() => {
		void data;
		picked = '';
	});

	function useSelected() {
		const artist = candidates.find((c) => String(c.id) === picked);
		if (artist) onuseartist({ id: artist.id, name: artist.name });
	}

	/** The metadata line under a result row, with unknown segments dropped
	 * rather than spelled out as blanks. */
	function metaFor(match: { band: string | null; postedAt: string | null; rating: string | null }) {
		const parts: string[] = [];
		const band = bandLabel(match.band as never);
		if (band) parts.push(band);
		const date = postDateToInput(match.postedAt);
		if (date) parts.push(m.admin_lookup_posted({ date }));
		if (match.rating) parts.push(ratingLabel(match.rating as never));
		return parts.join(' · ');
	}
</script>

{#if lookup.kind !== 'idle'}
	<div class="lookup-panel" role="region" aria-label={m.admin_lookup_panel_label()}>
		<div class="lookup-body" role="status">
			{#if lookup.kind === 'searching'}
				<div class="lookup-eyebrow">{m.admin_lookup_searching_eyebrow()}</div>
				<div class="skeletons" aria-hidden="true">
					<span class="skeleton"></span>
					<span class="skeleton"></span>
					<span class="skeleton"></span>
				</div>
				<p class="lookup-status">{m.admin_lookup_searching_body()}</p>
			{:else if lookup.kind === 'no_match'}
				<div class="lookup-eyebrow">{m.admin_lookup_no_match_eyebrow()}</div>
				<p class="lookup-lead">{m.admin_lookup_no_match_body()}</p>
				<p class="lookup-status">{m.admin_lookup_no_match_hint()}</p>
			{:else if lookup.kind === 'failed'}
				{#if lookup.reason === 'rate_limited'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_paused_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_paused_body()}</p>
					<p class="lookup-status">{m.admin_lookup_paused_hint()}</p>
				{:else if lookup.reason === 'key_refused'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_refused_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_refused_body()}</p>
					<p class="lookup-status">{m.admin_lookup_refused_hint()}</p>
				{:else if lookup.reason === 'too_large'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_too_large_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_too_large_body()}</p>
				{:else if lookup.reason === 'invalid_image'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_failed_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_invalid_body()}</p>
				{:else if lookup.reason === 'signed_out'}
					<div class="lookup-eyebrow warn">{m.admin_lookup_signed_out_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_signed_out_body()}</p>
				{:else}
					<div class="lookup-eyebrow">{m.admin_lookup_failed_eyebrow()}</div>
					<p class="lookup-lead">{m.admin_lookup_failed_body()}</p>
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
					<p class="lookup-lead">
						{m.admin_lookup_clash_body({
							site: siteLabel(prefill ? prefill.site : 'FurAffinity'),
							title: clash.title,
							variants:
								clash.variantCount > 0 ? m.admin_lookup_variants({ count: clash.variantCount }) : ''
						})}
					</p>
				{:else}
					<div class="lookup-eyebrow">
						{m.admin_lookup_found_on_sites({ count: siteCount })}{#if fileName}
							<span class="eyebrow-file">{m.admin_lookup_eyebrow_file({ fileName })}</span>
						{/if}
					</div>
				{/if}

				<ul class="match-list">
					{#each data.matches as match (match.site + match.siteId)}
						{@const handles = matchHandles(match)}
						<li class="match-row">
							<span class="match-site" aria-hidden="true">{match.site.slice(0, 2)}</span>
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

				{#if !clash}
					{#if outcome === 'existing'}
						<p class="outcome">
							<Check size={14} aria-hidden="true" />
							{m.admin_lookup_existing({ handle, name: candidates[0]?.name ?? '' })}
						</p>
					{:else if outcome === 'ambiguous'}
						<p class="outcome">
							<Info size={14} aria-hidden="true" />
							{isCrossSiteAmbiguity(data)
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
									{#if isCrossSiteAmbiguity(data)}
										<span class="pick-meta">{m.admin_lookup_via_site({ site: siteLabel(candidate.site) })}</span>
									{/if}
								</label>
							{/each}
						</fieldset>
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

				{#if statusKind !== 'none' && prefill}
					<p class="lookup-status">
						{#if statusKind === 'both'}
							{m.admin_lookup_status_both({ site: siteLabel(prefill.site) })}
						{:else if statusKind === 'url_only'}
							{m.admin_lookup_status_url_only({ site: siteLabel(prefill.site) })}
						{:else if statusKind === 'clash'}
							{m.admin_lookup_status_clash({ site: siteLabel(prefill.site), title: clash?.title ?? '' })}
						{:else if editMode}
							{m.admin_lookup_status_kept({ site: siteLabel(prefill.site) })}
						{:else}
							{m.admin_lookup_status_date_only({ site: siteLabel(prefill.site) })}
						{/if}
						{#if editMode && outcome === 'existing' && !appliedArtist && candidates[0]}
							{m.admin_lookup_status_artist_hint({ name: candidates[0].name })}
						{/if}
					</p>
				{/if}
			{/if}

			{#if privateNotice}
				<p class="private-notice">{m.admin_lookup_private_notice()}</p>
			{/if}
		</div>

		<div class="lookup-actions">
			{#if lookup.kind === 'searching'}
				<button type="button" class="btn btn-secondary" onclick={oncancel}>
					<Loader2 size={14} class="spin" aria-hidden="true" />
					{m.admin_lookup_cancel()}
				</button>
			{:else if lookup.kind === 'no_match'}
				<button type="button" class="btn btn-secondary" onclick={onretry}>{m.admin_lookup_try_again()}</button>
				<button type="button" class="btn btn-secondary" onclick={onclose}>{m.admin_lookup_close()}</button>
			{:else if lookup.kind === 'failed'}
				{#if lookup.reason === 'key_refused'}
					<a class="btn btn-secondary" href="/admin/settings?tab=connections">{m.admin_lookup_open_settings()}</a>
				{:else if lookup.reason === 'rate_limited' || lookup.reason === 'unavailable'}
					<button type="button" class="btn btn-secondary" onclick={onretry}>{m.admin_lookup_try_again()}</button>
				{/if}
				<button type="button" class="btn btn-secondary" onclick={onclose}>{m.admin_lookup_close()}</button>
			{:else if data}
				{#if clash}
					<button type="button" class="btn btn-primary" onclick={() => onaddvariant(clash)}>
						{m.admin_lookup_clash_add_variant()}
					</button>
					{#if candidates[0]}
						<button type="button" class="btn btn-secondary" onclick={() => onuseartist(candidates[0])}>
							{m.admin_lookup_use_artist({ name: candidates[0].name })}
						</button>
					{/if}
					<a class="btn btn-secondary" href="/admin/images/{clash.imageId}/edit" target="_blank" rel="noopener noreferrer">
						{m.admin_lookup_clash_open({ title: clash.title })}
					</a>
				{:else if outcome === 'existing' && candidates[0]}
					{#if appliedArtist && appliedArtist.id === candidates[0].id}
						<button type="button" class="btn btn-secondary applied" onclick={() => onuseartist(candidates[0])}>
							<Check size={14} aria-hidden="true" />
							{m.admin_lookup_using_artist({ name: candidates[0].name })}
						</button>
					{:else}
						<button type="button" class="btn btn-primary" onclick={() => onuseartist(candidates[0])}>
							{m.admin_lookup_use_artist({ name: candidates[0].name })}
						</button>
					{/if}
				{:else if outcome === 'ambiguous'}
					<button type="button" class="btn btn-primary" disabled={!picked} onclick={useSelected}>
						{m.admin_lookup_use_selected()}
					</button>
				{:else if outcome === 'new' && prefill}
					{#if nameHits.length}
						<button type="button" class="btn btn-primary" onclick={() => onuseartist(nameHits[0])}>
							{m.admin_lookup_use_artist({ name: nameHits[0].name })}
						</button>
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
				<button type="button" class="btn btn-secondary" onclick={onclose}>{m.admin_lookup_close()}</button>
			{/if}
		</div>
	</div>
{/if}

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
		font-family: var(--font-primary);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		width: 2.2em;
		flex: none;
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
	.lookup-actions .applied {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
</style>
