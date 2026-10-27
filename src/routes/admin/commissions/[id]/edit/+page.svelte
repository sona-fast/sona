<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ArrowLeft, Loader2, Trash2 } from 'lucide-svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import CommissionForm from '$lib/components/CommissionForm.svelte';
	import CommissionIntro from '$lib/components/CommissionIntro.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { commissionDateRows, PAYMENT_LABELS, STATUS_LABELS, STATUS_TONES } from '$lib/commissions';
	import * as m from '$lib/paraglide/messages';
	import { draftSnapshot } from '$lib/drafts';

	let { data, form } = $props();

	// Null only after a save without JavaScript found the entry deleted elsewhere.
	const entry = $derived(data.entry);
	const dateRows = $derived(entry ? commissionDateRows(entry) : []);
	// The form stands on what that refused save sent, which `form` carries.
	const goneEntry = $derived({
		id: Number(page.params.id),
		version: form?.version ?? '',
		artistId: 0,
		title: '',
		kind: null,
		sourceUrl: null,
		characters: [],
		status: 'applied' as const,
		payment: 'unpaid' as const,
		price: '',
		currency: null,
		notes: null,
		requestedOn: null,
		acceptedOn: null,
		deliveredOn: null,
		piece: null
	});

	let confirmingDelete = $state(false);
	let deleting = $state(false);
	let deleteForm = $state<HTMLFormElement>();
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	// Without the page's script, Delete entry opens this page with
	// ?delete=confirm, which draws the confirmation in the page.
	const confirmingInPage = $derived(page.url.searchParams.get('delete') === 'confirm');

	const deleteMessage = $derived(
		!entry
			? ''
			: entry.piece
				? m.admin_commissions_delete_message_linked({
						title: entry.title,
						piece: entry.piece.title,
						artist: entry.artistName
					})
				: m.admin_commissions_delete_message({ title: entry.title, artist: entry.artistName })
	);

	// The draft survives following a link off the page (the lookup's "Artists
	// page") and coming back with the browser's Back button. The form decides
	// what a draft is and when there's one.
	let commissionForm = $state<ReturnType<typeof CommissionForm>>();
	export const snapshot = draftSnapshot(() => commissionForm);

	const enhanceDelete: SubmitFunction = () => {
		deleting = true;
		return async ({ update, result }) => {
			// An error result would replace the page with the error page and drop
			// unsaved typing, so it stays here with a toast, as a failed save does.
			if (result.type !== 'error') await update({ reset: false });
			deleting = false;
			// Already deleted somewhere else: the delete is done either way.
			if (result.type === 'failure' && (result.data as { missing?: boolean } | undefined)?.missing) {
				await goto('/admin/commissions');
			} else if (result.type === 'failure') toast.error(m.admin_commissions_delete_failed());
			else if (result.type === 'error') toast.error(m.admin_something_wrong());
		};
	};
</script>

{#snippet deleteButton()}
	<span class="delete-slot">{#if hydrated}<button
		type="button"
		class="btn btn-outline danger"
		disabled={deleting}
		onclick={() => (confirmingDelete = true)}
	>
		{#if deleting}<Loader2 size={16} class="spin" aria-hidden="true" />{:else}<Trash2 size={16} aria-hidden="true" />{/if}
		{m.admin_commissions_delete_entry()}
	</button>{:else}<a class="btn btn-outline danger" href="/admin/commissions/{page.params.id}/edit?delete=confirm#delete-confirm">
		<Trash2 size={16} aria-hidden="true" />
		{m.admin_commissions_delete_entry()}
	</a>{/if}</span>
{/snippet}

<a class="back-link" href="/admin/commissions"><ArrowLeft size={16} aria-hidden="true" /> {m.admin_commissions_back()}</a>
<div class="page-header">
	<h1>{data.gate.open || !entry ? m.admin_commissions_edit_title() : entry.title}</h1>
</div>
{#if entry && confirmingInPage}
	<!-- The dialog's confirmation as part of the page, for a browser without
	     the page's script. The link here names it as the fragment, so the
	     browser scrolls to it, and it's a labelled region for a screen reader. -->
	<section class="delete-confirm" id="delete-confirm" tabindex="-1" aria-labelledby="delete-confirm-title">
		<h2 id="delete-confirm-title">{m.admin_commissions_delete_title()}</h2>
		<p>{deleteMessage}</p>
		<form method="POST" action="?/delete" class="delete-confirm-actions" use:enhance={enhanceDelete}>
			<a class="btn btn-secondary" href="/admin/commissions/{entry.id}/edit">{m.admin_cancel()}</a>
			<button type="submit" class="btn btn-destructive" disabled={deleting}>{m.admin_delete()}</button>
		</form>
	</section>
{/if}
<CommissionIntro gate={data.gate} />

{#if !entry}
	<!-- Saved without JavaScript after the entry was deleted elsewhere: the
	     form keeps what was sent, under the alert that says so. -->
	<CommissionForm
		artists={data.artists}
		characters={data.characters}
		entry={goneEntry}
		{form}
		gaDate={data.gate.gaDate}
		recentCurrencies={data.recentCurrencies}
		localeCurrency={data.localeCurrency}
		registryEnabled={data.registryEnabled}
	/>
{:else if data.gate.open}
	<CommissionForm
		bind:this={commissionForm}
		artists={data.artists}
		characters={data.characters}
		{entry}
		{form}
		gaDate={data.gate.gaDate}
		recentCurrencies={data.recentCurrencies}
		localeCurrency={data.localeCurrency}
		registryEnabled={data.registryEnabled}
		extraActions={deleteButton}
	/>
{:else}
	<!-- Read-only while the gate is closed. Dates show as plain dates, never as
	     a span between them or a time ago (SONA-9). -->
	<div class="readonly">
		<section class="ro-section" aria-labelledby="ro-gallery">
			<h2 id="ro-gallery">{m.admin_commissions_legend_gallery()}</h2>
			{#if entry.piece}
				<p><a href="/admin/images/{entry.piece.id}/edit">{entry.piece.title}</a></p>
			{:else}
				<p>{m.admin_commissions_not_in_gallery()}</p>
			{/if}
		</section>

		<section class="ro-section" aria-labelledby="ro-artist">
			<h2 id="ro-artist">{m.admin_commissions_legend_artist()}</h2>
			<dl class="ro-list">
				{#if entry.sourceUrl}
					<div>
						<dt>{m.admin_commissions_field_link()}</dt>
						<dd><a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{entry.sourceUrl}</a></dd>
					</div>
				{/if}
				<div>
					<dt>{m.admin_commissions_field_artist()}</dt>
					<dd><span class="artist-cell"><ArtistAvatar name={entry.artistName} avatarUrl={entry.artistAvatarUrl} size={28} />{entry.artistName}</span></dd>
				</div>
			</dl>
		</section>

		<section class="ro-section" aria-labelledby="ro-commission">
			<h2 id="ro-commission">{m.admin_commissions_legend_commission()}</h2>
			<dl class="ro-list">
				{#if entry.kind}
					<div><dt>{m.admin_commissions_field_kind()}</dt><dd>{entry.kind}</dd></div>
				{/if}
				<div>
					<dt>{m.admin_commissions_field_characters()}</dt>
					<dd>
						{entry.characters.length > 0
							? entry.characters.map((c) => c.name).join(', ')
							: m.admin_commissions_chars_none()}
					</dd>
				</div>
				{#if entry.notes}
					<div><dt>{m.admin_commissions_field_notes()}</dt><dd class="notes">{entry.notes}</dd></div>
				{/if}
			</dl>
		</section>

		<section class="ro-section" aria-labelledby="ro-progress">
			<h2 id="ro-progress">{m.admin_commissions_legend_progress()}</h2>
			<dl class="ro-list">
				<div>
					<dt>{m.admin_commissions_field_status()}</dt>
					<dd><span class="chip {STATUS_TONES[entry.status]}">{STATUS_LABELS[entry.status]()}</span></dd>
				</div>
				<div><dt>{m.admin_commissions_field_payment()}</dt><dd>{PAYMENT_LABELS[entry.payment]()}</dd></div>
				{#if entry.price && entry.currency}
					<div>
						<dt>{m.admin_commissions_field_price()}</dt>
						<dd>{m.admin_commissions_price_display({ price: entry.price, currency: entry.currency })}</dd>
					</div>
				{/if}
				{#each dateRows as row (row.label)}
					<div><dt>{row.label}</dt><dd>{row.value}</dd></div>
				{/each}
			</dl>
		</section>
	</div>
	<div class="readonly-actions">
		{@render deleteButton()}
	</div>
{/if}

<!-- Never gated: an owner can always remove their own private data. -->
<form
	method="POST"
	action="?/delete"
	bind:this={deleteForm}
	hidden
	use:enhance={enhanceDelete}
></form>

{#if confirmingDelete}
	<ConfirmDialog
		title={m.admin_commissions_delete_title()}
		message={deleteMessage}
		onconfirm={() => {
			confirmingDelete = false;
			deleteForm?.requestSubmit();
		}}
		oncancel={() => (confirmingDelete = false)}
	/>
{/if}

<style>
	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }
	.page-header { margin-bottom: 12px; }
	.page-header h1 { font-size: 24px; margin: 0; overflow-wrap: anywhere; }

	.readonly { display: flex; flex-direction: column; gap: 20px; max-width: 800px; }
	.ro-section {
		border: 1px solid var(--border); border-radius: var(--radius-s); padding: 16px;
		display: flex; flex-direction: column; gap: 8px; container-type: inline-size;
	}
	.ro-section h2 { font-size: 16px; margin: 0; }
	.ro-section > p { font-size: 14px; margin: 0; }
	.ro-list { margin: 0; }
	.ro-list > div {
		display: grid; grid-template-columns: 12rem minmax(0, 1fr); gap: 4px 16px;
		padding: 10px 0; border-top: 1px solid var(--border); font-size: 14px;
	}
	.ro-list > div:first-child { border-top: none; }
	.ro-list dt { color: var(--muted-foreground); font-size: 13px; }
	.ro-list dd { margin: 0; overflow-wrap: anywhere; line-height: 1.5; }
	.ro-list dd.notes { white-space: pre-line; }
	@container (max-width: 480px) {
		.ro-list > div { grid-template-columns: minmax(0, 1fr); }
	}
	.artist-cell { display: inline-flex; align-items: center; gap: 10px; }
	.chip {
		display: inline-block; padding: 2px 8px; border-radius: var(--radius-pill);
		font-size: 11px; font-weight: 500; white-space: nowrap;
		background: var(--secondary); color: var(--foreground); border: 1px solid transparent;
	}
	.chip.progress { background: color-mix(in srgb, var(--primary) 16%, transparent); }
	.chip.done { background: color-mix(in srgb, var(--status-ok) 15%, transparent); }
	.chip.closed { background: transparent; border-color: var(--input); }
	.readonly-actions { max-width: 800px; display: flex; margin-top: 20px; }

	.delete-confirm {
		max-width: 800px; margin-bottom: 20px; padding: 16px;
		border: 1px solid var(--destructive); border-radius: var(--radius-s);
		display: flex; flex-direction: column; gap: 8px;
	}
	.delete-confirm h2 { font-size: 16px; margin: 0; }
	.delete-confirm p { font-size: 14px; margin: 0; line-height: 1.5; max-width: 60ch; }
	.delete-confirm-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }

	/* The outline variant in the destructive color, as the shipped Delete
	   avatar button draws it. The fill stays --background on hover: the
	   outline variant's tinted hover fill drops this red label under 4.5:1 in
	   several themes, so hover shows as an underline instead. theme-contrast.test.ts
	   measures --destructive on --background in every theme × mode. */
	.danger { color: var(--destructive); border-color: var(--destructive); }
	.delete-slot .danger:hover { background-color: var(--background); text-decoration: underline; }
	.danger:disabled { opacity: 0.55; cursor: progress; }

	/* Delete sits apart from Save: on the left on a wide screen, on its own row
	   below on a phone, as the mocks draw it. */
	:global(.form-actions) .delete-slot { order: -1; margin-right: auto; }
	@media (max-width: 768px) {
		:global(.form-actions) .delete-slot { order: 0; flex-basis: 100%; margin: 16px 0 0; }
	}
</style>
