<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Check, CircleAlert, ImagePlus, Loader2, Plus, RefreshCw } from 'lucide-svelte';
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
		datesAfterStatusChange,
		FIELD_ORDER,
		formValuesOf,
		isCommissionStatus,
		localToday,
		mergeReloaded,
		staleMessage,
		type CommissionField,
		type CommissionFormEntry,
		type CommissionFormValues
	} from '$lib/commissions';
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
		/** Rendered last in the button row, such as Delete entry on the edit page. */
		extraActions?: Snippet;
	}

	let { artists, characters, entry = null, form = null, gaDate, extraActions }: Props = $props();

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
		const merged = mergeReloaded(fresh, loadedNote, typedNote);
		loaded = fresh;
		version = entry?.version ?? '';
		values = merged.values;
		restoredNote = merged.restoredNote;
		failure = null;
		staleText = '';
		announcer.say(
			merged.restoredNote ? m.admin_commissions_reloaded_announce_note() : m.admin_commissions_reloaded_announce()
		);
		await tick();
		(merged.restoredNote ? notesInput : titleInput)?.focus();
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

{#snippet fieldError(field: CommissionField)}
	{#if errors[field]}
		<p class="field-error" id="ce-{field}-err">
			<CircleAlert size={14} aria-hidden="true" /><span>{errors[field]}</span>
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
			<button type="button" class="btn btn-primary" onclick={reloadEntry}>
				<RefreshCw size={16} aria-hidden="true" />
				{m.admin_commissions_reload()}
			</button>
		</div>
	</div>
{/if}

{#snippet galleryButton(label: string, primary: boolean, described: boolean)}
	{@const tone = primary ? 'btn-primary' : 'btn-secondary'}
	{#if dirty}
		<button type="button" class="btn {tone}" aria-disabled="true" aria-describedby="ce-gallery-hint">
			{#if entry?.piece}<Plus size={16} aria-hidden="true" />{:else}<ImagePlus size={16} aria-hidden="true" />{/if}
			{label}
		</button>
	{:else}
		<a
			class="btn {tone}"
			href="/admin/upload?commission={entry?.id}"
			aria-describedby={described ? 'ce-gallery-hint' : undefined}
		>
			{#if entry?.piece}<Plus size={16} aria-hidden="true" />{:else}<ImagePlus size={16} aria-hidden="true" />{/if}
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

	<fieldset>
		<legend>{m.admin_commissions_legend_artist()}</legend>
		<div class="field">
			<div class="label-row">
				<label class="field-label" for="ce-sourceUrl">{m.admin_commissions_field_link()}</label>{@render optional()}
			</div>
			<input
				id="ce-sourceUrl"
				class="input"
				type="url"
				name="sourceUrl"
				autocomplete="off"
				bind:value={values.sourceUrl}
				aria-invalid={errors.sourceUrl ? 'true' : undefined}
				aria-describedby={describedBy('sourceUrl', 'ce-link-hint')}
			/>
			{@render fieldError('sourceUrl')}
			<small class="hint" id="ce-link-hint">{m.admin_commissions_hint_link()}</small>
		</div>
		<div class="field">
			<label class="field-label" for="ce-artistId">{m.admin_commissions_field_artist()}</label>
			<select
				id="ce-artistId"
				class="input"
				name="artistId"
				required
				bind:value={values.artistId}
				aria-invalid={errors.artistId ? 'true' : undefined}
				aria-describedby={describedBy('artistId', artists.length === 0 ? 'ce-no-artists' : '')}
			>
				<option value="">{m.admin_commissions_select_artist()}</option>
				{#each artists as artist (artist.id)}
					<option value={String(artist.id)}>{artist.name}</option>
				{/each}
			</select>
			{@render fieldError('artistId')}
			{#if artists.length === 0}
				<!-- The entry form doesn't create artists yet (the paste-a-link flow
				     does, in a later change), so point at the page that does. -->
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
				bind:value={values.kind}
				aria-invalid={errors.kind ? 'true' : undefined}
				aria-describedby={describedBy('kind')}
			/>
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
		<div class="field">
			<div class="price-row">
				<div class="field">
					<div class="label-row">
						<label class="field-label" for="ce-price">{m.admin_commissions_field_price()}</label>{@render optional()}
					</div>
					<input
						id="ce-price"
						class="input"
						type="text"
						name="price"
						inputmode="decimal"
						autocomplete="off"
						bind:value={values.price}
						aria-invalid={errors.price ? 'true' : undefined}
						aria-describedby={describedBy('price', 'ce-price-hint')}
					/>
				</div>
				<div class="field">
					<div class="label-row">
						<label class="field-label" for="ce-currency">{m.admin_commissions_field_currency()}</label>{@render optional()}
					</div>
					<input
						id="ce-currency"
						class="input currency"
						type="text"
						name="currency"
						maxlength="3"
						autocomplete="off"
						autocapitalize="characters"
						bind:value={values.currency}
						aria-invalid={errors.currency ? 'true' : undefined}
						aria-describedby={describedBy('currency', 'ce-price-hint')}
					/>
				</div>
			</div>
			{@render fieldError('price')}
			{@render fieldError('currency')}
			<small class="hint" id="ce-price-hint">{m.admin_commissions_hint_price()}</small>
		</div>
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
			<small class="hint" id="ce-dates-hint">{m.admin_commissions_hint_dates()}</small>
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

<style>
	.form { display: flex; flex-direction: column; gap: 20px; max-width: 800px; }

	.gallery-panel {
		border: 1px solid var(--border); border-radius: var(--radius-s); padding: 16px;
		display: flex; flex-direction: column; gap: 12px; max-width: 800px; margin-bottom: 20px;
	}
	.gallery-panel h2 { font-size: 14px; font-weight: 500; margin: 0; }
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
	.hint { font-size: 12px; color: var(--muted-foreground); line-height: 1.45; }
	.hint a { color: var(--foreground); text-decoration: underline; }
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
	.price-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(5rem, 7.5rem); gap: 12px; align-items: end; }
	.currency { text-transform: uppercase; }

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
