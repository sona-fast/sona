<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { Search, Plus, Pencil, Trash2, X, Share2, Loader2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { formatDate } from '$lib';
	import * as m from '$lib/paraglide/messages';
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
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	let saving = $state(false);
	let deletingId = $state<number | null>(null);
	let submittingId = $state<number | null>(null);

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


	function getInitials(name: string): string {
		return name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
	}

	// An artist may have drawn artworks, stickers, or both — show whatever's non-zero.
	function worksLabel(a: { artworkCount: number; stickerCount: number }): string {
		const parts: string[] = [];
		if (a.artworkCount > 0) parts.push(m.admin_count_artworks({ count: a.artworkCount }));
		if (a.stickerCount > 0) parts.push(m.admin_count_stickers({ count: a.stickerCount }));
		return parts.length ? parts.join(' · ') : m.admin_artists_no_works();
	}
</script>

<div class="page-header">
	<h1>{m.admin_nav_artists()} <span class="count">{m.admin_count_artists({ count: data.total })}</span></h1>
	<button class="btn btn-primary" onclick={() => (showAdd = true)}><Plus size={16} /> {m.admin_artists_add()}</button>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
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
						<div class="avatar">
							{#if artist.avatarUrl}
								<img src={artist.avatarUrl} alt={artist.name} />
							{:else}
								<span class="initials">{getInitials(artist.name)}</span>
							{/if}
						</div>
					</td>
					<td class="artist-name">
						{artist.name}
						{#if artist.globalId}<span class="reg-badge" title={m.admin_artists_shared_title()}>{m.admin_artists_badge_shared()}</span>{/if}
						{#if data.pendingArtistIds?.includes(artist.id)}<span class="reg-badge pending" title={m.admin_artists_pending_title()}>{m.admin_artists_badge_pending()}</span>{/if}
					</td>
					<td class="artwork-count">{worksLabel(artist)}</td>
					<td>
						<div class="social-icons">
							{#if artist.twitterUrl}
								<a href={artist.twitterUrl} target="_blank" rel="noopener" class="social-icon"><TwitterIcon size={14} /></a>
							{/if}
							{#if artist.blueskyUrl}
								<a href={artist.blueskyUrl} target="_blank" rel="noopener" class="social-icon"><BlueskyIcon size={14} /></a>
							{/if}
							{#if artist.telegramUrl}
								<a href={artist.telegramUrl} target="_blank" rel="noopener" class="social-icon"><TelegramIcon size={14} /></a>
							{/if}
							{#if artist.furAffinityUrl}
								<a href={artist.furAffinityUrl} target="_blank" rel="noopener" class="social-icon"><FurAffinityIcon size={14} /></a>
							{/if}
							{#if artist.deviantArtUrl}
								<a href={artist.deviantArtUrl} target="_blank" rel="noopener" class="social-icon"><DeviantArtIcon size={14} /></a>
							{/if}
							{#if artist.patreonUrl}
								<a href={artist.patreonUrl} target="_blank" rel="noopener" class="social-icon"><PatreonIcon size={14} /></a>
							{/if}
							{#if artist.instagramUrl}
								<a href={artist.instagramUrl} target="_blank" rel="noopener" class="social-icon"><InstagramIcon size={14} /></a>
							{/if}
						</div>
					</td>
					<td class="col-actions">
						{#if data.registryEnabled}
							<form
								method="POST"
								action="?/submitToRegistry"
								style="display:inline"
								use:enhance={() => {
									submittingId = artist.id;
									return async ({ result, update }) => {
										await update();
										submittingId = null;
										if (result.type === 'success')
											toast.success(artist.globalId ? m.admin_artists_registry_update_submitted() : m.admin_artists_registry_submitted());
										else if (result.type === 'failure')
											toast.error((result.data?.error as string) ?? m.admin_artists_registry_failed());
									};
								}}
							>
								<input type="hidden" name="id" value={artist.id} />
								<button class="icon-btn" type="submit" disabled={submittingId !== null || data.upToDate?.[artist.id]} aria-busy={submittingId === artist.id} aria-label={data.upToDate?.[artist.id] ? m.admin_artists_up_to_date() : m.admin_artists_submit_registry()} title={data.upToDate?.[artist.id] ? m.admin_artists_up_to_date() : m.admin_artists_submit_registry()}>
									{#if submittingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Share2 size={16} />{/if}
								</button>
							</form>
						{/if}
						<button class="icon-btn" aria-label={m.admin_artists_edit_aria()} onclick={() => (editingArtist = artist)}>
							<Pencil size={16} />
						</button>
						<button class="icon-btn" aria-label={m.admin_artists_delete_aria()} disabled={deletingId === artist.id} onclick={() => (deleteTarget = { id: artist.id, name: artist.name })}>
							{#if deletingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
						</button>
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
			<div class="avatar">
				{#if artist.avatarUrl}
					<img src={artist.avatarUrl} alt={artist.name} />
				{:else}
					<span class="initials">{getInitials(artist.name)}</span>
				{/if}
			</div>
			<div class="mobile-artist-info">
				<p class="mobile-artist-name">{artist.name}</p>
				<p class="mobile-artist-meta">
					{worksLabel(artist)}
					{#if artist.twitterUrl}<span class="mobile-social-icon"><TwitterIcon size={10} /></span>{/if}
					{#if artist.blueskyUrl}<span class="mobile-social-icon"><BlueskyIcon size={10} /></span>{/if}
					{#if artist.telegramUrl}<span class="mobile-social-icon"><TelegramIcon size={10} /></span>{/if}
					{#if artist.furAffinityUrl}<span class="mobile-social-icon"><FurAffinityIcon size={10} /></span>{/if}
					{#if artist.deviantArtUrl}<span class="mobile-social-icon"><DeviantArtIcon size={10} /></span>{/if}
					{#if artist.patreonUrl}<span class="mobile-social-icon"><PatreonIcon size={10} /></span>{/if}
					{#if artist.instagramUrl}<span class="mobile-social-icon"><InstagramIcon size={10} /></span>{/if}
				</p>
			</div>
			<div class="mobile-artist-actions">
				<button class="icon-btn" onclick={() => (editingArtist = artist)}><Pencil size={16} /></button>
				<button class="icon-btn" disabled={deletingId === artist.id} onclick={() => (deleteTarget = { id: artist.id, name: artist.name })}>
					{#if deletingId === artist.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
				</button>
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
				<div class="avatar avatar-lg">
					{#if editingArtist.avatarUrl}
						<img src={editingArtist.avatarUrl} alt={editingArtist.name} />
					{:else}
						<span class="initials">{getInitials(editingArtist.name)}</span>
					{/if}
				</div>
				<div>
					<p class="modal-artist-name">{editingArtist.name}</p>
					<p class="modal-artist-meta">{worksLabel(editingArtist)} &bull; {m.admin_artists_added({ date: formatDate(editingArtist.createdAt) })}</p>
				</div>
			</div>

			<form method="POST" action="?/update" use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
					editingArtist = null;
				};
			}} class="modal-form">
				<input type="hidden" name="id" value={editingArtist.id} />

				<label>
					<span>{m.admin_field_artist_name()}</span>
					<input type="text" class="input" name="name" value={editingArtist.name} required />
				</label>

				<div class="social-section">
					<h3>{m.admin_artists_col_social()}</h3>
					<div class="social-grid">
						<label class="social-field">
							<TwitterIcon size={14} />
							<input type="text" class="input" name="twitter" value={editingArtist.twitterUrl || ''} placeholder="@handle" />
						</label>
						<label class="social-field">
							<BlueskyIcon size={14} />
							<input type="text" class="input" name="bluesky" value={editingArtist.blueskyUrl || ''} placeholder="lunarpaws.bsky.social" />
						</label>
						<label class="social-field">
							<TelegramIcon size={14} />
							<input type="text" class="input" name="telegram" value={editingArtist.telegramUrl || ''} placeholder="t.me/lunarpaws" />
						</label>
						<label class="social-field">
							<FurAffinityIcon size={14} />
							<input type="text" class="input" name="furaffinity" value={editingArtist.furAffinityUrl || ''} placeholder="furaffinity.net/user/lunarpaws" />
						</label>
						<label class="social-field">
							<DeviantArtIcon size={14} />
							<input type="text" class="input" name="deviantart" value={editingArtist.deviantArtUrl || ''} placeholder="deviantart.com/..." />
						</label>
						<label class="social-field">
							<PatreonIcon size={14} />
							<input type="text" class="input" name="patreon" value={editingArtist.patreonUrl || ''} placeholder="patreon.com/lunarpaws" />
						</label>
						<label class="social-field">
							<InstagramIcon size={14} />
							<input type="text" class="input" name="instagram" value={editingArtist.instagramUrl || ''} placeholder="instagram.com/..." />
						</label>
					</div>
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

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.add-form {
		display: flex;
		gap: 8px;
		margin-bottom: 20px;
		align-items: center;
	}

	.add-form .input {
		max-width: 300px;
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

	.table-wrapper {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}

	.col-avatar {
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
		color: var(--primary);
		border: 1px solid var(--primary);
		border-radius: var(--radius-pill);
		vertical-align: middle;
	}

	.reg-badge.pending {
		color: var(--muted-foreground);
		border-color: var(--muted-foreground);
	}

	.avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.initials {
		font-family: var(--font-primary);
		font-size: 12px;
		font-weight: 600;
		color: var(--muted-foreground);
	}

	.artist-name {
		font-weight: 500;
	}

	.artwork-count {
		color: var(--muted-foreground);
		font-size: 13px;
	}

	.social-icons {
		display: flex;
		gap: 8px;
	}

	.social-icon {
		color: var(--muted-foreground);
		display: flex;
		transition: color 0.15s;
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

	.icon-btn:not(:disabled):hover {
		color: var(--foreground);
	}

	/* Greyed out so "nothing to submit" is visible at rest — the aria-label/title
	   explanation is hover-only and never shows on touch devices. */
	.icon-btn:disabled {
		opacity: 0.35;
		cursor: default;
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

	.avatar-lg {
		width: 48px;
		height: 48px;
	}

	.avatar-lg .initials {
		font-size: 20px;
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

	.social-field {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 8px;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 0 12px;
		height: 40px;
	}

	.social-field .input {
		border: none;
		background: none;
		padding: 0;
		height: auto;
		flex: 1;
		min-width: 0;
	}

	.social-field .input:focus {
		outline: none;
	}

	.social-label {
		font-family: var(--font-primary);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		min-width: 14px;
		text-align: center;
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
		.page-header .btn {
			display: none;
		}

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
			border: 1px dashed var(--border);
			border-radius: var(--radius-s);
			background: none;
			color: var(--primary);
			font-size: 14px;
			font-family: var(--font-primary);
			font-weight: 500;
			cursor: pointer;
		}

		.add-form {
			flex-direction: column;
		}

		.add-form .input {
			max-width: 100%;
		}

		.modal {
			margin: 16px;
			max-height: 85vh;
		}

		.social-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
