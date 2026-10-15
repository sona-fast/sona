<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Check, CircleAlert, Loader2, RefreshCw } from 'lucide-svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import { toast } from '$lib/toast.svelte';
	import {
		COMMISSION_PAYMENTS,
		COMMISSION_STATUSES,
		PAYMENT_LABELS,
		STATUS_LABELS,
		datesAfterStatusChange,
		localToday,
		type CommissionPayment,
		type CommissionStatus
	} from '$lib/commissions';
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	/** The entry as the edit page loads it. `version` is the row's updated_at:
	 * the save sends it back so the server can refuse an out-of-date form. It is
	 * never shown. */
	interface EntryInit {
		artistId: number;
		title: string;
		kind: string | null;
		sourceUrl: string | null;
		characters: { id: number }[];
		status: CommissionStatus;
		payment: CommissionPayment;
		price: string;
		currency: string | null;
		notes: string | null;
		requestedOn: string | null;
		acceptedOn: string | null;
		deliveredOn: string | null;
		version: string;
	}
	interface FailureData {
		errors?: Partial<Record<Field, string>>;
		gated?: boolean;
		stale?: boolean;
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

	type Field =
		| 'artistId'
		| 'title'
		| 'kind'
		| 'sourceUrl'
		| 'characterIds'
		| 'status'
		| 'payment'
		| 'price'
		| 'currency'
		| 'notes'
		| 'requestedOn'
		| 'acceptedOn'
		| 'deliveredOn';

	// The page never swaps a create form into an edit form, so the first value holds.
	// svelte-ignore state_referenced_locally
	const isEdit = entry !== null;

	interface Values {
		artistId: string;
		title: string;
		kind: string;
		sourceUrl: string;
		characterIds: number[];
		status: CommissionStatus;
		payment: CommissionPayment;
		price: string;
		currency: string;
		notes: string;
		requestedOn: string;
		acceptedOn: string;
		deliveredOn: string;
	}
	function valuesOf(e: EntryInit | null): Values {
		return {
			artistId: e ? String(e.artistId) : '',
			title: e?.title ?? '',
			kind: e?.kind ?? '',
			sourceUrl: e?.sourceUrl ?? '',
			characterIds: e ? e.characters.map((c) => c.id) : [],
			status: e?.status ?? 'applied',
			payment: e?.payment ?? 'unpaid',
			price: e?.price ?? '',
			currency: e?.currency ?? '',
			notes: e?.notes ?? '',
			requestedOn: e?.requestedOn ?? '',
			acceptedOn: e?.acceptedOn ?? '',
			deliveredOn: e?.deliveredOn ?? ''
		};
	}

	// What the form opened with, for naming what the owner changed when a save
	// is refused as out of date. Replaced on Reload entry.
	// svelte-ignore state_referenced_locally
	let loaded = $state(valuesOf(entry));
	// svelte-ignore state_referenced_locally
	let version = $state(entry?.version ?? '');
	// svelte-ignore state_referenced_locally
	let values = $state(valuesOf(entry));

	let saving = $state(false);
	// The refusal on screen. Cleared when a new save starts or the entry reloads,
	// so an answered refusal doesn't linger above a fresh form.
	let failure = $state<FailureData | null>(null);
	$effect(() => {
		failure = form ?? null;
	});
	const errors = $derived(failure?.errors ?? {});
	// After Reload entry put an unsaved note back: which hint Notes shows.
	let restoredNote = $state<'' | 'kept' | 'replaces'>('');

	const announcer = new Announcer();
	let staleBox = $state<HTMLElement>();
	let gateBox = $state<HTMLElement>();
	let notesInput = $state<HTMLTextAreaElement>();
	let titleInput = $state<HTMLInputElement>();

	// Moving to Accepted or Delivered fills that step's empty date with today
	// (open question Q17, built as drawn). The owner can change or clear it.
	function onStatusChange() {
		const next = datesAfterStatusChange(values.status, values, localToday());
		values.requestedOn = next.requestedOn;
		values.acceptedOn = next.acceptedOn;
		values.deliveredOn = next.deliveredOn;
	}

	function toggleCharacter(id: number) {
		values.characterIds = values.characterIds.includes(id)
			? values.characterIds.filter((c) => c !== id)
			: [...values.characterIds, id];
	}

	// Field labels for the out-of-date message, as static references.
	const FIELD_LABELS: Record<Exclude<Field, 'notes'>, () => string> = {
		artistId: m.admin_commissions_field_artist,
		title: m.admin_commissions_field_title,
		kind: m.admin_commissions_field_kind,
		sourceUrl: m.admin_commissions_field_link,
		characterIds: m.admin_commissions_field_characters,
		status: m.admin_commissions_field_status,
		payment: m.admin_commissions_field_payment,
		price: m.admin_commissions_field_price,
		currency: m.admin_commissions_field_currency,
		requestedOn: m.admin_commissions_field_requested,
		acceptedOn: m.admin_commissions_field_accepted,
		deliveredOn: m.admin_commissions_field_delivered
	};

	/** The fields besides Notes that the owner changed since the form loaded. */
	function changedFields(): string[] {
		return (Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[])
			.filter((field) => {
				const now = values[field];
				const then = loaded[field];
				return Array.isArray(now) && Array.isArray(then)
					? [...now].sort().join() !== [...then].sort().join()
					: now !== then;
			})
			.map((field) => FIELD_LABELS[field]());
	}

	const noteChanged = $derived(values.notes !== loaded.notes);
	const staleDetail = $derived.by(() => {
		if (!failure?.stale) return '';
		const changed = changedFields();
		const fields = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(changed);
		if (noteChanged) {
			return changed.length > 0
				? m.admin_commissions_stale_note_and_fields({ fields })
				: m.admin_commissions_stale_note();
		}
		return changed.length > 0 ? m.admin_commissions_stale_fields({ fields }) : '';
	});

	/** Loads the entry as it is now, and puts the unsaved note back in Notes. */
	async function reloadEntry() {
		const typedNote = values.notes;
		const ownerChangedNote = noteChanged;
		const noteBefore = loaded.notes;
		await invalidateAll();
		// The page passes the reloaded entry back in through `entry`.
		const fresh = valuesOf(entry);
		loaded = fresh;
		version = entry?.version ?? '';
		values = { ...fresh, notes: ownerChangedNote ? typedNote : fresh.notes };
		failure = null;
		if (ownerChangedNote) {
			restoredNote = fresh.notes !== noteBefore ? 'replaces' : 'kept';
			announcer.say(m.admin_commissions_reloaded_announce_note());
			await tick();
			notesInput?.focus();
		} else {
			restoredNote = '';
			announcer.say(m.admin_commissions_reloaded_announce());
			await tick();
			titleInput?.focus();
		}
	}

	const DATE_FIELDS = [
		['requestedOn', m.admin_commissions_field_requested],
		['acceptedOn', m.admin_commissions_field_accepted],
		['deliveredOn', m.admin_commissions_field_delivered]
	] as const;

	const FIELD_ORDER: Field[] = [
		'sourceUrl',
		'artistId',
		'title',
		'kind',
		'characterIds',
		'notes',
		'status',
		'payment',
		'price',
		'currency',
		'requestedOn',
		'acceptedOn',
		'deliveredOn'
	];

	async function focusFailure() {
		await tick();
		if (failure?.stale) staleBox?.focus();
		else if (failure?.gated) gateBox?.focus();
		else {
			const first = FIELD_ORDER.find((f) => errors[f]);
			if (first) document.getElementById(`ce-${first}`)?.focus();
		}
	}

	/** aria-describedby for a field: its error first, then its hints. */
	function describedBy(field: Field, ...hints: string[]): string | undefined {
		const ids = [errors[field] ? `ce-${field}-err` : '', ...hints].filter(Boolean);
		return ids.length > 0 ? ids.join(' ') : undefined;
	}
</script>

{#snippet fieldError(field: Field)}
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

{#if failure?.stale}
	<div class="stale">
		<div class="error" role="alert" tabindex="-1" bind:this={staleBox}>
			<CircleAlert size={16} aria-hidden="true" />
			<span>{m.admin_commissions_stale()}{staleDetail ? ` ${staleDetail}` : ''}</span>
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

<form
	method="POST"
	action={isEdit ? '?/save' : undefined}
	class="form entry-form"
	novalidate
	use:enhance={() => {
		saving = true;
		failure = null;
		return async ({ update, result }) => {
			// A save redirects to the ledger, which enhance follows. Only refusals
			// stay on this page, and they keep what the owner typed.
			await update({ reset: false });
			saving = false;
			if (result.type === 'failure') {
				failure = (result.data as FailureData | undefined) ?? null;
				if (!failure?.errors && !failure?.gated && !failure?.stale) toast.error(m.admin_commissions_save_failed());
				await focusFailure();
			} else if (result.type === 'error') {
				toast.error(m.admin_something_wrong());
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
				aria-describedby={describedBy('artistId')}
			>
				<option value="">{m.admin_commissions_select_artist()}</option>
				{#each artists as artist (artist.id)}
					<option value={String(artist.id)}>{artist.name}</option>
				{/each}
			</select>
			{@render fieldError('artistId')}
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
				maxlength="120"
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
				maxlength="60"
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
				maxlength="2000"
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
		<fieldset class="subgroup" aria-describedby="ce-dates-hint">
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
		<button type="submit" class="btn btn-primary" disabled={saving}>
			{#if saving}<Loader2 size={16} class="spin" aria-hidden="true" /> {m.admin_saving()}{:else}{isEdit
					? m.admin_commissions_save_changes()
					: m.admin_commissions_save_entry()}{/if}
		</button>
		{@render extraActions?.()}
	</div>
</form>

<style>
	.form { display: flex; flex-direction: column; gap: 20px; max-width: 800px; }
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

</style>
