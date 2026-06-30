<script lang="ts">
	import { enhance } from '$app/forms';
	import { Search, Plus, Pencil, Trash2, X, Link as LinkIcon } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { plural } from '$lib';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';

	let { data, form } = $props();

	type CharForm = Omit<typeof data.characters[0], 'id' | 'createdAt' | 'imageCount'> & {
		id?: number;
	};

	const BLANK_CHAR: CharForm = {
		name: '',
		ownerName: null,
		url: null,
		twitterUrl: null,
		blueskyUrl: null,
		telegramUrl: null,
		furAffinityUrl: null,
		deviantArtUrl: null,
		patreonUrl: null,
		instagramUrl: null,
		avatarUrl: null
	};

	let search = $state('');
	let editingChar = $state<CharForm | null>(null);
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;

	let filtered = $derived(
		data.characters.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
	);
</script>

<div class="page-header">
	<h1>Characters <span class="count">{plural(data.characters.length, 'character')}</span></h1>
	<button class="btn btn-primary" onclick={() => (editingChar = { ...BLANK_CHAR })}><Plus size={16} /> Add Character</button>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<div class="toolbar">
	<div class="search-wrapper">
		<Search size={16} class="search-icon" />
		<input type="search" class="input search" placeholder="Search..." bind:value={search} />
	</div>
</div>

<div class="table-wrapper">
	<table class="data-table">
		<thead>
			<tr>
				<th>Name</th>
				<th>Owner</th>
				<th>Appearances</th>
				<th>Social Links</th>
				<th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each filtered as char}
				<tr>
					<td class="char-name">
						<div class="name-cell">
							<div class="char-avatar">
								{#if char.avatarUrl}
									<img src={char.avatarUrl} alt="" />
								{/if}
							</div>
							{#if char.url}
								<a href={char.url} target="_blank" rel="noopener">{char.name}</a>
							{:else}
								{char.name}
							{/if}
						</div>
					</td>
					<td class="char-owner">{char.ownerName || '—'}</td>
					<td>{plural(char.imageCount, 'image')}</td>
					<td>
						<div class="social-icons">
							{#if char.twitterUrl}<a href={char.twitterUrl} target="_blank" rel="noopener" class="social-icon"><TwitterIcon size={14} /></a>{/if}
							{#if char.blueskyUrl}<a href={char.blueskyUrl} target="_blank" rel="noopener" class="social-icon"><BlueskyIcon size={14} /></a>{/if}
							{#if char.telegramUrl}<a href={char.telegramUrl} target="_blank" rel="noopener" class="social-icon"><TelegramIcon size={14} /></a>{/if}
							{#if char.furAffinityUrl}<a href={char.furAffinityUrl} target="_blank" rel="noopener" class="social-icon"><FurAffinityIcon size={14} /></a>{/if}
							{#if char.deviantArtUrl}<a href={char.deviantArtUrl} target="_blank" rel="noopener" class="social-icon"><DeviantArtIcon size={14} /></a>{/if}
							{#if char.patreonUrl}<a href={char.patreonUrl} target="_blank" rel="noopener" class="social-icon"><PatreonIcon size={14} /></a>{/if}
							{#if char.instagramUrl}<a href={char.instagramUrl} target="_blank" rel="noopener" class="social-icon"><InstagramIcon size={14} /></a>{/if}
						</div>
					</td>
					<td>
						<button class="icon-btn" onclick={() => (editingChar = char)}><Pencil size={16} /></button>
						<button class="icon-btn" onclick={() => (deleteTarget = { id: char.id, name: char.name })}><Trash2 size={16} /></button>
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="5" class="empty">
						{#if search}No characters matching "{search}"{:else}No characters yet.{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each filtered as char}
		<div class="mobile-char-item">
			<div class="char-avatar">
				{#if char.avatarUrl}
					<img src={char.avatarUrl} alt="" />
				{/if}
			</div>
			<div class="mobile-char-info">
				<p class="mobile-char-name">{char.name}</p>
				<p class="mobile-char-meta">
					{#if char.ownerName}{char.ownerName} &bull; {/if}{plural(char.imageCount, 'image')}
				</p>
			</div>
			<div class="mobile-char-actions">
				<button class="icon-btn" onclick={() => (editingChar = char)}><Pencil size={16} /></button>
				<button class="icon-btn" onclick={() => (deleteTarget = { id: char.id, name: char.name })}><Trash2 size={16} /></button>
			</div>
		</div>
	{:else}
		<p class="empty">{search ? `No characters matching "${search}"` : 'No characters yet.'}</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (editingChar = { ...BLANK_CHAR })}>+ Add Character</button>
</div>

<form method="POST" action="?/delete" use:enhance bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete Character"
		message={`Delete character "${deleteTarget.name}"? They will be removed from all images.`}
		onconfirm={() => { deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

{#if editingChar}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (editingChar = null)} onkeydown={(e) => { if (e.key === 'Escape') editingChar = null; }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>{editingChar.id ? 'Edit' : 'Add'} Character</h2>
				<button class="icon-btn" onclick={() => (editingChar = null)}><X size={18} /></button>
			</div>
			<form method="POST" action={editingChar.id ? '?/update' : '?/create'} use:enhance={() => {
				return async ({ update }) => {
					await update();
					editingChar = null;
				};
			}} class="modal-form">
				{#if editingChar.id}
					<input type="hidden" name="id" value={editingChar.id} />
				{/if}
				<label>
					<span>Character Name</span>
					<input type="text" class="input" name="name" value={editingChar.name} required />
				</label>
				<label>
					<span>Owner</span>
					<input type="text" class="input" name="ownerName" value={editingChar.ownerName || ''} placeholder="Optional" />
				</label>
				<label>
					<span>Profile / Ref Sheet URL</span>
					<input type="text" class="input" name="url" value={editingChar.url || ''} placeholder="Optional — e.g. toyhouse.com/..." />
				</label>

				<div class="social-section">
					<h3>Social Links</h3>
					<div class="social-grid">
						<label class="social-field">
							<TwitterIcon size={14} />
							<input type="text" class="input" name="twitter" value={editingChar.twitterUrl || ''} placeholder="@handle" />
						</label>
						<label class="social-field">
							<BlueskyIcon size={14} />
							<input type="text" class="input" name="bluesky" value={editingChar.blueskyUrl || ''} placeholder="bsky.app/profile/..." />
						</label>
						<label class="social-field">
							<TelegramIcon size={14} />
							<input type="text" class="input" name="telegram" value={editingChar.telegramUrl || ''} placeholder="t.me/..." />
						</label>
						<label class="social-field">
							<FurAffinityIcon size={14} />
							<input type="text" class="input" name="furaffinity" value={editingChar.furAffinityUrl || ''} placeholder="furaffinity.net/user/..." />
						</label>
						<label class="social-field">
							<DeviantArtIcon size={14} />
							<input type="text" class="input" name="deviantart" value={editingChar.deviantArtUrl || ''} placeholder="deviantart.com/..." />
						</label>
						<label class="social-field">
							<PatreonIcon size={14} />
							<input type="text" class="input" name="patreon" value={editingChar.patreonUrl || ''} placeholder="patreon.com/..." />
						</label>
						<label class="social-field">
							<InstagramIcon size={14} />
							<input type="text" class="input" name="instagram" value={editingChar.instagramUrl || ''} placeholder="instagram.com/..." />
						</label>
					</div>
				</div>

				<div class="modal-actions">
					<button type="button" class="btn btn-secondary" onclick={() => (editingChar = null)}>Cancel</button>
					<button type="submit" class="btn btn-primary">{editingChar.id ? 'Save Changes' : 'Add Character'}</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	h1 { font-size: 24px; }

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

	.toolbar { margin-bottom: 20px; }

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

	.search { padding-left: 40px; }

	.table-wrapper {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}

	.char-name { font-weight: 500; }
	.char-name a { color: var(--primary); }

	.name-cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.char-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--secondary);
		overflow: hidden;
		flex-shrink: 0;
	}

	.char-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.char-owner { color: var(--muted-foreground); }

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
	}

	.social-field .input:focus {
		outline: none;
	}

	.empty {
		text-align: center;
		color: var(--muted-foreground);
		padding: 40px 16px;
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

	.icon-btn:hover { color: var(--foreground); }

	.mobile-list { display: none; }

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

	.modal-header h2 { font-size: 18px; }

	.modal-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
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

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	@media (max-width: 768px) {
		.page-header .btn { display: none; }
		.table-wrapper { display: none; }
		.social-grid { grid-template-columns: 1fr; }

		.mobile-list {
			display: flex;
			flex-direction: column;
		}

		.mobile-char-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 0;
			border-bottom: 1px solid var(--border);
		}

		.mobile-char-info { flex: 1; min-width: 0; }
		.mobile-char-name { font-size: 14px; font-weight: 600; }
		.mobile-char-meta { font-size: 12px; color: var(--muted-foreground); }
		.mobile-char-actions { display: flex; gap: 4px; flex-shrink: 0; }

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

		.modal { margin: 16px; }
	}
</style>
