<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plus, Pencil, Trash2, X, Loader2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let showAdd = $state(false);
	let editingCollection = $state<typeof data.collections[0] | null>(null);
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	let editCoverUrl = $state('');
	let creating = $state(false);
	let saving = $state(false);
	let deletingId = $state<number | null>(null);

	function startEdit(collection: typeof data.collections[0]) {
		editingCollection = collection;
		editCoverUrl = collection.coverImageUrl || '';
	}

	// Images belonging to the collection being edited
	let collectionImages = $derived(
		editingCollection
			? data.images.filter((img) => img.collectionId === editingCollection!.id)
			: []
	);
</script>

<div class="page-header">
	<h1>{m.admin_nav_collections()} <span class="count">{m.admin_count_collections({ count: data.collections.length })}</span></h1>
	<button class="btn btn-primary" onclick={() => (showAdd = !showAdd)}><Plus size={16} /> {m.admin_collections_new()}</button>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

{#if showAdd}
	<form method="POST" action="?/create" use:enhance={() => {
		creating = true;
		return async ({ update }) => {
			await update();
			creating = false;
			showAdd = false;
		};
	}} class="add-form">
		<input type="text" class="input" name="name" placeholder={m.admin_collections_name_placeholder()} autofocus />
		<button type="submit" class="btn btn-primary" disabled={creating}>
			{#if creating}<Loader2 size={16} class="spin" /> {m.admin_creating()}{:else}{m.admin_create()}{/if}
		</button>
		<button type="button" class="btn btn-secondary" onclick={() => (showAdd = false)}>{m.admin_cancel()}</button>
	</form>
{/if}

<div class="grid">
	{#each data.collections as collection}
		<div class="collection-card">
			<a href="/collections/{collection.slug}" class="collection-cover">
				{#if collection.coverImageUrl || collection.latestImageUrl}
					<img src={collection.coverImageUrl || collection.latestImageUrl} alt={collection.name} />
				{/if}
			</a>
			<div class="collection-info">
				<div class="collection-meta">
					<a href="/collections/{collection.slug}" class="collection-link"><h3>{collection.name}</h3></a>
					<p class="artwork-count">{m.admin_count_artworks({ count: collection.artworkCount })}</p>
				</div>
				<div class="collection-actions">
					<button class="icon-btn" aria-label={m.admin_collections_edit_aria()} onclick={() => startEdit(collection)}>
						<Pencil size={16} />
					</button>
					<button class="icon-btn" aria-label={m.admin_collections_delete_aria()} disabled={deletingId === collection.id} onclick={() => (deleteTarget = { id: collection.id, name: collection.name })}>
						{#if deletingId === collection.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
					</button>
				</div>
			</div>
		</div>
	{:else}
		<p class="empty">{m.admin_collections_empty_hint()}</p>
	{/each}
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each data.collections as collection}
		<div class="mobile-collection-item">
			<a href="/collections/{collection.slug}" class="mobile-collection-thumb">
				{#if collection.coverImageUrl || collection.latestImageUrl}
					<img src={collection.coverImageUrl || collection.latestImageUrl} alt={collection.name} />
				{/if}
			</a>
			<div class="mobile-collection-info">
				<a href="/collections/{collection.slug}" class="mobile-collection-name">{collection.name}</a>
				<p class="mobile-collection-count">{m.admin_count_artworks({ count: collection.artworkCount })}</p>
			</div>
			<div class="mobile-collection-actions">
				<button class="icon-btn" onclick={() => startEdit(collection)}><Pencil size={16} /></button>
				<button class="icon-btn" disabled={deletingId === collection.id} onclick={() => (deleteTarget = { id: collection.id, name: collection.name })}>
					{#if deletingId === collection.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
				</button>
			</div>
		</div>
	{:else}
		<p class="empty">{m.collections_empty()}</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (showAdd = true)}>+ {m.admin_collections_new()}</button>
</div>

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
		title={m.admin_collections_delete_title()}
		message={m.admin_collections_delete_message({ name: deleteTarget.name })}
		onconfirm={() => { deletingId = deleteTarget!.id; deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

<!-- Edit Collection Modal -->
{#if editingCollection}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => (editingCollection = null)} onkeydown={(e) => { if (e.key === 'Escape') editingCollection = null; }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>{m.admin_collections_edit_title()}</h2>
				<button class="icon-btn" onclick={() => (editingCollection = null)} aria-label={m.admin_close()}>
					<X size={18} />
				</button>
			</div>

			<form method="POST" action="?/update" use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
					editingCollection = null;
				};
			}} class="modal-form">
				<input type="hidden" name="id" value={editingCollection.id} />

				<label>
					<span>{m.admin_collections_name_label()}</span>
					<input type="text" class="input" name="name" value={editingCollection.name} required />
				</label>

				<div class="cover-section">
					<span class="field-label">{m.admin_collections_cover_image()}</span>
					<input type="hidden" name="coverImageUrl" value={editCoverUrl} />

					{#if editCoverUrl}
						<div class="cover-preview">
							<img src={editCoverUrl} alt={m.admin_collections_cover_preview_alt()} />
							<button type="button" class="remove-cover" onclick={() => (editCoverUrl = '')}>
								<X size={14} /> {m.admin_remove()}
							</button>
						</div>
					{/if}

					{#if collectionImages.length > 0}
						<p class="cover-hint">{m.admin_collections_cover_select_hint()}</p>
						<div class="cover-grid">
							{#each collectionImages as img}
								<button
									type="button"
									class="cover-option"
									class:selected={editCoverUrl === img.imageUrl}
									onclick={() => (editCoverUrl = img.imageUrl)}
								>
									<img src={img.imageUrl} alt={img.title} />
								</button>
							{/each}
						</div>
					{:else}
						<p class="cover-hint">{m.admin_collections_cover_empty_hint()}</p>
					{/if}
				</div>

				<div class="modal-actions">
					<button type="button" class="btn btn-secondary" onclick={() => (editingCollection = null)}>{m.admin_cancel()}</button>
					<button type="submit" class="btn btn-primary" disabled={saving}>
						{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_save_changes()}{/if}
					</button>
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

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 20px;
	}

	.collection-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}

	.collection-cover {
		display: block;
		aspect-ratio: 16 / 9;
		background: var(--secondary);
	}

	.collection-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.collection-link {
		color: inherit;
		text-decoration: none;
	}

	.collection-link:hover {
		text-decoration: none;
		color: var(--primary);
	}

	.collection-info {
		padding: 12px 16px;
		display: flex;
		justify-content: space-between;
		align-items: start;
	}

	.collection-meta h3 {
		font-size: 14px;
		font-weight: 600;
	}

	.artwork-count {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.collection-actions {
		display: flex;
		gap: 4px;
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

	.icon-btn:hover {
		color: var(--foreground);
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
		grid-column: 1 / -1;
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
		display: flex;
		flex-direction: column;
		gap: 24px;
		max-height: 90vh;
		overflow-y: auto;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.modal-header h2 {
		font-size: 18px;
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

	.cover-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.field-label {
		font-size: 14px;
		font-weight: 500;
	}

	.cover-preview {
		position: relative;
		border-radius: var(--radius-s);
		overflow: hidden;
		aspect-ratio: 16 / 9;
		max-width: 200px;
	}

	.cover-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.remove-cover {
		position: absolute;
		top: 4px;
		right: 4px;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border-radius: var(--radius-xs);
		border: none;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		font-size: 12px;
		cursor: pointer;
	}

	.cover-hint {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	.cover-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
		gap: 8px;
	}

	.cover-option {
		aspect-ratio: 1;
		border-radius: var(--radius-xs);
		overflow: hidden;
		border: 2px solid transparent;
		cursor: pointer;
		padding: 0;
		background: var(--secondary);
		transition: border-color 0.15s;
	}

	.cover-option.selected {
		border-color: var(--primary);
	}

	.cover-option img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
	}

	.mobile-list {
		display: none;
	}

	@media (max-width: 768px) {
		.page-header .btn {
			display: none;
		}

		.grid {
			display: none;
		}

		.mobile-list {
			display: flex;
			flex-direction: column;
		}

		.mobile-collection-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 0;
			border-bottom: 1px solid var(--border);
		}

		.mobile-collection-thumb {
			width: 56px;
			height: 56px;
			border-radius: var(--radius-xs);
			overflow: hidden;
			background: var(--secondary);
			flex-shrink: 0;
			display: block;
		}

		.mobile-collection-thumb img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}

		.mobile-collection-info {
			flex: 1;
			min-width: 0;
		}

		.mobile-collection-name {
			font-size: 14px;
			font-weight: 600;
			color: var(--foreground);
			text-decoration: none;
		}

		.mobile-collection-count {
			font-size: 12px;
			color: var(--muted-foreground);
		}

		.mobile-collection-actions {
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
	}
</style>
