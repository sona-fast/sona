<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick, untrack } from 'svelte';
	import { Loader2, Search } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import ArtistLookupPanel from '$lib/components/ArtistLookupPanel.svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import {
		lookupSentFile,
		newArtistSeed,
		prefillForResult,
		ratingTag,
		seedStatusKind,
		runLookup,
		strictestRating,
		type LookupFields,
		type LookupSite,
		type LookupState,
		type NewArtistSeed,
		type SourceClash
	} from '$lib/artist-lookup';

	let { data, form } = $props();

	let artistMode = $state<'existing' | 'new'>('existing');
	let saving = $state(false);
	let selectedParentId = $state(String(data.image.parentImageId ?? ''));
	// The reference button swaps between set/clear on toggle; move focus back to it
	// so keyboard/screen-reader users hear the new state instead of losing focus.
	let referenceButton = $state<HTMLButtonElement | null>(null);
	// Clearing a variant's designation leaves no button to return to (the variant
	// hint replaces it), so focus lands on the hint and the live region carries an
	// explicit message — an emptied region announces nothing.
	let referenceHint = $state<HTMLElement | null>(null);
	let referenceCleared = $state(false);

	// ---- Artist lookup (SONA-156) -------------------------------------------
	// The bytes are on the storage host, and the CSP blocks the browser from
	// reading them (docs/reading-image-bytes.md), so the request names the image
	// by id and the server fetches it. Nothing is filled that already has a
	// value, and the artist only changes on an explicit click.
	let lookup = $state<LookupState>({ kind: 'idle' });
	let lookupFilled = $state<LookupFields>({});
	// Held-ness of the source post URL at the moment the prefill ran, beside the
	// record of what it wrote. Read live, the clash sentence flips as the operator
	// types: clearing a pasted URL afterwards would make the panel say Sona left
	// the field empty, which the operator did, not Sona.
	let lookupUrlHeld = $state(false);
	// Read once, like every other form seed on this page: these are the values
	// the form OPENS with, and a later `data` change must not throw away what the
	// operator has typed. untrack is the documented spelling for that.
	let sourcePostUrl = $state(untrack(() => data.image.sourcePostUrl || ''));
	let commissionedAt = $state(untrack(() => data.image.commissionedAt || ''));
	// Number, not a string: the option values are numbers and the select binding
	// compares with Object.is.
	let selectedArtistId = $state<string | number>(untrack(() => data.image.artistId ?? ''));
	// An artist the lookup names can be one created in another tab since this
	// page loaded, with no option in the select. They are appended here so "Use
	// {name}" has something to select — `data.artists` is left untouched, the
	// same shape the upload page's list has.
	let artistList = $state<{ id: number; name: string }[]>(
		untrack(() => data.artists.map((a) => ({ id: a.id, name: a.name })))
	);
	let sourceTagged = $state(false);
	let dateTagged = $state(false);
	let appliedArtist = $state<{ id: number; name: string } | null>(null);
	let artistName = $state('');
	let newTwitter = $state('');
	let newFuraffinity = $state('');
	// What the last seed wrote into the inline new-artist form, for the panel's
	// status line, plus the tag on each field it filled.
	let lookupSeeded = $state<NewArtistSeed>({});
	let nameTagged = $state(false);
	let twitterTagged = $state(false);
	let furaffinityTagged = $state(false);
	// Both records above are written once per lookup and never edited: they say
	// what the lookup did. Whether a filled field is still attributable to it is
	// the tag's job, and these read the two together so the status lines name
	// only the fields the operator has not typed over (SONA-156). The seed writes
	// its link to whichever of the two social fields matches the site, so either
	// tag standing means the seeded link is still the lookup's.
	const lookupEdited = $derived({
		sourcePostUrl: lookupFilled.sourcePostUrl !== undefined && !sourceTagged,
		commissionedAt: lookupFilled.commissionedAt !== undefined && !dateTagged
	});
	const lookupSeedEdited = $derived({
		artistName: lookupSeeded.artistName !== undefined && !nameTagged,
		profileUrl: lookupSeeded.profileUrl !== undefined && !twitterTagged && !furaffinityTagged
	});
	let lookupAbort: AbortController | null = null;
	// The artist select sits above the panel and the panel's own status region
	// does not change when an artist is applied, so this is the only thing that
	// reports it (4.1.3).
	const announcer = new Announcer();
	// Closing or cancelling the panel destroys the button the operator is
	// standing on, so focus is moved back here first (2.4.3).
	let lookupPill = $state<HTMLButtonElement | null>(null);
	let parentSelect = $state<HTMLSelectElement | null>(null);
	// Parent options the page did not load with, added by "Add as a variant" for a
	// clash piece that postdates this page. Same shape as data.parentCandidates.
	let extraParents = $state<{ id: number; title: string }[]>([]);
	const parentOptions = $derived([...data.parentCandidates, ...extraParents]);
	// The flip replaces the artist select with this field. When the seed left it
	// empty there is nothing to read and the announcement says to type the name,
	// so focus lands where that typing goes (2.4.3).
	let artistNameInput = $state<HTMLInputElement | null>(null);

	// SvelteKit reuses this component across a route-param change, so the seeds
	// above describe the PREVIOUS image after an in-app move between two edit
	// pages. Re-read them, and drop every lookup flag that rode along with them.
	let seededImageId = untrack(() => data.image.id);
	$effect(() => {
		const id = data.image.id;
		if (id === seededImageId) return;
		seededImageId = id;
		untrack(() => resetForImage());
	});

	function resetForImage() {
		lookupAbort?.abort();
		lookupAbort = null;
		lookup = { kind: 'idle' };
		lookupFilled = {};
		lookupSeeded = {};
		sourcePostUrl = data.image.sourcePostUrl || '';
		commissionedAt = data.image.commissionedAt || '';
		selectedArtistId = data.image.artistId ?? '';
		artistList = data.artists.map((a) => ({ id: a.id, name: a.name }));
		selectedParentId = String(data.image.parentImageId ?? '');
		isPrivate = !data.image.published;
		extraParents = [];
		artistMode = 'existing';
		artistName = '';
		newTwitter = '';
		newFuraffinity = '';
		sourceTagged = false;
		dateTagged = false;
		nameTagged = false;
		twitterTagged = false;
		furaffinityTagged = false;
		lookupUrlHeld = false;
		appliedArtist = null;
	}

	// The image is not published, so "look this up" means "send a private file to
	// a third party" — say so before the click and again after it. Bound to the
	// checkbox rather than derived from the saved row: an operator who ticks
	// Private and then runs the lookup is about to send an unpublished file, and
	// a disclosure keyed on the row would say nothing until the save.
	let isPrivate = $state(untrack(() => !data.image.published));
	// Either half makes the file one no visitor can see: the stored row is what
	// hides it today, the checkbox is the operator's intent to hide it at the
	// next save. Unticking Private on a row that is still unpublished does not
	// turn the lookup into a public-file lookup.
	const sendingPrivate = $derived(!data.image.published || isPrivate);
	// What the file that ACTUALLY went out was, read when the request fired. The
	// hint above the button is about the next click, so it stays live; the notice
	// under a finished lookup describes a send that already happened, and reading
	// the checkbox live let a tick made after the click rewrite that history.
	let sentPrivate = $state(false);
	const ratingTagText = $derived(
		lookup.kind === 'results' ? ratingTag(strictestRating(lookup.data.matches)) : null
	);

	/** Undo what the PREVIOUS lookup wrote, but only where the operator has not
	 * typed over it since — the tag is the record of that. Without this a second
	 * lookup reads the first one's URL as operator-typed, fills nothing, and
	 * leaves a "From lookup" tag on a value from the other post. The upload
	 * page's resetSharedPrefill, plus the inline new-artist fields this page
	 * owns. */
	function resetLookupPrefill() {
		if (sourceTagged) sourcePostUrl = '';
		if (dateTagged) commissionedAt = '';
		if (nameTagged) artistName = '';
		if (twitterTagged) newTwitter = '';
		if (furaffinityTagged) newFuraffinity = '';
		// The mode is left alone. Flipping back to the artist select unmounts the
		// inline form, and five of its inputs (Bluesky, Telegram, DeviantArt,
		// Patreon, Instagram) are uncontrolled — anything typed there goes with
		// the form. An empty required form is a smaller cost than lost typing,
		// and the clearing announcement in startLookup says what happened.
		sourceTagged = false;
		dateTagged = false;
		nameTagged = false;
		twitterTagged = false;
		furaffinityTagged = false;
		lookupFilled = {};
		lookupSeeded = {};
		lookupUrlHeld = false;
		appliedArtist = null;
		// A clash carried into the parent select belongs to the lookup that found
		// it, so a second lookup must not leave the first one's piece on offer. The
		// one the operator actually chose stays: dropping it would silently blank
		// the select and save no parent, which is what carrying it in prevented.
		extraParents = extraParents.filter((c) => String(c.id) === selectedParentId);
	}

	function startLookup() {
		if (lookup.kind === 'searching') return;
		// The reset empties inline new-artist fields the last lookup filled while
		// the form stays on screen, so a sighted operator watches them empty and a
		// screen-reader one gets nothing. Say it with the searching announcement.
		const clearedInline =
			artistMode === 'new' && (nameTagged || twitterTagged || furaffinityTagged);
		resetLookupPrefill();
		lookupAbort?.abort();
		const controller = new AbortController();
		lookupAbort = controller;
		lookup = { kind: 'searching' };
		sentPrivate = sendingPrivate;
		if (clearedInline) announcer.say(m.admin_lookup_announce_searching_cleared());
		void runLookup({ imageId: data.image.id }, { signal: controller.signal }).then((next) => {
			if (lookupAbort !== controller) return;
			lookupAbort = null;
			lookup = next;
			applyPrefill(next);
		});
	}

	function cancelLookup() {
		lookupAbort?.abort();
		lookupAbort = null;
		closeLookup();
	}

	/** Fields only. A handle with no local artist behind it is not a reason to
	 * change this image's artist: the panel offers "Add {handle} as a new
	 * artist", and only that click flips the form and seeds it — the same rule
	 * the upload page's "Use {name}" follows. Flipping here would seed a
	 * duplicate artist behind the operator's back and re-credit a piece that
	 * already has one. */
	function applyPrefill(next: LookupState) {
		if (next.kind !== 'results') return;
		// A new result describes a new seed, even when that seed is empty.
		lookupSeeded = {};
		lookupUrlHeld = sourcePostUrl.trim() !== '';
		const fields = prefillForResult(next.data, { sourcePostUrl, commissionedAt });
		lookupFilled = fields;
		if (fields.sourcePostUrl !== undefined) {
			sourcePostUrl = fields.sourcePostUrl;
			sourceTagged = true;
		}
		if (fields.commissionedAt !== undefined) {
			commissionedAt = fields.commissionedAt;
			dateTagged = true;
		}
	}

	/** The inline new-artist form obeys the same rule as the two fields above:
	 * a lookup is a suggestion, so it fills only what is empty, tags what it
	 * filled, and the tag clears the moment the operator edits that field. */
	function seedNewArtist(handle: string, site: LookupSite, linkable: boolean): NewArtistSeed {
		const url = site === 'Twitter' ? newTwitter : newFuraffinity;
		const seed = newArtistSeed(handle, site, linkable, {
			artistName: artistName.trim() === '',
			profileUrl: url.trim() === ''
		});
		// Merged field by field, never replaced. A second click on the same result
		// seeds nothing, because the first click already filled the fields it was
		// allowed to touch, and overwriting the record with that empty seed would
		// retract the sentence describing what the FIRST click wrote — and the
		// guess disclosure with it — while the values and their "From lookup" tags
		// stay on screen. A partial re-seed (the operator cleared the name, then
		// clicked again) is the same retraction one field narrower: it writes the
		// name only, and a replaced record would drop the profile URL while that
		// field keeps its value and its tag.
		lookupSeeded = { ...lookupSeeded, ...seed };
		if (seed.artistName !== undefined) {
			artistName = seed.artistName;
			nameTagged = true;
		}
		if (seed.profileUrl !== undefined) {
			if (site === 'Twitter') {
				newTwitter = seed.profileUrl;
				twitterTagged = true;
			} else {
				newFuraffinity = seed.profileUrl;
				furaffinityTagged = true;
			}
		}
		// What THIS click wrote. The caller announces on it rather than on the
		// merged record, which survives a click that wrote nothing and would
		// therefore report the first click's work as this one's.
		return seed;
	}

	function useLookupArtist(artist: { id: number; name: string }) {
		artistMode = 'existing';
		// The options were built when the page loaded. An artist created in another
		// tab since then comes back as a candidate with no option of their own, so
		// the button would flip to "Using {name}" over an empty select and the save
		// would be refused by `required`.
		// Unlike a clash parent carried into the variant select, this option stays
		// through the next lookup: an artist is a global record, so once it is known
		// it belongs in the list, while a clash is one result's finding about this
		// image.
		if (!artistList.some((a) => a.id === artist.id)) {
			artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		}
		selectedArtistId = artist.id;
		appliedArtist = artist;
		announcer.say(m.admin_lookup_announce_using({ name: artist.name }));
	}

	async function addAsVariant(clash: SourceClash) {
		// The options were built when the page loaded. A clash piece uploaded in
		// another tab since then has none, so the select would fall back to blank
		// with the panel already closed: the operator asked for a variant and would
		// silently save none. Carry the clash in as its own option first.
		if (!parentOptions.some((c) => c.id === clash.imageId)) {
			extraParents = [...extraParents, { id: clash.imageId, title: clash.title }];
		}
		selectedParentId = String(clash.imageId);
		lookup = { kind: 'idle' };
		// The click unmounted its own button; land on the select it just set.
		await tick();
		parentSelect?.focus();
	}

	/** Close and Cancel destroy the button the operator is on, so focus goes
	 * back to the control the lookup started from. */
	function closeLookup() {
		lookup = { kind: 'idle' };
		lookupPill?.focus();
	}
</script>

<LiveAnnouncer {announcer} />

<div class="page-header">
	<h1>{m.admin_image_edit_title()}</h1>
</div>

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

<div class="edit-layout">
	<div class="edit-sidebar">
		<div class="image-preview">
			<img src={data.image.imageUrl} alt={data.image.title} />
		</div>

		{#if data.ownerCharacter}
			<form method="POST" action="?/reference" use:enhance={() => {
				return async ({ update, result }) => {
					// The action already reports which way it went — deriving it here
					// keeps the flag honest when the submit was a set, not a clear.
					if (result.type === 'success') referenceCleared = result.data?.referenceCleared === true;
					await update();
					await tick();
					if (result.type === 'success') (referenceButton ?? referenceHint)?.focus();
				};
			}} class="reference-control">
				<!-- Persistent live region: text toggles in place (rather than the node
				     being inserted/removed) so NVDA/JAWS announce the state change reliably. -->
				<p class="reference-current" role="status">
					{#if data.ownerCharacter.isReference}✓ {m.admin_image_reference_current({ name: data.ownerCharacter.name })}{:else if referenceCleared}{m.admin_image_reference_cleared()}{/if}
				</p>
				{#if data.ownerCharacter.isReference}
					<input type="hidden" name="clear" value="on" />
					<button bind:this={referenceButton} type="submit" class="btn btn-secondary reference-btn">{m.admin_image_reference_clear()}</button>
					{#if data.image.parentImageId != null}
						<!-- A designation made before the variant rule existed: the row still
						     says it is the reference sheet, but /art has stopped showing it.
						     Say so here, or the admin claims a sheet the public page drops. -->
						<small class="hint">{m.admin_image_reference_variant()}</small>
					{/if}
				{:else if data.image.parentImageId != null}
					<!-- /art excludes variants from both ref-sheet paths (SONA-18), so
					     offering the control here would promise something the public
					     page ignores. The clear branch above stays reachable for a
					     variant designated before that rule existed. tabindex="-1": the
					     focus target when clearing removes the button, never a tab stop. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<small bind:this={referenceHint} tabindex="-1" class="hint">{m.admin_image_reference_variant()}</small>
				{:else}
					<button bind:this={referenceButton} type="submit" class="btn btn-secondary reference-btn">{m.admin_image_reference_set({ name: data.ownerCharacter.name })}</button>
					{#if data.ownerCharacter.replacesOther}
						<small class="hint">{m.admin_image_reference_replaces()}</small>
					{/if}
				{/if}
			</form>
		{/if}
	</div>

	<form method="POST" action="?/save" use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update();
			saving = false;
		};
	}} class="edit-form">
		<label>
			<span>{m.admin_field_title()}</span>
			<input type="text" class="input" name="title" value={data.image.title} required />
		</label>

		<fieldset class="artist-section">
			<legend>{m.admin_field_artist()}</legend>
			<div class="artist-toggle-row">
			<div class="artist-toggle">
				<button
					type="button"
					class="toggle-btn"
					class:active={artistMode === 'existing'}
					onclick={() => (artistMode = 'existing')}
				>
					{m.admin_upload_select_existing()}
				</button>
				<button
					type="button"
					class="toggle-btn"
					class:active={artistMode === 'new'}
					onclick={() => (artistMode = 'new')}
				>
					{m.admin_upload_add_new_artist()}
				</button>
			</div>
			{#if data.lookupEnabled}
				<!-- Pushed to the end of the row: flush against the two-segment
				     toggle it reads as a third segment of that control. -->
				<button
					type="button"
					class="lookup-pill"
					bind:this={lookupPill}
					aria-describedby="lookup-hint"
					aria-disabled={lookup.kind === 'searching'}
					onclick={startLookup}
				>
					<Search size={14} aria-hidden="true" /> {m.admin_lookup_button()}
				</button>
			{/if}
			</div>
			{#if data.lookupEnabled}
				<small class="hint" class:hint-warn={sendingPrivate} id="lookup-hint">
					{sendingPrivate ? m.admin_lookup_hint_private() : m.admin_lookup_hint()}
				</small>
			{:else}
				<small class="hint" id="lookup-hint">
					{m.admin_lookup_no_key_pre()}<a class="link" href="/admin/settings?tab=connections"
						>{m.admin_lookup_no_key_link()}</a
					>{m.admin_lookup_no_key_post()}
				</small>
			{/if}

			{#if data.lookupEnabled}
				<!-- No key means no lookup can ever start, so the panel's empty
				     landmark and the gap it holds open earn nothing (SONA-156). -->
				<ArtistLookupPanel
					{lookup}
					filled={lookupFilled}
					edited={lookupEdited}
					seeded={lookupSeeded}
					seedEdited={lookupSeedEdited}
					sourceUrlHeld={lookupUrlHeld}
					{appliedArtist}
					editMode
					variantBlocked={data.hasVariants}
					privateNotice={sentPrivate && lookupSentFile(lookup)}
					onclose={closeLookup}
					onretry={startLookup}
					oncancel={cancelLookup}
					onuseartist={useLookupArtist}
					onaddnew={async (seed) => {
						// Only this click flips the form. The operator may have opened the
						// inline form by hand before the lookup, though, and then nothing
						// switched — say it only when this click is what did.
						const wasExisting = artistMode === 'existing';
						artistMode = 'new';
						const wrote = seedNewArtist(seed.handle, seed.site, seed.linkable);
						// A seed that wrote something is announced by the panel's own status
						// line. An empty handle (the no_match action) writes nothing, so the
						// select is replaced by a name field with nothing said about it.
						// Judged by what THIS click wrote: the record keeps the previous
						// seed, so reading it would call a click that wrote nothing a
						// success and leave a second click unanswered.
						const seededNothing = seedStatusKind(wrote) === 'none';
						if (wasExisting && seededNothing) announcer.say(m.admin_lookup_announce_new_form());
						// The form was already open, the seed had both a handle and a link
						// to offer, and the fields hold the operator's own values: this
						// click wrote nothing because what it carried was already spoken
						// for. An empty name field is the one case this sentence would be
						// false in, and there the focus move below is the answer.
						else if (seededNothing && seed.handle && seed.linkable && artistName.trim() !== '')
							announcer.say(m.admin_lookup_announce_seed_kept());
						// The no_match action carries no handle, and an unlinked site
						// (SONA-219) carries no profile URL, so in both cases fewer fields
						// were offered than "already have values, so Sona left them alone"
						// claims — the FurAffinity field it names is empty and was never a
						// candidate. The click still has to be answered, so say the state
						// it found the form in.
						else if (seededNothing && artistName.trim() !== '')
							announcer.say(m.admin_lookup_announce_form_already_open());
						// Nothing landed in the name field, and both sentences above tell the
						// operator to type it — so that is where focus goes.
						if (artistName.trim() === '') {
							await tick();
							artistNameInput?.focus();
						}
					}}
					onaddvariant={addAsVariant}
				/>
			{/if}

			{#if artistMode === 'existing'}
				<label>
					<span>{m.admin_field_artist()}</span>
					<select class="input" name="artistId" bind:value={selectedArtistId} onchange={() => (appliedArtist = null)} required>
						<option value="">{m.admin_upload_select_artist()}</option>
						{#each artistList as artist}
							<option value={artist.id}>{artist.name}</option>
						{/each}
					</select>
				</label>
			{:else}
				<input type="hidden" name="artistId" value="new" />
				<!-- Same shape as the commissioned-date and source-URL fields: the
				     label wraps its own text, the "From lookup" tag is a sibling
				     reached through aria-describedby (SONA-220), and typing in the
				     field drops the tag. -->
				<div class="field">
					<div class="label-row">
						<label class="field-label" for="artistName">{m.admin_field_artist_name()}</label>
						{#if nameTagged}
							<span class="lookup-tag" id="artist-name-lookup-tag">{m.admin_lookup_from_lookup()}</span>
						{/if}
					</div>
					<input
						id="artistName"
						type="text"
						class="input"
						placeholder={m.admin_upload_artist_name_placeholder()}
						name="artistName"
						bind:this={artistNameInput}
						bind:value={artistName}
						oninput={() => (nameTagged = false)}
						aria-describedby={nameTagged ? 'artist-name-lookup-tag' : undefined}
						required
					/>
				</div>
				<div class="social-grid">
					<div class="field">
						<div class="label-row">
							<label class="field-label" for="new-artist-twitter">Twitter/X</label>
							{#if twitterTagged}
								<span class="lookup-tag" id="twitter-lookup-tag">{m.admin_lookup_from_lookup()}</span>
							{/if}
						</div>
						<input
							id="new-artist-twitter"
							type="text"
							class="input"
							placeholder={m.admin_social_handle_placeholder()}
							name="twitter"
							bind:value={newTwitter}
							oninput={() => (twitterTagged = false)}
							aria-describedby={twitterTagged ? 'twitter-lookup-tag' : undefined}
						/>
					</div>
					<label>
						<span>Bluesky</span>
						<input type="text" class="input" placeholder="bsky.app/profile/..." name="bluesky" />
					</label>
					<label>
						<span>Telegram</span>
						<input type="text" class="input" placeholder="t.me/..." name="telegram" />
					</label>
					<div class="field">
						<div class="label-row">
							<label class="field-label" for="new-artist-furaffinity">FurAffinity</label>
							{#if furaffinityTagged}
								<span class="lookup-tag" id="furaffinity-lookup-tag">{m.admin_lookup_from_lookup()}</span>
							{/if}
						</div>
						<input
							id="new-artist-furaffinity"
							type="text"
							class="input"
							placeholder="furaffinity.net/user/..."
							name="furaffinity"
							bind:value={newFuraffinity}
							oninput={() => (furaffinityTagged = false)}
							aria-describedby={furaffinityTagged ? 'furaffinity-lookup-tag' : undefined}
						/>
					</div>
					<label>
						<span>DeviantArt</span>
						<input type="text" class="input" placeholder="deviantart.com/..." name="deviantart" />
					</label>
					<label>
						<span>Patreon</span>
						<input type="text" class="input" placeholder="patreon.com/..." name="patreon" />
					</label>
					<label>
						<span>Instagram</span>
						<input type="text" class="input" placeholder="instagram.com/..." name="instagram" />
					</label>
				</div>
			{/if}
		</fieldset>

		<div class="row">
			<label class="flex-1">
				<span>{m.admin_field_collection()}</span>
				<select class="input" name="collectionId">
					<option value="">{m.admin_upload_no_collection()}</option>
					{#each data.collections as collection}
						<option value={collection.id} selected={collection.id === data.image.collectionId}>{collection.name}</option>
					{/each}
				</select>
			</label>
			<label class="flex-1">
				<span>{m.admin_field_tags()}</span>
				<input type="text" class="input" name="tags" value={data.imageTags.join(', ')} />
				{#if data.tags.length > 0}
					<small class="hint">{m.admin_upload_existing_tags({ tags: data.tags.map((t) => t.name).join(', ') })}</small>
				{/if}
			</label>
		</div>

		{#if data.hasVariants}
			<p class="hint">{m.admin_variant_parent_hint()}</p>
		{:else}
			<div class="row">
				<label class="flex-1">
					<span>{m.admin_field_variant_of()}</span>
					<select class="input" name="parentImageId" bind:this={parentSelect} bind:value={selectedParentId}>
						<option value="">{m.admin_variant_none()}</option>
						{#each parentOptions as candidate}
							<option value={String(candidate.id)}>{candidate.title}</option>
						{/each}
					</select>
				</label>
				{#if selectedParentId}
					<label class="flex-1">
						<span>{m.admin_field_variant_label()}</span>
						<input
							type="text"
							class="input"
							name="variantLabel"
							placeholder={m.admin_variant_label_placeholder()}
							value={data.image.variantLabel || ''}
						/>
					</label>
				{/if}
			</div>
		{/if}

		{#if data.characters.length > 0}
			<div class="field">
				<span class="field-label">{m.gallery_featured_characters()}</span>
				<div class="character-chips">
					{#each data.characters as char}
						<label class="chip">
							<input type="checkbox" name="char-{char.id}" checked={data.imageCharacterIds.includes(char.id)} onchange={(e) => {
								const el = document.querySelector('input[name="characters"]') as HTMLInputElement;
								const current = new Set(el.value.split(',').filter(Boolean));
								if (e.currentTarget.checked) current.add(String(char.id));
								else current.delete(String(char.id));
								el.value = Array.from(current).join(',');
							}} />
							<span>{char.name}</span>
							{#if char.ownerName}<span class="chip-owner">({char.ownerName})</span>{/if}
						</label>
					{/each}
				</div>
				<input type="hidden" name="characters" value={data.imageCharacterIds.join(',')} />
			</div>
		{/if}

		<!-- The label wraps only its own text; the "From lookup" pill sits after it
		     as a sibling and is referenced with aria-describedby, so the input's
		     accessible name stays the field name (SONA-220). -->
		<div class="field">
			<div class="label-row">
				<label class="field-label" for="commissionedAt">{m.admin_field_commissioned_date()}</label>
				{#if dateTagged}
					<span class="lookup-tag" id="commissioned-lookup-tag">{m.admin_lookup_from_lookup()}</span>
				{/if}
			</div>
			<input
				id="commissionedAt"
				type="date"
				class="input"
				name="commissionedAt"
				bind:value={commissionedAt}
				oninput={() => {
					// The panel's status line reads the filled record through this tag: a
					// field typed over stops being the lookup's, and the sentence then
					// neither claims it nor says it was left alone.
					dateTagged = false;
				}}
				aria-describedby={dateTagged ? 'commissioned-lookup-tag' : undefined}
			/>
			<small class="hint">{m.admin_hint_commissioned_date()}</small>
		</div>

		<div class="nsfw-row">
			<label class="checkbox-label">
				<input
					type="checkbox"
					name="nsfw"
					checked={data.image.nsfw}
					aria-describedby={ratingTagText ? 'lookup-rating-tag' : undefined}
				/>
				<span>{m.admin_field_mark_nsfw()}</span>
			</label>
			<!-- Never checked by a lookup: the rating is what the sites said, and the
			     call about this gallery stays the operator's. -->
			{#if ratingTagText}
				<span class="rating-tag" id="lookup-rating-tag">{ratingTagText}</span>
			{/if}
		</div>

		<label class="checkbox-label">
			<input type="checkbox" name="published" bind:checked={isPrivate} />
			<span>{m.admin_field_private()} <span class="checkbox-helper">{m.admin_field_private_hint()}</span></span>
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="featured" checked={data.image.featured} />
			<span>{m.admin_field_featured()}</span>
		</label>

		<label>
			<span>{m.admin_field_featured_order()}</span>
			<input type="number" class="input" name="featuredOrder" value={data.image.featuredOrder ?? ''} />
			<small class="hint">{m.admin_field_featured_order_hint()}</small>
		</label>

		<div class="field">
			<div class="label-row">
				<label class="field-label" for="sourcePostUrl">{m.admin_field_source_url()}</label>
				{#if sourceTagged}
					<span class="lookup-tag" id="source-lookup-tag">{m.admin_lookup_from_lookup()}</span>
				{/if}
			</div>
			<input
				id="sourcePostUrl"
				type="url"
				class="input"
				name="sourcePostUrl"
				bind:value={sourcePostUrl}
				oninput={() => {
					sourceTagged = false;
				}}
				aria-describedby={sourceTagged ? 'source-lookup-tag' : undefined}
			/>
		</div>

		<div class="form-actions">
			<a href="/admin/images" class="btn btn-secondary">{m.admin_cancel()}</a>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_save_changes()}{/if}
			</button>
		</div>
	</form>
</div>

<style>
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.page-header {
		margin-bottom: 24px;
	}

	h1 {
		font-size: 24px;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.edit-layout {
		display: grid;
		grid-template-columns: 300px 1fr;
		gap: 32px;
		align-items: start;
	}

	.image-preview {
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.image-preview img {
		width: 100%;
		display: block;
	}

	.edit-sidebar {
		display: flex;
		flex-direction: column;
	}

	.reference-control {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}

	.reference-current {
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
	}

	/* Desktop: size to content in the narrow sidebar column, not a full-width pill.
	   Mobile keeps the full-width button (restored in the media query below). The
	   long "use as reference sheet" label can wrap in the 300px column — left-align
	   the wrapped lines instead of the button's default centering. */
	.reference-btn {
		align-self: flex-start;
		text-align: left;
	}

	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 600px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label > span {
		font-size: 14px;
		font-weight: 500;
	}

	.hint {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	legend {
		font-size: 14px;
		font-weight: 500;
		padding: 0 8px;
	}

	/* Artist lookup (SONA-156) */
	.artist-toggle-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.lookup-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--foreground);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		/* Off the toggle's shoulder: adjacent and same-height, it reads as a
		   third segment of the Select existing / Add new control. */
		margin-left: auto;
	}

	/* aria-disabled, not `disabled`: a keyboard user mid-lookup keeps the focus
	   they had. The click guard in startLookup is what actually refuses. The
	   fill is --secondary, so the text is --foreground: the --muted-foreground
	   pairing measures 3.96:1 in terracotta light (SONA-124 found the same). */
	.lookup-pill[aria-disabled='true'] {
		background: var(--secondary);
		color: var(--foreground);
		cursor: default;
	}

	/* The pill is not a .btn, so app.css's focus ring doesn't reach it. */
	.lookup-pill:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.hint-warn {
		color: var(--status-warn);
	}

	.label-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.lookup-tag {
		font-family: var(--font-primary);
		font-size: 11px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 8px;
		white-space: nowrap;
	}

	/* The rating never changes the checkbox — it reports what the sites said and
	   sits beside it. nowrap so the sentence stays one unit, and the row wraps
	   the whole pill to its own line when it no longer fits. */
	.nsfw-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.rating-tag {
		font-family: var(--font-primary);
		font-size: 11px;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 8px;
		white-space: nowrap;
		max-width: 100%;
	}

	/* The text grows with the number of sites, so at narrow widths the pill
	   wraps rather than pushing the document into a sideways scroll. */
	@media (max-width: 480px) {
		.rating-tag {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}

	.artist-toggle {
		display: flex;
		gap: 4px;
		background: var(--secondary);
		border-radius: var(--radius-pill);
		padding: 4px;
		width: fit-content;
	}

	.toggle-btn {
		padding: 6px 16px;
		border-radius: var(--radius-pill);
		border: none;
		background: none;
		color: var(--muted-foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.toggle-btn.active {
		background: var(--background);
		color: var(--foreground);
	}

	.social-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.row {
		display: flex;
		gap: 16px;
	}

	.flex-1 {
		flex: 1;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		font-size: 14px;
		font-weight: 500;
	}

	.character-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		font-size: 13px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.chip:has(input:checked) {
		background: var(--primary);
		color: var(--primary-foreground);
	}

	.chip input {
		display: none;
	}

	.chip-owner {
		color: var(--muted-foreground);
		font-size: 11px;
	}

	.chip:has(input:checked) .chip-owner {
		color: var(--primary-foreground);
		opacity: 0.7;
	}

	.checkbox-label {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.checkbox-label input {
		width: 16px;
		height: 16px;
	}

	.checkbox-helper {
		color: var(--muted-foreground);
		font-size: 12px;
		margin-left: 4px;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding-top: 8px;
	}

	@media (max-width: 768px) {
		.page-header {
			display: none;
		}

		.edit-layout {
			grid-template-columns: 1fr;
			gap: 20px;
		}

		.image-preview {
			max-height: 200px;
		}

		.image-preview img {
			object-fit: contain;
		}

		.social-grid {
			grid-template-columns: 1fr;
		}

		.row {
			flex-direction: column;
		}

		.form-actions {
			flex-direction: column-reverse;
		}

		.form-actions .btn,
		.form-actions a {
			width: 100%;
			text-align: center;
		}

		.reference-btn {
			align-self: stretch;
		}
	}
</style>
