<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Search, Plus, Pencil, Trash2, X, Share2, Loader2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import { toast } from '$lib/toast.svelte';
	import { formatDate } from '$lib';
	import * as m from '$lib/paraglide/messages';
	import { worksLabel, deleteBlockersLabel } from './works-label';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';

	let { data, form } = $props();

	let search = $state(data.q ?? '');
	let showAdd = $state(false);
	let editingArtist = $state<typeof data.artists[0] | null>(null);
	// Why the edit form's Keep private box can't apply, or null when it can.
	const privateBlocked = $derived(
		!editingArtist
			? null
			: editingArtist.hasPublicWork
				? m.admin_artists_ledger_private_public_work({ name: editingArtist.name })
				: editingArtist.globalId && !editingArtist.ledgerPrivate
					? m.admin_artists_ledger_private_shared({ name: editingArtist.name })
					: null
	);
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	let saving = $state(false);
	let deletingId = $state<number | null>(null);
	// Escape hides a blocked Delete's reason without moving focus or the
	// pointer (WCAG 1.4.13); the next hover or focus on a Delete shows it again.
	let tipDismissed = $state(false);
	let submittingId = $state<number | null>(null);
	let refreshingAvatars = $state(false);
	// Submit to registry for a Keep private artist (SONA-236): the server refuses
	// without confirmPrivate, and the page asks before resubmitting with it.
	type ShareTarget = { id: number; globalId: string | null; trigger?: HTMLElement | null };
	let confirmShare = $state<ShareTarget | null>(null);
	let confirmShareForm: HTMLFormElement;

	// The enhance callback for every Submit to registry form: the desktop row, the
	// mobile row, and the hidden Share anyway form (which reads its target when it
	// submits). A 409 with confirmPrivate opens the Share anyway dialog instead of a
	// toast. The Share button is disabled while its request is in flight, so focus
	// falls to <body>; it goes back to that button when the request settles, before
	// the dialog opens, so the dialog's focus trap returns it there on Cancel or
	// Escape too.
	function shareEnhance(getTarget: () => ShareTarget | null): SubmitFunction {
		return ({ submitter }) => {
			const target = getTarget();
			const trigger = submitter ?? target?.trigger ?? null;
			submittingId = target?.id ?? null;
			confirmShare = null;
			return async ({ result, update }) => {
				await update();
				submittingId = null;
				await tick();
				trigger?.focus();
				if (result.type === 'success')
					toast.success(target?.globalId ? m.admin_artists_registry_update_submitted() : m.admin_artists_registry_submitted());
				else if (result.type === 'failure' && result.data?.confirmPrivate && target)
					confirmShare = { id: target.id, globalId: target.globalId, trigger };
				else if (result.type === 'failure')
					toast.error((result.data?.error as string) ?? m.admin_artists_registry_failed());
			};
		};
	}

	// Search runs SERVER-SIDE across all artists (not just the current page).
	// Debounce keystrokes into a ?q= navigation; keepFocus so typing isn't interrupted.
	let searchTimer: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const params = new URLSearchParams();
			if (search.trim()) params.set('q', search.trim());
			goto(`?${params.toString()}`, { replaceState: true, keepFocus: true });
		}, 250);
	}

	// Why the Share button is disabled (or what it does): an AKA-linked row (#71)
	// explains itself via the registry artist's name; an up-to-date row says so;
	// otherwise it's the plain submit label. Used for both title and aria-label.
	function shareLabel(id: number): string {
		const aliasOf = data.aliasLinked?.[id];
		if (aliasOf) return m.admin_artists_alias_linked({ name: aliasOf });
		if (data.upToDate?.[id]) return m.admin_artists_up_to_date();
		return m.admin_artists_submit_registry();
	}

	// Delete for a row. A blocked artist's button is aria-disabled, so it stays
	// focusable and its reason can be read; a click says the reason instead of
	// asking to delete. The server still refuses on its own (the list can be stale).
	function onDelete(artist: { id: number; name: string }, blocked: string | null) {
		if (blocked) toast.info(blocked);
		else deleteTarget = { id: artist.id, name: artist.name };
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (tipDismissed = true)} />

<!-- One row's Delete, for the desktop table and the mobile list. idPrefix keeps
     the two copies' tooltip ids apart. -->
{#snippet deleteButton(artist: (typeof data.artists)[number], idPrefix: string)}
	{@const blocked = deleteBlockersLabel(artist)}
	<!-- The handlers only bring a dismissed reason back; the button is the control. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span class="delete-wrap" class:tip-dismissed={tipDismissed} onpointerenter={() => (tipDismissed = false)} onfocusin={() => (tipDismissed = false)}>
		<button class="icon-btn" aria-label={m.admin_artists_delete_aria()} aria-disabled={blocked ? 'true' : undefined} aria-describedby={blocked ? `${idPrefix}${artist.id}` : undefined} disabled={deletingId === artist.id} onclick={() => onDelete(artist, blocked)}>
			{#if deletingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
		</button>
		{#if blocked}<span class="blocked-tip" role="tooltip" id="{idPrefix}{artist.id}">{blocked}</span>{/if}
	</span>
{/snippet}

<div class="page-header">
	<h1>{m.admin_nav_artists()} <span class="count">{m.admin_count_artists({ count: data.total })}</span></h1>
	<div class="header-actions">
		<form
			method="POST"
			action="?/refreshAvatars"
			use:enhance={() => {
				refreshingAvatars = true;
				return async ({ update }) => {
					await update({ reset: false });
					refreshingAvatars = false;
				};
			}}
		>
			<button class="btn btn-secondary btn-desktop-only" type="submit" disabled={refreshingAvatars}>
				{#if refreshingAvatars}<Loader2 size={16} class="spin" />{/if}
				{refreshingAvatars ? m.admin_artists_refresh_avatars_busy() : m.admin_artists_refresh_avatars()}
			</button>
		</form>
		<button class="btn btn-primary btn-desktop-only" onclick={() => (showAdd = true)}><Plus size={16} /> {m.admin_artists_add()}</button>
	</div>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<!-- The registry refused this fork's key: the sharing badges below are stale/blank,
     which would otherwise look like "nothing is shared yet". -->
{#if data.registryError}
	<p class="error">
		{data.registryOpaque
			? m.admin_artists_registry_unreachable({ reason: data.registryError })
			: m.admin_artists_registry_refused({ reason: data.registryError })}
	</p>
{/if}

{#if form?.avatarRefresh}
	<p class="notice">
		{#if form.avatarRefresh.processed === 0}
			{m.admin_artists_refresh_avatars_none()}
		{:else}
			{m.admin_artists_refresh_avatars_result({
				refreshed: form.avatarRefresh.refreshed,
				processed: form.avatarRefresh.processed,
				remaining: form.avatarRefresh.remaining
			})}
		{/if}
	</p>
{/if}

<div class="toolbar">
	<div class="search-wrapper">
		<Search size={16} class="search-icon" />
		<input type="search" class="input search" placeholder={m.admin_artists_search_placeholder()} bind:value={search} oninput={onSearchInput} />
	</div>
</div>

<div class="table-wrapper">
	<table class="data-table">
		<thead>
			<tr>
				<th class="col-avatar"></th>
				<th>{m.admin_artists_col_name()}</th>
				<th>{m.admin_artists_col_works()}</th>
				<th>{m.admin_artists_col_social()}</th>
				<th class="col-actions">{m.admin_col_actions()}</th>
			</tr>
		</thead>
		<tbody>
			{#each data.artists as artist}
				<tr>
					<td class="col-avatar">
						<ArtistAvatar name={artist.name} avatarUrl={artist.avatarUrl} size={36} />
					</td>
					<td class="artist-name">
						{artist.name}
						{#if artist.globalId}<span class="reg-badge" title={m.admin_artists_shared_title()}>{m.admin_artists_badge_shared()}</span>{/if}
						{#if artist.ledgerPrivate && !artist.hasPublicWork}<span class="reg-badge private">{m.admin_artists_badge_private()}</span>{/if}
						{#if data.registryStatus?.[artist.id]?.status === 'pending'}<span class="reg-badge pending" title={m.admin_artists_pending_title()}>{m.admin_artists_badge_pending()}</span>{/if}
						{#if data.registryStatus?.[artist.id]?.status === 'rejected'}<span class="reg-badge rejected" title={data.registryStatus[artist.id].note ? m.admin_artists_rejected_note({ note: data.registryStatus[artist.id].note ?? '' }) : m.admin_artists_rejected_title()}>{m.admin_artists_badge_rejected()}</span><form method="POST" action="?/dismissRejection" style="display:inline" use:enhance={() => {
							return async ({ result, update }) => {
								await update();
								if (result.type === 'success') toast.success(m.admin_artists_rejection_dismissed());
							};
						}}><input type="hidden" name="submissionId" value={data.registryStatus[artist.id].submissionId} /><button class="reg-dismiss" type="submit" aria-label={m.admin_artists_dismiss_rejection()} title={m.admin_artists_dismiss_rejection()}>×</button></form>{/if}
						{#if artist.formerly.length}<span class="aka-hint">{m.admin_artists_formerly({ names: artist.formerly.join(', ') })}</span>{/if}
					</td>
					<td class="artwork-count"><span class="works-label">{worksLabel(artist)}</span></td>
					<td>
						<div class="social-icons">
							{#if artist.twitterUrl}
								<a href={artist.twitterUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'Twitter' })} class="social-icon"><TwitterIcon size={14} /></a>
							{/if}
							{#if artist.blueskyUrl}
								<a href={artist.blueskyUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'Bluesky' })} class="social-icon"><BlueskyIcon size={14} /></a>
							{/if}
							{#if artist.telegramUrl}
								<a href={artist.telegramUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'Telegram' })} class="social-icon"><TelegramIcon size={14} /></a>
							{/if}
							{#if artist.furAffinityUrl}
								<a href={artist.furAffinityUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'FurAffinity' })} class="social-icon"><FurAffinityIcon size={14} /></a>
							{/if}
							{#if artist.deviantArtUrl}
								<a href={artist.deviantArtUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'DeviantArt' })} class="social-icon"><DeviantArtIcon size={14} /></a>
							{/if}
							{#if artist.patreonUrl}
								<a href={artist.patreonUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'Patreon' })} class="social-icon"><PatreonIcon size={14} /></a>
							{/if}
							{#if artist.instagramUrl}
								<a href={artist.instagramUrl} target="_blank" rel="noopener" aria-label={m.common_social_link({ name: artist.name, platform: 'Instagram' })} class="social-icon"><InstagramIcon size={14} /></a>
							{/if}
						</div>
					</td>
					<td class="col-actions">
						{#if data.registryEnabled}
							<form
								method="POST"
								action="?/submitToRegistry"
								style="display:inline"
								use:enhance={shareEnhance(() => artist)}
							>
								<input type="hidden" name="id" value={artist.id} />
								<button class="icon-btn" type="submit" disabled={submittingId !== null || data.upToDate?.[artist.id] || !!data.aliasLinked?.[artist.id]} aria-busy={submittingId === artist.id} aria-label={shareLabel(artist.id)} title={shareLabel(artist.id)}>
									{#if submittingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Share2 size={16} />{/if}
								</button>
							</form>
						{/if}
						<button class="icon-btn" aria-label={m.admin_artists_edit_aria()} onclick={() => (editingArtist = artist)}>
							<Pencil size={16} />
						</button>
						{@render deleteButton(artist, 'delete-blocked-')}
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="5" class="empty">
						{#if search}
							{m.admin_artists_no_match({ search })}
						{:else}
							{m.admin_artists_empty()}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each data.artists as artist}
		<div class="mobile-artist-item">
			<ArtistAvatar name={artist.name} avatarUrl={artist.avatarUrl} size={36} />
			<div class="mobile-artist-info">
				<p class="mobile-artist-name">{artist.name}</p>
				{#if artist.formerly.length}<p class="aka-hint">{m.admin_artists_formerly({ names: artist.formerly.join(', ') })}</p>{/if}
				{#if artist.globalId || (artist.ledgerPrivate && !artist.hasPublicWork) || data.registryStatus?.[artist.id]}
					<div class="mobile-artist-badges">
						{#if artist.globalId}<span class="reg-badge" title={m.admin_artists_shared_title()}>{m.admin_artists_badge_shared()}</span>{/if}
						{#if artist.ledgerPrivate && !artist.hasPublicWork}<span class="reg-badge private">{m.admin_artists_badge_private()}</span>{/if}
						{#if data.registryStatus?.[artist.id]?.status === 'pending'}<span class="reg-badge pending" title={m.admin_artists_pending_title()}>{m.admin_artists_badge_pending()}</span>{/if}
						{#if data.registryStatus?.[artist.id]?.status === 'rejected'}<span class="reg-badge rejected" title={data.registryStatus[artist.id].note ? m.admin_artists_rejected_note({ note: data.registryStatus[artist.id].note ?? '' }) : m.admin_artists_rejected_title()}>{m.admin_artists_badge_rejected()}</span><form method="POST" action="?/dismissRejection" style="display:inline" use:enhance={() => {
							return async ({ result, update }) => {
								await update();
								if (result.type === 'success') toast.success(m.admin_artists_rejection_dismissed());
							};
						}}><input type="hidden" name="submissionId" value={data.registryStatus[artist.id].submissionId} /><button class="reg-dismiss" type="submit" aria-label={m.admin_artists_dismiss_rejection()} title={m.admin_artists_dismiss_rejection()}>×</button></form>{/if}
					</div>
				{/if}
				<p class="mobile-artist-meta">
					<span class="works-label">{worksLabel(artist)}</span>
					{#if artist.twitterUrl}<span class="mobile-social-icon"><TwitterIcon size={10} /><span class="sr-only">Twitter</span></span>{/if}
					{#if artist.blueskyUrl}<span class="mobile-social-icon"><BlueskyIcon size={10} /><span class="sr-only">Bluesky</span></span>{/if}
					{#if artist.telegramUrl}<span class="mobile-social-icon"><TelegramIcon size={10} /><span class="sr-only">Telegram</span></span>{/if}
					{#if artist.furAffinityUrl}<span class="mobile-social-icon"><FurAffinityIcon size={10} /><span class="sr-only">FurAffinity</span></span>{/if}
					{#if artist.deviantArtUrl}<span class="mobile-social-icon"><DeviantArtIcon size={10} /><span class="sr-only">DeviantArt</span></span>{/if}
					{#if artist.patreonUrl}<span class="mobile-social-icon"><PatreonIcon size={10} /><span class="sr-only">Patreon</span></span>{/if}
					{#if artist.instagramUrl}<span class="mobile-social-icon"><InstagramIcon size={10} /><span class="sr-only">Instagram</span></span>{/if}
				</p>
			</div>
			<div class="mobile-artist-actions">
				{#if data.registryEnabled}
					<form
						method="POST"
						action="?/submitToRegistry"
						style="display:inline"
						use:enhance={shareEnhance(() => artist)}
					>
						<input type="hidden" name="id" value={artist.id} />
						<button class="icon-btn" type="submit" disabled={submittingId !== null || data.upToDate?.[artist.id] || !!data.aliasLinked?.[artist.id]} aria-busy={submittingId === artist.id} aria-label={shareLabel(artist.id)} title={shareLabel(artist.id)}>
							{#if submittingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Share2 size={16} />{/if}
						</button>
					</form>
				{/if}
				<button class="icon-btn" aria-label={m.admin_artists_edit_aria()} onclick={() => (editingArtist = artist)}><Pencil size={16} /></button>
				{@render deleteButton(artist, 'delete-blocked-m-')}
			</div>
		</div>
	{:else}
		<p class="empty">{search ? m.admin_artists_no_match({ search }) : m.admin_artists_empty()}</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (showAdd = true)}>+ {m.admin_artists_add()}</button>
</div>

{#if data.totalPages > 1}
	{@const qs = data.q ? `&q=${encodeURIComponent(data.q)}` : ''}
	<nav class="pagination">
		{#if data.page > 1}
			<a href="?page={data.page - 1}{qs}" class="btn btn-secondary">{m.gallery_previous()}</a>
		{/if}
		<span class="page-info">{m.admin_page_info({ page: data.page, total: data.totalPages })}</span>
		{#if data.page < data.totalPages}
			<a href="?page={data.page + 1}{qs}" class="btn btn-secondary">{m.gallery_next()}</a>
		{/if}
	</nav>
{/if}

<form method="POST" action="?/delete" use:enhance={() => {
	return async ({ update }) => {
		await update();
		deletingId = null;
	};
}} bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title={m.admin_artists_delete_title()}
		message={m.admin_artists_delete_message({ name: deleteTarget.name })}
		onconfirm={() => { deletingId = deleteTarget!.id; deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

<form method="POST" action="?/submitToRegistry" use:enhance={shareEnhance(() => confirmShare)} bind:this={confirmShareForm} style="display:none">
	<input type="hidden" name="id" value={confirmShare?.id ?? ''} />
	<input type="hidden" name="confirmPrivate" value="1" />
</form>

{#if confirmShare}
	<ConfirmDialog
		title={m.admin_artists_share_private_title()}
		message={m.admin_artists_share_private_message()}
		confirmLabel={m.admin_artists_share_private_confirm()}
		onconfirm={() => confirmShareForm.requestSubmit()}
		oncancel={() => (confirmShare = null)}
	/>
{/if}

<!-- Edit Artist Modal -->
{#if editingArtist}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (editingArtist = null)} onkeydown={(e) => { if (e.key === 'Escape') editingArtist = null; }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>{m.admin_artists_edit_title()}</h2>
				<button class="icon-btn" onclick={() => (editingArtist = null)} aria-label={m.admin_close()}>
					<X size={18} />
				</button>
			</div>

			<div class="modal-artist-info">
				<ArtistAvatar name={editingArtist.name} avatarUrl={editingArtist.avatarUrl} size={48} />
				<div>
					<p class="modal-artist-name">{editingArtist.name}</p>
					<p class="modal-artist-meta"><span class="works-label">{worksLabel(editingArtist)}</span>&nbsp;&bull; {m.admin_artists_added({ date: formatDate(editingArtist.createdAt) })}</p>
				</div>
			</div>

			<form method="POST" action="?/update" use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					// reset:false — the default form reset blanks the value-bound inputs
					// (Svelte sets value as a property, so their default is empty),
					// which flashed every field to its placeholder mid-save on mobile.
					await update({ reset: false });
					saving = false;
					editingArtist = null;
				};
			}} class="modal-form">
				<input type="hidden" name="id" value={editingArtist.id} />

				<label>
					<span>{m.admin_field_artist_name()}</span>
					<input type="text" class="input" name="name" value={editingArtist.name} required disabled={saving} />
				</label>

				<div class="social-section">
					<h3>{m.admin_artists_col_social()}</h3>
					<div class="social-grid">
						<label class="field-pill">
							<TwitterIcon size={14} /><span class="sr-only">Twitter</span>
							<input type="text" class="input input-plain" name="twitter" value={editingArtist.twitterUrl || ''} placeholder="@handle" disabled={saving} />
						</label>
						<label class="field-pill">
							<BlueskyIcon size={14} /><span class="sr-only">Bluesky</span>
							<input type="text" class="input input-plain" name="bluesky" value={editingArtist.blueskyUrl || ''} placeholder="lunarpaws.bsky.social" disabled={saving} />
						</label>
						<label class="field-pill">
							<TelegramIcon size={14} /><span class="sr-only">Telegram</span>
							<input type="text" class="input input-plain" name="telegram" value={editingArtist.telegramUrl || ''} placeholder="t.me/lunarpaws" disabled={saving} />
						</label>
						<label class="field-pill">
							<FurAffinityIcon size={14} /><span class="sr-only">FurAffinity</span>
							<input type="text" class="input input-plain" name="furaffinity" value={editingArtist.furAffinityUrl || ''} placeholder="furaffinity.net/user/lunarpaws" disabled={saving} />
						</label>
						<label class="field-pill">
							<DeviantArtIcon size={14} /><span class="sr-only">DeviantArt</span>
							<input type="text" class="input input-plain" name="deviantart" value={editingArtist.deviantArtUrl || ''} placeholder="deviantart.com/..." disabled={saving} />
						</label>
						<label class="field-pill">
							<PatreonIcon size={14} /><span class="sr-only">Patreon</span>
							<input type="text" class="input input-plain" name="patreon" value={editingArtist.patreonUrl || ''} placeholder="patreon.com/lunarpaws" disabled={saving} />
						</label>
						<label class="field-pill">
							<InstagramIcon size={14} /><span class="sr-only">Instagram</span>
							<input type="text" class="input input-plain" name="instagram" value={editingArtist.instagramUrl || ''} placeholder="instagram.com/..." disabled={saving} />
						</label>
					</div>
				</div>

				<!-- Always shown, enabled only where it can apply. An artist with public work is already public. A shared (registry-linked) artist can't be made private, but one linked while flagged can still clear it. The save action ignores the box where it can't apply. -->
				<div class="private-field">
					<label class="private-check" class:blocked={privateBlocked}>
						<input
							type="checkbox"
							name="ledgerPrivate"
							checked={!privateBlocked && editingArtist.ledgerPrivate}
							disabled={saving || !!privateBlocked}
							aria-describedby={privateBlocked ? 'edit-artist-private-hint edit-artist-private-blocked' : 'edit-artist-private-hint'}
						/>
						<span>{m.admin_artists_ledger_private()}</span>
					</label>
					<p class="private-hint" id="edit-artist-private-hint">{m.admin_artists_ledger_private_hint()}</p>
					{#if privateBlocked}<p class="private-hint" id="edit-artist-private-blocked">{privateBlocked}</p>{/if}
				</div>

				<div class="modal-actions">
					<button type="button" class="btn btn-secondary" onclick={() => (editingArtist = null)}>{m.admin_cancel()}</button>
					<button type="submit" class="btn btn-primary" disabled={saving}>
						{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_save_changes()}{/if}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if showAdd}
	<NewArtistDialog
		registryEnabled={data.registryEnabled}
		allowLedgerPrivate
		oncreated={async () => { showAdd = false; await invalidateAll(); }}
		onimportedall={async () => { showAdd = false; await invalidateAll(); }}
		oncancel={() => (showAdd = false)}
	/>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	h1 {
		font-size: 24px;
	}

	.count {
		font-size: 14px;
		font-weight: 400;
		color: var(--muted-foreground);
		font-family: var(--font-secondary);
	}

	.header-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.notice {
		color: var(--muted-foreground);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.toolbar {
		margin-bottom: 20px;
	}

	.search-wrapper {
		position: relative;
		max-width: 300px;
	}

	.search-wrapper :global(.search-icon) {
		position: absolute;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-foreground);
		pointer-events: none;
	}

	.search {
		padding-left: 40px;
	}

	/* No overflow: hidden here, so Delete's reason can rise above the first
	   row. Cells have no fill; the only paint that reached the rounded corners
	   was the last row's bottom border, which the wrapper's border repeats. */
	.table-wrapper {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.data-table tbody tr:last-child td {
		border-bottom: none;
	}

	.col-avatar {
		/* Deliberately narrower than the rendered 60px (36px avatar + 12px padding
		   per side; auto table layout treats this as a floor). Keeping the declared
		   width under 60px lets the SONA-148 spec's geometry assertions tell a
		   squished avatar from a healthy one; the spec's max-width assertion guards
		   the opt-out itself independently. Do not "fix" this to 60px. */
		width: 48px;
	}

	.col-actions {
		width: 120px;
	}

	.reg-badge {
		display: inline-block;
		margin-left: 8px;
		padding: 1px 7px;
		font-size: 10px;
		font-family: var(--font-primary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--primary-text);
		border: 1px solid var(--primary-text);
		border-radius: var(--radius-pill);
		vertical-align: middle;
	}

	.reg-badge.pending,
	.reg-badge.private {
		color: var(--muted-foreground);
		border-color: var(--muted-foreground);
	}

	.reg-badge.rejected {
		color: var(--destructive);
		border-color: var(--destructive);
		cursor: help;
	}

	.reg-dismiss {
		margin-left: 2px;
		padding: 0 4px;
		font-size: 0.85rem;
		line-height: 1;
		background: none;
		border: none;
		color: var(--muted-foreground);
		cursor: pointer;
		vertical-align: middle;
	}
	.reg-dismiss:hover {
		color: var(--destructive);
	}

	/* Long names and former names wrap anywhere, so they can't widen the table
	   past its wrapper. */
	.artist-name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	/* Registry-synced former names — a muted line under the artist name so a
	   rename (Boltie→Zaps) is explainable at a glance. */
	.aka-hint {
		display: block;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}

	.artwork-count {
		color: var(--muted-foreground);
		font-size: 13px;
	}

	.works-label {
		word-break: keep-all;
	}

	.social-icons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.social-icon {
		color: var(--muted-foreground);
		display: flex;
		transition: color 0.15s;
		text-decoration: none;
	}

	.social-icon:hover {
		color: var(--foreground);
	}

	.empty {
		text-align: center;
		color: var(--muted-foreground);
		padding: 40px 16px;
	}

	.inline-form {
		display: inline;
	}

	.icon-btn {
		background: none;
		border: none;
		color: var(--muted-foreground);
		cursor: pointer;
		padding: 4px;
		border-radius: var(--radius-xs);
		display: inline-flex;
		transition: color 0.15s;
	}

	.icon-btn:not(:disabled):not([aria-disabled='true']):hover {
		color: var(--foreground);
	}

	/* Greyed out so "nothing to submit" is visible at rest — the aria-label/title
	   explanation is hover-only and never shows on touch devices. */
	.icon-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	/* A blocked Delete is aria-disabled instead (focusable, so its reason can be
	   read) and takes the same look. Only the icon fades, so the focus ring keeps
	   its full contrast. */
	.icon-btn[aria-disabled='true'] {
		cursor: default;
	}
	.icon-btn[aria-disabled='true'] > :global(svg) {
		opacity: 0.35;
	}

	/* Why Delete won't run: shown beside the button on hover or keyboard focus,
	   and read as the button's description. A tap shows it as a toast instead.
	   It sits above, right-aligned, so it doesn't cover Edit beside it, and the
	   pointer can move onto it (WCAG 1.4.13): ::before bridges the gap. */
	.delete-wrap {
		position: relative;
		display: inline-flex;
	}

	.blocked-tip {
		position: absolute;
		bottom: calc(100% + 6px);
		right: 0;
		z-index: 10;
		width: max-content;
		max-width: 240px;
		padding: 6px 8px;
		border-radius: var(--radius-xs);
		background: var(--foreground);
		color: var(--background);
		font-size: 12px;
		line-height: 1.4;
		text-align: left;
		white-space: normal;
		visibility: hidden;
	}

	.blocked-tip::before {
		content: '';
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		height: 6px;
	}

	/* Hover only where a pointer can hover: on touch, a tap's sticky hover would
	   show the reason on top of the toast. */
	@media (hover: hover) {
		.delete-wrap:not(.tip-dismissed):hover .blocked-tip {
			visibility: visible;
		}
	}
	.delete-wrap:not(.tip-dismissed):has(:focus-visible) .blocked-tip {
		visibility: visible;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 32px;
		width: 100%;
		max-width: 520px;
		max-height: 90vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.modal-header h2 {
		font-size: 18px;
	}

	.modal-artist-info {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.modal-artist-name {
		font-family: var(--font-primary);
		font-size: 16px;
		font-weight: 600;
	}

	.modal-artist-meta {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.modal-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.modal-form label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.modal-form label > span {
		font-size: 14px;
		font-weight: 500;
	}

	.social-section h3 {
		font-family: var(--font-primary);
		font-size: 12px;
		font-weight: 600;
		color: var(--muted-foreground);
		letter-spacing: 1px;
		margin-bottom: 12px;
	}

	.social-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}

	.social-label {
		font-family: var(--font-primary);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		min-width: 14px;
		text-align: center;
	}

	.private-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.modal-form .private-check {
		flex-direction: row;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	/* Same sizes as the New Artist dialog's checkbox, not the field labels above. */
	.modal-form .private-check > span {
		font-size: 13px;
		font-weight: 400;
		color: var(--foreground);
	}

	.modal-form .private-check.blocked { cursor: default; }

	.private-check input {
		margin: 0;
		flex-shrink: 0;
	}

	.private-hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		margin-top: 24px;
	}

	.page-info {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.mobile-list {
		display: none;
	}

	@media (max-width: 768px) {
		.table-wrapper {
			display: none;
		}

		.mobile-list {
			display: flex;
			flex-direction: column;
		}

		.mobile-artist-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 0;
			border-bottom: 1px solid var(--border);
		}

		.mobile-artist-info {
			flex: 1;
			min-width: 0;
		}

		.mobile-artist-name {
			font-size: 14px;
			font-weight: 600;
		}

		.mobile-artist-badges {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 4px;
			margin-top: 3px;
		}

		/* Gap handles spacing here; drop the desktop inline margin so the first
		   badge isn't pushed off the row's left edge. */
		.mobile-artist-badges .reg-badge {
			margin-left: 0;
		}

		.mobile-artist-meta {
			font-size: 12px;
			color: var(--muted-foreground);
			display: flex;
			align-items: center;
			gap: 4px;
			flex-wrap: wrap;
		}

		.mobile-social-icon {
			display: inline-flex;
			color: var(--muted-foreground);
		}

		.mobile-artist-actions {
			display: flex;
			gap: 4px;
			flex-shrink: 0;
		}

		.mobile-add-row {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 14px;
			margin-top: 8px;
			border: 1px dashed var(--input);
			border-radius: var(--radius-s);
			background: none;
			color: var(--primary-text);
			font-size: 14px;
			font-family: var(--font-primary);
			font-weight: 500;
			cursor: pointer;
		}

		.modal {
			margin: 16px;
			max-height: 85vh;
		}

		.social-grid {
			grid-template-columns: 1fr;
		}

		/* Equal-width buttons that never wrap, so the wider "Saving…" state fits in
		   its half instead of growing and overlapping Cancel on a narrow modal. */
		.modal-actions .btn {
			flex: 1;
			white-space: nowrap;
		}
	}
</style>
