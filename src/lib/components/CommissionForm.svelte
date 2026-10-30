<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Check, CircleAlert, ImagePlus, Loader2, Plus, RefreshCw, TriangleAlert } from 'lucide-svelte';
	import CurrencyPicker from '$lib/components/CurrencyPicker.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import { SOCIAL_PLATFORM_NAMES } from '$lib/social-label';
	import type { Platform } from '$lib/social-platforms';
	import PieceThumb from '$lib/components/PieceThumb.svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import { toast } from '$lib/toast.svelte';
	import {
		COMMISSION_PAYMENTS,
		COMMISSION_STATUSES,
		KIND_MAX,
		NOTES_MAX,
		PAYMENT_LABELS,
		STATUS_LABELS,
		TITLE_MAX,
		canAddToGallery,
		changedFields,
		currencyFractionDigits,
		datesAfterStatusChange,
		FIELD_ORDER,
		formValuesOf,
		isCommissionStatus,
		localToday,
		mergeReloaded,
		sourceLinkHref,
		staleMessage,
		type CommissionField,
		type CommissionFormEntry,
		type CommissionFormValues
	} from '$lib/commissions';
	import { currencyRow, currencySymbol, initialCurrency } from '$lib/currencies';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	/** The entry as the edit page loads it. `version` is the row's updated_at:
	 * the save sends it back so the server can refuse an out-of-date form. It is
	 * never shown. */
	interface EntryInit extends CommissionFormEntry {
		id: number;
		version: string;
		/** The gallery piece the entry is linked to, if any. */
		piece: { id: number; title: string; thumb: string | null } | null;
		/** The saved artist, for Open chat beside a plain-text place. */
		artistName?: string;
		artistTelegramUrl?: string | null;
	}
	interface FailureData {
		errors?: Partial<Record<CommissionField, string>>;
		gated?: boolean;
		stale?: boolean;
		/** The entry was deleted after the form loaded. */
		missing?: boolean;
		/** What the refused save sent, and the version it sent with it. */
		values?: CommissionFormValues;
		version?: string;
	}
	interface Props {
		artists: { id: number; name: string }[];
		characters: { id: number; name: string; ownerName: string | null }[];
		/** Edit mode when set; create otherwise. */
		entry?: EntryInit | null;
		form?: FailureData | null;
		/** The GA date the gate refusal names. */
		gaDate: string | null;
		/** Currencies saved entries use, most recently saved first. */
		recentCurrencies?: string[];
		/** Kinds saved entries use, most recently saved first, one per letter case. */
		recentKinds?: string[];
		/** The currency of the region the browser's languages name, if any. */
		localeCurrency?: string | null;
		/** Whether the shared registry is connected, for the New Artist dialog. */
		registryEnabled?: boolean;
		/** Rendered last in the button row, such as Delete entry on the edit page. */
		extraActions?: Snippet;
	}

	let {
		artists,
		characters,
		entry = null,
		form = null,
		gaDate,
		extraActions,
		recentCurrencies = [],
		recentKinds = [],
		localeCurrency = null,
		registryEnabled = false
	}: Props = $props();

	// Artists made from this form join its list without a reload. Add New
	// Artist needs the page's script, so it only renders once that has run.
	let addedArtists = $state<{ id: number; name: string }[]>([]);
	const artistOptions = $derived(
		[...artists, ...addedArtists.filter((a) => !artists.some((b) => b.id === a.id))].sort((a, b) =>
			a.name.localeCompare(b.name, getLocale())
		)
	);
	let showNewArtist = $state(false);
	// Set when the dialog opens from a link's "Add {handle}": it seeds the name
	// and that platform's field, and the made artist becomes the link's match.
	let artistSeed = $state<{ platform: Platform; handle: string } | null>(null);
	let artistSelect = $state<HTMLSelectElement>();
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	/** A lookup can name an artist added since this page loaded (in another tab,
	 * say). Picking one the select has no option for would leave it blank and
	 * block Save, so the artist joins the list first. */
	function includeArtist(artist: { id: number; name: string }) {
		if (!artistOptions.some((a) => a.id === artist.id)) addedArtists = [...addedArtists, { id: artist.id, name: artist.name }];
	}

	async function onArtistCreated(artist: { id: number; name: string }) {
		if (artistSeed && lookup.kind === 'found' && lookup.handle === artistSeed.handle) {
			lookup = { ...lookup, matches: [artist], nameMatches: [], added: true };
		}
		artistSeed = null;
		showNewArtist = false;
		// The owner's own pick: a later link lookup mustn't replace it.
		useArtist(artist);
		await tick();
		artistSelect?.focus();
	}

	// The page never swaps a create form into an edit form, so the first value holds.
	// svelte-ignore state_referenced_locally
	const isEdit = entry !== null;

	// What the form opened with, for naming what the owner changed when a save
	// is refused as out of date. Replaced on Reload entry.
	// svelte-ignore state_referenced_locally
	let loaded = $state(formValuesOf(entry));
	// A save refused without JavaScript renders the page again from the server:
	// the form opens with what was sent, under the version it was sent with.
	// svelte-ignore state_referenced_locally
	let version = $state(form?.version ?? entry?.version ?? '');
	// svelte-ignore state_referenced_locally
	let values = $state(form?.values ?? formValuesOf(entry));
	// With no currency yet, the picker opens on the most recent one, else the
	// browser's regional one. Read into `loaded` too, so an out-of-date refusal
	// doesn't name a currency the owner never touched. A currency with no amount
	// saves as no price, so this pick alone stores nothing.
	// svelte-ignore state_referenced_locally
	if (!form && !values.currency) {
		// svelte-ignore state_referenced_locally
		const opening = initialCurrency({ recent: recentCurrencies, localeCurrency });
		values.currency = opening;
		loaded.currency = opening;
	}
	// The row is fixed when the form opens: the entry's own currency, then recent
	// ones. A pick from Other currency joins it inside the picker.
	// svelte-ignore state_referenced_locally
	const currencyChoices = currencyRow({ entryCurrency: entry?.currency || form?.values?.currency, recent: recentCurrencies, localeCurrency });
	const amountDigits = $derived(values.currency ? currencyFractionDigits(values.currency) : null);
	// Null when the currency prints as its code (CHF), so the code shows once.
	const amountSymbol = $derived(values.currency ? currencySymbol(values.currency, getLocale()) : null);
	const amountHint = $derived(
		amountDigits === null
			? m.admin_commissions_hint_amount_none()
			: amountDigits === 0
				? m.admin_commissions_hint_amount_whole({ currency: values.currency })
				: m.admin_commissions_hint_amount_decimals({ currency: values.currency, digits: amountDigits })
	);

	let saving = $state(false);
	// The refusal on screen. Cleared when a new save starts or the entry reloads,
	// so an answered refusal doesn't linger above a fresh form.
	// Starts from `form` so the server-rendered page shows the refusal too.
	// svelte-ignore state_referenced_locally
	let failure = $state<FailureData | null>(form ?? null);
	$effect(() => {
		failure = form ?? null;
	});
	const errors = $derived(failure?.errors ?? {});
	// Open chat: a place typed as text ("Telegram DM") names no address, so the
	// saved artist's Telegram stands in. Only while the form still has that
	// artist: another pick would open the wrong person's chat.
	const chatHref = $derived(
		entry?.artistName &&
			values.artistId === String(entry.artistId) &&
			values.sourceUrl.trim() &&
			!sourceLinkHref(values.sourceUrl)
			? sourceLinkHref(entry.artistTelegramUrl)
			: null
	);
	// The out-of-date refusal's text, fixed when the refusal arrives so the alert
	// doesn't change under a screen reader while the owner keeps typing.
	let staleText = $state('');
	// After Reload entry put an unsaved note back: which hint Notes shows.
	let restoredNote = $state<'' | 'kept' | 'replaces'>('');

	const announcer = new Announcer();
	let staleBox = $state<HTMLElement>();
	let gateBox = $state<HTMLElement>();
	let missingBox = $state<HTMLElement>();
	let notesInput = $state<HTMLTextAreaElement>();
	let titleInput = $state<HTMLInputElement>();
	let saveButton = $state<HTMLButtonElement>();

	// Moving to Accepted or Delivered fills that step's empty date with today
	// (open question Q17, built as drawn). The owner can change or clear it.
	// The pick is read from the event, not from values.status, so the date never
	// depends on whether the binding has run yet.
	function onStatusChange(e: Event & { currentTarget: HTMLSelectElement }) {
		const status = e.currentTarget.value;
		if (!isCommissionStatus(status)) return;
		const next = datesAfterStatusChange(status, values, localToday());
		values.requestedOn = next.requestedOn;
		values.acceptedOn = next.acceptedOn;
		values.deliveredOn = next.deliveredOn;
	}

	// A refused currency, or an amount refused for its currency's decimals, no
	// longer applies once another currency is picked, so those errors go at
	// once. An amount that isn't a number stays wrong in any currency.
	function setCurrency(next: string) {
		if (next !== values.currency && failure?.errors) {
			const kept = { ...failure.errors };
			delete kept.currency;
			if (kept.price !== m.admin_commissions_error_price_format()) delete kept.price;
			failure = { ...failure, errors: kept };
		}
		values.currency = next;
	}

	function toggleCharacter(id: number) {
		values.characterIds = values.characterIds.includes(id)
			? values.characterIds.filter((c) => c !== id)
			: [...values.characterIds, id];
	}

	// The Gallery panel works from the saved entry, so unsaved changes hold it
	// back: the upload would start from what's saved, not from what's typed.
	const dirty = $derived(changedFields(loaded, values).length > 0 || values.notes !== loaded.notes);
	const galleryOpen = $derived(canAddToGallery(loaded.status));

	/** Loads the entry as it is now, and puts the unsaved note back in Notes. */
	async function reloadEntry() {
		const typedNote = values.notes;
		const loadedNote = loaded.notes;
		await invalidateAll();
		// The page passes the reloaded entry back in through `entry`.
		const fresh = formValuesOf(entry);
		// The same opening currency as a form that opens with no currency.
		if (!fresh.currency) fresh.currency = initialCurrency({ recent: recentCurrencies, localeCurrency });
		const merged = mergeReloaded(fresh, loadedNote, typedNote);
		loaded = fresh;
		version = entry?.version ?? '';
		values = merged.values;
		restoredNote = merged.restoredNote;
		// The form now shows the entry as saved, not the draft.
		draftRestored = false;
		failure = null;
		staleText = '';
		// The reloaded entry has its own link; the last lookup was about another.
		// (No auto-pick to forget: an entry always has an artist, so the lookup
		// never picks one on the edit page.)
		clearLookup();
		announcer.say(
			merged.restoredNote ? m.admin_commissions_reloaded_announce_note() : m.admin_commissions_reloaded_announce()
		);
		await tick();
		(merged.restoredNote ? notesInput : titleInput)?.focus();
	}


	// Paste a link (SONA-236): the link field looks up the artist it names. The
	// server parses the link and never fetches it; the link itself stays in this
	// field, the entry's private record, and never becomes a piece's source.
	type ArtistChoice = { id: number; name: string };
	type LinkLookup =
		| { kind: 'idle' }
		| { kind: 'searching' }
		| { kind: 'refused'; reason: 'invalid' | 'unsupported' | 'no_handle' | 'failed' }
		| {
				kind: 'found';
				platform: Platform;
				handle: string;
				matches: ArtistChoice[];
				nameMatches: ArtistChoice[];
				/** The one match was just made from this link with Add {handle}. */
				added?: boolean;
		  };
	let lookup = $state<LinkLookup>({ kind: 'idle' });
	// The link last sent, so a blur after a paste doesn't ask twice.
	let lookedUp = '';
	// Which request is current: an answer to any earlier one is stale.
	let lookupSeq = 0;
	// The artist the lookup picked by itself, while the owner hasn't picked one.
	// A later link's match may replace it; it never replaces the owner's pick.
	let autoPicked: string | null = null;
	// A draft came back, so the owner sees why the form isn't empty.
	let draftRestored = $state(false);

	/** The owner chose an artist, from a Use button or the select. */
	function ownerPicked() {
		autoPicked = null;
	}

	function useArtist(artist: ArtistChoice) {
		includeArtist(artist);
		values.artistId = String(artist.id);
		ownerPicked();
		announcer.say(m.admin_commissions_artist_added_announce({ name: artist.name }));
	}

	// Clicking Save (or anything else) with a typed link still in the field
	// fires change on the mouse-down. Starting the lookup then draws its
	// "searching" line and moves Save before the mouse-up, so the click never
	// lands. While a pointer is down, the lookup waits for it to come up.
	let pointerDown = false;
	function lookUpAfterPointer(raw: string) {
		if (!pointerDown) return lookUpSource(raw);
		window.addEventListener('pointerup', () => setTimeout(() => lookUpSource(raw)), { once: true });
	}

	/** Where it's happening can be a link or plain text ("Telegram DM"). Only a
	 * link is looked up: text names no account, and it never leaves the form
	 * until Save. Text in place of a link clears the last link's answer. */
	function lookUpSource(raw: string) {
		if (!raw.trim() || sourceLinkHref(raw)) return lookUpLink(raw);
		clearLookup();
	}

	async function lookUpLink(raw: string) {
		const link = raw.trim();
		if (!link) {
			clearLookup();
			return;
		}
		if (link === lookedUp) return;
		lookedUp = link;
		const seq = ++lookupSeq;
		lookup = { kind: 'searching' };
		let next: LinkLookup;
		try {
			const res = await fetch('/api/admin/artist-from-link', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: link })
			});
			const body = await res.json();
			next = body.ok
				? { kind: 'found', platform: body.platform, handle: body.handle, matches: body.matches, nameMatches: body.nameMatches }
				: { kind: 'refused', reason: body.reason ?? 'failed' };
		} catch {
			next = { kind: 'refused', reason: 'failed' };
		}
		// A newer lookup went out, or the owner has changed the field since: this
		// answer is about a link that's no longer there.
		if (seq !== lookupSeq) return;
		if (values.sourceUrl.trim() !== link) {
			// Nothing newer is on its way, so stop searching, and let the link be
			// asked again if the field comes back to it.
			lookup = { kind: 'idle' };
			lookedUp = '';
			return;
		}
		lookup = next;
		// A lookup that didn't get through can be tried again with the same link.
		if (next.kind === 'refused' && next.reason === 'failed') lookedUp = '';
		// One artist holds this handle: that's the artist, unless the owner has
		// already chosen one. Several, or a name that only looks the same, wait
		// for the owner.
		const single = next.kind === 'found' && next.matches.length === 1 ? next.matches[0] : null;
		const outcome = lookupOutcome(next);
		if (single && (!values.artistId || values.artistId === autoPicked)) {
			includeArtist(single);
			values.artistId = autoPicked = String(single.id);
			const using = m.admin_commissions_artist_added_announce({ name: single.name });
			announcer.say(`${outcome}${getLocale() === 'ja' ? '' : ' '}${using}`);
			return;
		}
		// The lookup's own pick came from the last link. A link that names no one,
		// or someone else, takes it away so a save can't keep it unchosen. A failed
		// lookup says nothing about the artist, so the pick stays.
		const failed = next.kind === 'refused' && next.reason === 'failed';
		if (!single && !failed && autoPicked !== null && values.artistId === autoPicked) {
			values.artistId = '';
			autoPicked = null;
		}
		announcer.say(outcome);
	}

	/** No lookup on screen, and any answer still on its way ignored. */
	function clearLookup() {
		lookup = { kind: 'idle' };
		lookedUp = '';
		lookupSeq++;
	}

	// Set once a save has gone through: what's on the page then is saved, and
	// coming back to it must not bring an older copy back.
	let saved = false;

	/**
	 * The draft for the page's snapshot, so following a link off the form (the
	 * lookup's Artists page) and coming back keeps what the owner typed.
	 * Nothing when there's nothing unsaved: an untouched form, or one whose
	 * save went through.
	 */
	export function captureDraft() {
		if (saved || !dirty) return undefined;
		return {
			// The entry's version the draft was typed against.
			version,
			values: $state.snapshot(values),
			// Only while it still holds: the lookup's own pick, not the owner's.
			autoPicked: autoPicked === values.artistId ? autoPicked : null
		};
	}

	/**
	 * Puts a draft back. A draft typed against an older version of the entry is
	 * dropped: the page shows the current entry, so a save can't quietly undo
	 * another tab's change. The lookup is asked again rather than restored,
	 * because the artist list may have changed while the owner was away.
	 */
	export function restoreDraft(draft: NonNullable<ReturnType<typeof captureDraft>>) {
		if (draft.version !== version) return;
		values = draft.values;
		autoPicked = draft.autoPicked;
		clearLookup();
		draftRestored = true;
		announcer.say(m.admin_commissions_draft_restored());
		if (values.sourceUrl.trim()) lookUpSource(values.sourceUrl);
	}

	/** The sentence that says how a lookup went, shown and read out. */
	function lookupOutcome(result: LinkLookup): string {
		if (result.kind === 'refused') {
			return {
				invalid: m.admin_commissions_link_invalid,
				unsupported: m.admin_commissions_link_unsupported,
				no_handle: m.admin_commissions_link_no_handle,
				failed: m.admin_commissions_link_failed
			}[result.reason]();
		}
		if (result.kind !== 'found') return '';
		const { handle, matches } = result;
		if (matches.length === 1 && result.added) return m.admin_commissions_link_added({ name: matches[0].name });
		if (matches.length === 1) return m.admin_commissions_link_found({ handle, name: matches[0].name });
		if (matches.length > 1) return m.admin_commissions_link_found_several({ handle });
		if (result.nameMatches.length > 0) return m.admin_commissions_link_name_only({ handle });
		return m.admin_commissions_link_not_found({ handle });
	}

	const DATE_FIELDS = [
		['requestedOn', m.admin_commissions_field_requested],
		['acceptedOn', m.admin_commissions_field_accepted],
		['deliveredOn', m.admin_commissions_field_delivered]
	] as const;

	async function focusFailure() {
		await tick();
		if (failure?.stale) staleBox?.focus();
		else if (failure?.gated) gateBox?.focus();
		else if (failure?.missing) missingBox?.focus();
		else {
			const first = FIELD_ORDER.find((f) => errors[f]);
			if (first) document.getElementById(`ce-${first}`)?.focus();
			// No field to send focus to: keep it on Save rather than on <body>.
			else saveButton?.focus();
		}
	}

	/** aria-describedby for a field: its error first, then its hints. */
	function describedBy(field: CommissionField, ...hints: string[]): string | undefined {
		const ids = [errors[field] ? `ce-${field}-err` : '', ...hints].filter(Boolean);
		return ids.length > 0 ? ids.join(' ') : undefined;
	}
</script>

<svelte:window
	onpointerdown={() => (pointerDown = true)}
	onpointerup={() => (pointerDown = false)}
	onpointercancel={() => (pointerDown = false)}
/>

{#snippet fieldError(field: CommissionField)}
	{#if errors[field]}
		<p class="field-error" id="ce-{field}-err">
			<CircleAlert size={14} aria-hidden="true" /><span>{errors[field]}</span>
		</p>
	{/if}
{/snippet}

<!-- `named` lists the artist's name beside the button, for when several share
     a handle. A single match is already named by the line above and the button. -->
{#snippet choice(artist: ArtistChoice, named: boolean)}
	{@const using = values.artistId === String(artist.id)}
	<div class="match">
		{#if named}<span class="name">{artist.name}</span>{/if}
		<!-- The label says the state: "Use X" until chosen, then "Using X" with a
		     check, as in ArtistLookupPanel. -->
		<button type="button" class="btn-compact btn-tap-mobile" onclick={() => useArtist(artist)}>
			{#if using}<Check size={14} aria-hidden="true" />{m.admin_lookup_using_artist({ name: artist.name })}{:else}{m.admin_lookup_use_artist({ name: artist.name })}{/if}
		</button>
	</div>
{/snippet}

<!-- No artist holds the handle: make one from it, private to the ledger until
     there's public work by them (SONA-236 Q26). Without the page's script there
     is no dialog, so the Artists page stands in. -->
{#snippet addArtistHint(found: { platform: Platform; handle: string })}
	{#if hydrated}
		<button
			type="button"
			class="add-artist-btn"
			onclick={() => {
				artistSeed = { platform: found.platform, handle: found.handle };
				showNewArtist = true;
			}}
		>
			<Plus size={14} aria-hidden="true" />{m.admin_commissions_link_add_new({ handle: found.handle })}
		</button>
	{:else}
		<p class="hint">
			{m.admin_commissions_link_add_pre()}<a href="/admin/artists">{m.admin_commissions_link_add_link()}</a
			>{m.admin_commissions_link_add_post()}
		</p>
	{/if}
{/snippet}

{#snippet optional()}
	<span class="optional">{m.admin_commissions_optional()}</span>
{/snippet}

<LiveAnnouncer {announcer} />

{#if failure?.gated}
	<p class="error" role="alert" tabindex="-1" bind:this={gateBox}>
		<CircleAlert size={16} aria-hidden="true" />
		<span
			>{m.admin_commissions_refused_pre({ date: gaDate ?? '' })}<a href="/admin/settings?tab=account#supporter-key"
				>{m.admin_commissions_refused_link()}</a
			>{m.admin_commissions_refused_post()}</span
		>
	</p>
{/if}

{#if failure?.missing}
	<p class="error" role="alert" tabindex="-1" bind:this={missingBox}>
		<CircleAlert size={16} aria-hidden="true" />
		<span
			>{m.admin_commissions_missing_pre()}<a href="/admin/commissions">{m.admin_commissions_missing_link()}</a
			>{m.admin_commissions_missing_post()}</span
		>
	</p>
{/if}

{#if failure?.stale}
	<div class="stale">
		<div class="error" role="alert" tabindex="-1" bind:this={staleBox}>
			<CircleAlert size={16} aria-hidden="true" />
			<span>{staleText || m.admin_commissions_stale()}</span>
		</div>
		<details class="why">
			<summary>{m.admin_commissions_why()}</summary>
			<p>{m.admin_commissions_why_body()}</p>
		</details>
		<div class="form-actions why-actions">
			{#if hydrated}
				<button type="button" class="btn btn-primary" onclick={reloadEntry}>
					<RefreshCw size={16} aria-hidden="true" />
					{m.admin_commissions_reload()}
				</button>
			{:else}
				<!-- Without the page's script, Reload entry loads the edit page again:
				     the current entry, without the typed note. -->
				<a class="btn btn-primary" href="/admin/commissions/{entry?.id}/edit">
					<RefreshCw size={16} aria-hidden="true" />
					{m.admin_commissions_reload()}
				</a>
			{/if}
		</div>
	</div>
{/if}

{#snippet galleryButton(label: string, primary: boolean, described: boolean)}
	{@const tone = primary ? 'btn-primary' : 'btn-secondary'}
	{@const Icon = entry?.piece ? Plus : ImagePlus}
	{#if dirty}
		<button type="button" class="btn {tone}" aria-disabled="true" aria-describedby="ce-gallery-hint">
			<Icon size={16} aria-hidden="true" />
			{label}
		</button>
	{:else}
		<a
			class="btn {tone}"
			href="/admin/upload?commission={entry?.id}"
			aria-describedby={described ? 'ce-gallery-hint' : undefined}
		>
			<Icon size={16} aria-hidden="true" />
			{label}
		</a>
	{/if}
{/snippet}

{#if entry}
	<!-- Add to gallery opens the upload form prefilled from the saved entry. A
	     piece already linked takes variants instead. -->
	<section class="gallery-panel" aria-labelledby="ce-gallery-h">
		<h2 id="ce-gallery-h">{m.admin_commissions_legend_gallery()}</h2>
		<div class="gallery-row">
			{#if entry.piece}
				<PieceThumb src={entry.piece.thumb} />
				<div class="text">
					<a href="/admin/images/{entry.piece.id}/edit">{entry.piece.title}</a>
					{#if galleryOpen && dirty}<span class="hint" id="ce-gallery-hint">{m.admin_commissions_gallery_hint_dirty()}</span>{/if}
				</div>
				{#if galleryOpen}{@render galleryButton(m.admin_commissions_add_variant(), false, dirty)}{/if}
			{:else if !galleryOpen}
				<div class="text"><span>{m.admin_commissions_gallery_closed()}</span></div>
			{:else}
				{@const delivered = loaded.status === 'delivered'}
				<div class="text">
					<span>{m.admin_commissions_not_in_gallery()}</span>
					<span class="hint" id="ce-gallery-hint"
						>{dirty
							? m.admin_commissions_gallery_hint_dirty()
							: delivered
								? m.admin_commissions_gallery_hint_delivered()
								: m.admin_commissions_gallery_hint_active()}</span
					>
				</div>
				{@render galleryButton(m.admin_commissions_add_to_gallery(), delivered, true)}
			{/if}
		</div>
	</section>
{/if}

<form
	method="POST"
	action={isEdit ? '?/save' : undefined}
	class="form entry-form"
	novalidate
	use:enhance={({ cancel }) => {
		// aria-disabled rather than disabled keeps focus on Save while it works,
		// so this is what stops a second submit.
		if (saving) {
			cancel();
			return;
		}
		saving = true;
		failure = null;
		// What the owner changed, read now: the refusal names it as it was sent.
		const sent = { ...values, characterIds: [...values.characterIds] };
		return async ({ update, result }) => {
			const refusal = result.type === 'failure' ? ((result.data as FailureData | undefined) ?? {}) : null;
			// Fixed before update() renders the refusal, so the alert appears once,
			// with its whole text.
			if (refusal) staleText = refusal.stale ? staleMessage(loaded, sent, getLocale()) : '';
			// A save redirects to the ledger, which enhance follows; a refusal stays
			// here with what the owner typed. An error is left out: update() would
			// render the error page in place of the form and lose the typing.
			if (result.type === 'redirect') {
				saved = true;
				// The edit page's own data catches up with the save before leaving.
				// A Back that lands while the ledger is still loading shows the page
				// SvelteKit already holds instead of loading it again, and that copy
				// must not be the one from before the save.
				if (isEdit) {
					await invalidateAll();
					// The same form can stay up through that Back. It then holds the
					// entry as saved, values and version together, so a save from it
					// can't send older values under a newer version, and a change
					// typed there is kept as a draft again. Nothing differs from the
					// entry now, so leaving keeps no draft.
					const asSaved = () => {
						const v = formValuesOf(entry);
						if (!v.currency) v.currency = initialCurrency({ recent: recentCurrencies, localeCurrency });
						return v;
					};
					loaded = asSaved();
					values = asSaved();
					version = entry?.version ?? '';
					saved = false;
				}
			}
			if (result.type !== 'error') await update({ reset: false });
			saving = false;
			if (refusal) {
				failure = refusal;
				if (!refusal.errors && !refusal.gated && !refusal.stale && !refusal.missing) {
					toast.error(m.admin_commissions_save_failed());
				}
				await focusFailure();
			} else if (result.type === 'error') {
				toast.error(m.admin_commissions_save_error());
				// Focus stays on Save, so trying again is one key away.
				saveButton?.focus();
			}
		};
	}}
>
	{#if isEdit}<input type="hidden" name="version" value={version} />{/if}

	<!-- The announcer says it once; this line stays for whoever looks. -->
	{#if draftRestored}<p class="hint draft-note">{m.admin_commissions_draft_restored()}</p>{/if}

	<fieldset>
		<legend>{m.admin_commissions_legend_artist()}</legend>
		<div class="field">
			<div class="label-row">
				<label class="field-label" for="ce-sourceUrl">{m.admin_commissions_field_link()}</label>{@render optional()}
			</div>
			<input
				id="ce-sourceUrl"
				class="input"
				type="text"
				name="sourceUrl"
				autocomplete="off"
				bind:value={values.sourceUrl}
				oninput={(e) => {
					// A paste is the moment to look; typed text waits for the owner to leave
					// the field, so a half-typed link isn't sent.
					if (e instanceof InputEvent && e.inputType === 'insertFromPaste') lookUpSource(e.currentTarget.value);
					else if (!e.currentTarget.value.trim()) lookUpLink('');
				}}
				onchange={(e) => lookUpAfterPointer(e.currentTarget.value)}
				aria-invalid={errors.sourceUrl ? 'true' : undefined}
				aria-describedby={describedBy('sourceUrl', 'ce-link-hint', lookup.kind === 'refused' ? 'ce-link-msg' : '')}
			/>
			{@render fieldError('sourceUrl')}
			<small class="hint" id="ce-link-hint">{m.admin_commissions_hint_link()}</small>
			{#if chatHref}
				<a
					class="open-chat"
					href={chatHref}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={m.admin_commissions_open_chat_label({ artist: entry?.artistName ?? '' })}
					>{m.admin_commissions_open_chat()}</a
				>
			{/if}
			{#if lookup.kind === 'refused'}
				<p class="hint hint-warn lookup-msg" id="ce-link-msg">
					<TriangleAlert size={14} aria-hidden="true" /><span>{lookupOutcome(lookup)}</span>
				</p>
			{/if}
		</div>
		{#if lookup.kind === 'searching'}
			<!-- The card's place, held while the answer comes, so the Artist select
			     below doesn't jump when it arrives. -->
			<div class="lookup"><p class="hint">{m.admin_commissions_link_searching()}</p></div>
		{:else if lookup.kind === 'found'}
			{@const found = lookup}
			<!-- Once the owner takes a suggestion, "isn't in your list yet" and the
			     Artists page hint would contradict the choice beside them. -->
			{@const suggestionTaken =
				found.matches.length === 0 && found.nameMatches.some((a) => String(a.id) === values.artistId)}
			<div class="lookup">
				<p class="lookup-line">
					<span class="platform">{SOCIAL_PLATFORM_NAMES[found.platform]}</span>
					<span class="handle">{found.handle}</span>
				</p>
				{#if !suggestionTaken}
					<p class="outcome">
						{#if found.matches.length === 1 && values.artistId === String(found.matches[0].id)}<Check
								size={14}
								aria-hidden="true"
							/>{/if}<span>{lookupOutcome(found)}</span>
					</p>
				{/if}
				{#each found.matches as artist (artist.id)}
					{@render choice(artist, found.matches.length > 1)}
				{/each}
				{#if found.matches.length === 0}
					{#each found.nameMatches as artist (artist.id)}
						{@render choice(artist, false)}
					{/each}
					{#if !suggestionTaken}{@render addArtistHint(found)}{/if}
				{/if}
			</div>
		{/if}
		<div class="field">
			<label class="field-label" for="ce-artistId">{m.admin_commissions_field_artist()}</label>
			<select
				id="ce-artistId"
				class="input"
				name="artistId"
				required
				bind:value={values.artistId}
				onchange={ownerPicked}
				bind:this={artistSelect}
				aria-invalid={errors.artistId ? 'true' : undefined}
				aria-describedby={describedBy('artistId', artistOptions.length === 0 ? 'ce-no-artists' : '')}
			>
				<option value="">{m.admin_commissions_select_artist()}</option>
				{#each artistOptions as artist (artist.id)}
					<option value={String(artist.id)}>{artist.name}</option>
				{/each}
			</select>
			{@render fieldError('artistId')}
			{#if hydrated}
				<button
					type="button"
					class="add-artist-btn"
					onclick={() => {
						artistSeed = null;
						showNewArtist = true;
					}}
				>
					<Plus size={14} aria-hidden="true" /> {m.admin_upload_add_new_artist()}
				</button>
			{/if}
			{#if artistOptions.length === 0}
				<!-- Without the page's script there's no Add New Artist, so this
				     points at the page that makes artists either way. -->
				<small class="hint" id="ce-no-artists"
					>{m.admin_commissions_no_artists_pre()}<a href="/admin/artists">{m.admin_commissions_no_artists_link()}</a
					>{m.admin_commissions_no_artists_post()}</small
				>
			{/if}
		</div>
	</fieldset>

	<fieldset>
		<legend>{m.admin_commissions_legend_commission()}</legend>
		<div class="field">
			<label class="field-label" for="ce-title">{m.admin_commissions_field_title()}</label>
			<input
				id="ce-title"
				class="input"
				type="text"
				name="title"
				autocomplete="off"
				maxlength={TITLE_MAX}
				required
				bind:value={values.title}
				bind:this={titleInput}
				aria-invalid={errors.title ? 'true' : undefined}
				aria-describedby={describedBy('title', 'ce-title-hint')}
			/>
			{@render fieldError('title')}
			<small class="hint" id="ce-title-hint">{m.admin_commissions_hint_title()}</small>
		</div>
		<div class="field">
			<div class="label-row">
				<label class="field-label" for="ce-kind">{m.admin_commissions_field_kind()}</label>{@render optional()}
			</div>
			<input
				id="ce-kind"
				class="input"
				type="text"
				name="kind"
				maxlength={KIND_MAX}
				placeholder={m.admin_commissions_kind_placeholder()}
				list={recentKinds.length > 0 ? 'ce-kind-list' : undefined}
				autocomplete="off"
				bind:value={values.kind}
				aria-invalid={errors.kind ? 'true' : undefined}
				aria-describedby={describedBy('kind')}
			/>
			<!-- Suggestions only: any kind can still be typed. -->
			{#if recentKinds.length > 0}
				<datalist id="ce-kind-list">
					{#each recentKinds as kind (kind)}<option value={kind}></option>{/each}
				</datalist>
			{/if}
			{@render fieldError('kind')}
		</div>
		{#if characters.length > 0}
			<div class="field">
				<div class="label-row">
					<span class="field-label" id="ce-chars-label">{m.admin_commissions_field_characters()}</span>{@render optional()}
				</div>
				<div
					class="char-chips"
					id="ce-characterIds"
					role="group"
					tabindex="-1"
					aria-labelledby="ce-chars-label"
					aria-describedby={describedBy('characterIds')}
				>
					{#each characters as character (character.id)}
						{@const on = values.characterIds.includes(character.id)}
						<label class="char-chip" class:on>
							<input
								type="checkbox"
								name="characterId"
								value={character.id}
								checked={on}
								onchange={() => toggleCharacter(character.id)}
							/>
							{#if on}<Check size={14} aria-hidden="true" />{/if}
							<span>{character.name}</span>
							{#if character.ownerName}<span class="chip-owner">({character.ownerName})</span>{/if}
						</label>
					{/each}
				</div>
				{@render fieldError('characterIds')}
			</div>
		{/if}
		<div class="field">
			<div class="label-row">
				<label class="field-label" for="ce-notes">{m.admin_commissions_field_notes()}</label>{@render optional()}
			</div>
			<textarea
				id="ce-notes"
				class="input"
				name="notes"
				autocomplete="off"
				rows="4"
				maxlength={NOTES_MAX}
				bind:value={values.notes}
				bind:this={notesInput}
				aria-invalid={errors.notes ? 'true' : undefined}
				aria-describedby={describedBy('notes', restoredNote ? 'ce-notes-restored' : '')}
			></textarea>
			{@render fieldError('notes')}
			{#if restoredNote}
				<small class="hint" id="ce-notes-restored"
					>{restoredNote === 'replaces'
						? m.admin_commissions_reloaded_hint_replaces()
						: m.admin_commissions_reloaded_hint()}</small
				>
			{/if}
		</div>
	</fieldset>

	<fieldset>
		<legend>{m.admin_commissions_legend_progress()}</legend>
		<div class="row-2">
			<div class="field">
				<label class="field-label" for="ce-status">{m.admin_commissions_field_status()}</label>
				<select
					id="ce-status"
					class="input"
					name="status"
					bind:value={values.status}
					onchange={onStatusChange}
					aria-invalid={errors.status ? 'true' : undefined}
					aria-describedby={describedBy('status', 'ce-dates-hint')}
				>
					{#each COMMISSION_STATUSES as status (status)}
						<option value={status}>{STATUS_LABELS[status]()}</option>
					{/each}
				</select>
				{@render fieldError('status')}
			</div>
			<div class="field">
				<label class="field-label" for="ce-payment">{m.admin_commissions_field_payment()}</label>
				<select
					id="ce-payment"
					class="input"
					name="payment"
					bind:value={values.payment}
					aria-invalid={errors.payment ? 'true' : undefined}
					aria-describedby={describedBy('payment')}
				>
					{#each COMMISSION_PAYMENTS as payment (payment)}
						<option value={payment}>{PAYMENT_LABELS[payment]()}</option>
					{/each}
				</select>
				{@render fieldError('payment')}
			</div>
		</div>
		<!-- Currency first, so the amount box can show which currency it's in
		     and the hint can give that currency's decimal rule before Save. -->
		<fieldset class="subgroup">
			<legend>{m.admin_commissions_field_price()} {@render optional()}</legend>
			<div class="field">
				<span class="field-label" id="ce-currency-label">{m.admin_commissions_field_currency()}</span>
				<CurrencyPicker
					row={currencyChoices}
					bind:value={() => values.currency, setCurrency}
					invalid={!!errors.currency}
					describedBy={describedBy('currency', 'ce-currency-hint')}
					announce={(text) => announcer.say(text)}
				>
					<!-- Under the row, above an open search, so the hint stays by the row it describes. -->
					{#snippet below()}
						{@render fieldError('currency')}
						<small class="hint" id="ce-currency-hint"
							>{recentCurrencies.length > 0 ? m.admin_commissions_hint_currency_recent() : m.admin_commissions_hint_currency_pick()}</small
						>
					{/snippet}
				</CurrencyPicker>
			</div>
			<div class="field">
				<label class="field-label" for="ce-price">{m.admin_commissions_field_amount()}</label>
				<!-- One field: the symbol inside on the left, the code inside on the
				     right, so the box's left edge stays on the column line. The hint
				     names the currency for a screen reader. -->
				<div class="field-pill amount">
					{#if amountSymbol}<span class="affix" aria-hidden="true">{amountSymbol}</span>{/if}
					<input
						id="ce-price"
						class="input input-plain"
						type="text"
						name="price"
						inputmode={amountDigits === 0 ? 'numeric' : 'decimal'}
						autocomplete="off"
						bind:value={values.price}
						aria-invalid={errors.price ? 'true' : undefined}
						aria-describedby={describedBy('price', 'ce-price-hint')}
					/>
					{#if values.currency}<span class="affix" aria-hidden="true">{values.currency}</span>{/if}
				</div>
				{@render fieldError('price')}
				<small class="hint" id="ce-price-hint">{amountHint}</small>
			</div>
		</fieldset>
		<!-- The hint is tied to each date input, so the fieldset doesn't repeat it. -->
		<fieldset class="subgroup">
			<legend>{m.admin_commissions_legend_dates()} {@render optional()}</legend>
			<div class="row-3">
				{#each DATE_FIELDS as [field, label] (field)}
					<div class="field">
						<label class="field-label" for="ce-{field}">{label()}</label>
						<input
							id="ce-{field}"
							class="input"
							type="date"
							name={field}
							bind:value={values[field]}
							aria-invalid={errors[field] ? 'true' : undefined}
							aria-describedby={describedBy(field, 'ce-dates-hint')}
						/>
						{@render fieldError(field)}
					</div>
				{/each}
			</div>
			<!-- The date fill is the page's script (onStatusChange), so without it
			     the hint doesn't promise one. -->
			<small class="hint" id="ce-dates-hint"
				>{hydrated ? `${m.admin_commissions_hint_dates_fill()}${getLocale() === 'ja' ? '' : ' '}` : ''}{m.admin_commissions_hint_dates_private()}</small
			>
		</fieldset>
	</fieldset>

	<div class="form-actions">
		<a href="/admin/commissions" class="btn btn-secondary">{m.admin_cancel()}</a>
		<button type="submit" class="btn btn-primary" aria-disabled={saving ? 'true' : undefined} bind:this={saveButton}>
			{#if saving}<Loader2 size={16} class="spin" aria-hidden="true" /> {m.admin_saving()}{:else}{isEdit
					? m.admin_commissions_save_changes()
					: m.admin_commissions_save_entry()}{/if}
		</button>
		{@render extraActions?.()}
	</div>
</form>

{#if showNewArtist}
	<!-- An artist made for a ledger entry starts private, so the nightly sync
	     leaves them alone even if the entry is never saved. -->
	<NewArtistDialog
		{registryEnabled}
		allowLedgerPrivate
		startPrivate
		initialName={artistSeed?.handle ?? ''}
		initialSocials={artistSeed ? { [artistSeed.platform]: artistSeed.handle } : undefined}
		prefillSource={artistSeed ? 'link' : undefined}
		prefillSite={artistSeed ? SOCIAL_PLATFORM_NAMES[artistSeed.platform] : ''}
		oncreated={onArtistCreated}
		onimportedall={async () => {
			showNewArtist = false;
			artistSeed = null;
			await invalidateAll();
		}}
		oncancel={() => {
			showNewArtist = false;
			artistSeed = null;
		}}
	/>
{/if}

<style>
	.form { display: flex; flex-direction: column; gap: 20px; max-width: 800px; }

	.gallery-panel {
		border: 1px solid var(--border); border-radius: var(--radius-s); padding: 16px;
		display: flex; flex-direction: column; gap: 12px; max-width: 800px; margin-bottom: 20px;
		background: var(--card);
	}
	.gallery-panel h2 { font-size: 16px; margin: 0; }
	.gallery-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	.gallery-row .text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 12rem; font-size: 14px; overflow-wrap: anywhere; }
	.gallery-row .text a { color: var(--foreground); text-decoration: underline; }
	.form fieldset {
		border: 1px solid var(--border); border-radius: var(--radius-s); padding: 16px;
		display: flex; flex-direction: column; gap: 16px; min-width: 0; margin: 0;
		container-type: inline-size;
	}
	.form legend { font-size: 14px; font-weight: 500; padding: 0 8px; }
	/* Dates: a legend that reads like a field label, over smaller muted labels. */
	.form fieldset.subgroup { border: none; border-radius: 0; padding: 0; gap: 6px; }
	.form fieldset.subgroup > legend { display: flex; align-items: center; gap: 8px; padding: 0; margin-bottom: 12px; }
	.form fieldset.subgroup .field-label { font-size: 13px; color: var(--muted-foreground); }
	.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.field-label { font-size: 14px; font-weight: 500; }
	.label-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.optional { font-weight: 400; color: var(--muted-foreground); font-size: 12px; }

	/* Paste a link: what the link named, and which artist that is. */
	.lookup {
		background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-s);
		padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere;
	}
	.lookup p { margin: 0; }
	.lookup-line { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
	.lookup-line .platform { color: var(--muted-foreground); font-size: 12px; }
	.lookup-line .handle { font-weight: 500; }
	.outcome { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; }
	.outcome :global(svg) { flex: none; margin-top: 3px; color: var(--status-ok); }
	/* The Use button sits beside the name it picks, not across the row. */
	.match { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	.match .name { font-size: 14px; font-weight: 500; }
	.lookup .hint a { color: var(--foreground); text-decoration: underline; }
	.lookup-msg { display: flex; align-items: flex-start; gap: 6px; margin: 0; }
	.lookup-msg :global(svg) { flex: none; margin-top: 2px; }
	.hint { font-size: 12px; color: var(--muted-foreground); line-height: 1.45; }
	.hint a { color: var(--foreground); text-decoration: underline; }
	/* After .hint, which it overrides at the same specificity. */
	.hint-warn { color: var(--status-warn); }
	.open-chat { align-self: flex-start; padding-block: 4px; font-size: 13px; color: var(--foreground); text-decoration: underline; }
	.draft-note { margin: 0; }
	/* A field with an error gets a red edge as well as its message. The edge
	   only adds to the text, which carries the error on its own; the
	   --destructive token measures at least 4.5:1 on --background in every
	   theme (theme-contrast.test.ts), above the 3:1 a border needs. */
	[aria-invalid='true'] { border-color: var(--destructive); }
	/* Focused, it keeps the red edge instead of the usual focus color. */
	[aria-invalid='true']:focus { outline-color: var(--destructive); outline-offset: 2px; }
	.field-error {
		display: flex; align-items: flex-start; gap: 6px; margin: 0;
		font-size: 12px; color: var(--destructive); line-height: 1.45;
	}
	.field-error :global(svg) { flex: none; margin-top: 2px; }
	.row-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
	.row-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
	/* The rows stack when their fieldset is narrow, whatever the window width. */
	@container (max-width: 520px) {
		.row-2, .row-3 { grid-template-columns: minmax(0, 1fr); }
	}
	/* A long "Add {handle} as a new artist" wraps: the label stays left-aligned
	   and the icon stays on its first line. 8px padding keeps a one-line button
	   at the 36px minimum, so it reads the same as before. */
	.add-artist-btn {
		display: inline-flex; align-items: flex-start; gap: 6px; align-self: flex-start; min-height: 36px;
		padding: 8px 12px; border: 1px solid var(--input); border-radius: var(--radius-pill);
		background: transparent; color: var(--foreground); font: inherit; font-size: 13px; text-align: left;
		cursor: pointer;
	}
	.add-artist-btn :global(svg) { flex: none; margin-top: calc((1lh - 14px) / 2); }
	.add-artist-btn:hover { border-color: var(--primary-text); color: var(--primary-text); }
	.add-artist-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
	.amount { max-width: 20rem; }
	.affix { font-size: 13px; font-weight: 500; white-space: nowrap; color: var(--muted-foreground); }
	/* The pill draws the field's edge and ring, so the error goes on the pill. */
	.amount:has([aria-invalid='true']) { border-color: var(--destructive); }
	.amount:has([aria-invalid='true']):focus-within { outline-color: var(--destructive); }

	.char-chips { display: flex; flex-wrap: wrap; gap: 8px; }
	/* A 1px edge on every chip and a check on the selected one, as on the tag
	   chips, so the state never rests on the fill alone. */
	.char-chip {
		position: relative;
		display: flex; flex-direction: row; align-items: center; gap: 6px;
		padding: 6px 12px; border-radius: var(--radius-pill);
		background: var(--secondary); border: 1px solid var(--input);
		font-size: 13px; cursor: pointer; max-width: 100%;
	}
	.char-chip > span:not(.chip-owner) { min-width: 0; overflow-wrap: anywhere; }
	.char-chip input { position: absolute; opacity: 0; width: 1px; height: 1px; }
	.char-chip.on {
		background: color-mix(in srgb, var(--primary) 14%, transparent);
		color: var(--foreground);
		border-color: var(--primary-text);
	}
	.char-chip.on :global(svg) { color: var(--primary-text); }
	.char-chip:has(input:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
	/* --foreground on both chip states: muted text on a chip fill drops below
	   4.5:1 in the terracotta light theme. */
	.chip-owner { color: var(--foreground); font-size: 11px; }

	.form-actions {
		display: flex; justify-content: flex-end; align-items: center;
		gap: 12px; padding-top: 8px; flex-wrap: wrap;
	}

	.error {
		color: var(--destructive); font-size: 14px; margin: 0 0 16px;
		display: flex; gap: 8px; align-items: flex-start; max-width: 800px;
	}
	.error > span { min-width: 0; overflow-wrap: anywhere; }
	.error a { color: inherit; text-decoration: underline; }
	.error :global(svg) { flex: none; margin-top: 2px; }
	.stale { display: flex; flex-direction: column; margin-bottom: 20px; max-width: 800px; }
	.why { margin: -8px 0 4px; font-size: 13px; }
	.why summary { color: var(--muted-foreground); cursor: pointer; width: fit-content; padding-block: 4px; }
	.why p { margin: 6px 0 0; line-height: 1.5; color: var(--foreground); max-width: 60ch; }
	.why-actions { justify-content: flex-start; }

	/* Cancel and Save share the row on a phone. */
	@media (max-width: 768px) {
		.form-actions > :is(a, button) { flex: 1; }
	}

</style>
