<script lang="ts">
	import { enhance } from '$app/forms';
	import { Search, Plus, Pencil, Trash2, Loader2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { formatDate } from '$lib';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;

	let search = $state('');
	let showAdd = $state(false);
	let creating = $state(false);
	let deletingId = $state<number | null>(null);

	let filtered = $derived(
		data.tags.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
	);
</script>

<div class="page-header">
	<h1>{m.admin_nav_tags()} <span class="count">{m.admin_count_tags({ count: data.total })}</span></h1>
	<button class="btn btn-primary" onclick={() => (showAdd = !showAdd)}><Plus size={16} /> {m.admin_tags_add()}</button>
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
		<input type="text" class="input" name="name" placeholder={m.admin_tags_name_placeholder()} autofocus />
		<button type="submit" class="btn btn-primary" disabled={creating}>
			{#if creating}<Loader2 size={16} class="spin" /> {m.admin_adding()}{:else}{m.admin_add()}{/if}
		</button>
		<button type="button" class="btn btn-secondary" onclick={() => (showAdd = false)}>{m.admin_cancel()}</button>
	</form>
{/if}

<div class="toolbar">
	<div class="search-wrapper">
		<Search size={16} class="search-icon" />
		<input type="search" class="input search" placeholder={m.admin_search_placeholder()} bind:value={search} />
	</div>
</div>

<div class="table-wrapper">
	<table class="data-table">
		<thead>
			<tr>
				<th>{m.admin_tags_col_name()}</th>
				<th>{m.admin_tags_col_used_in()}</th>
				<th>{m.admin_tags_col_created()}</th>
				<th>{m.admin_col_actions()}</th>
			</tr>
		</thead>
		<tbody>
			{#each filtered as tag}
				<tr>
					<td><span class="tag">{tag.name}</span></td>
					<td>{m.admin_count_images({ count: tag.usageCount })}</td>
					<td>{formatDate(tag.createdAt)}</td>
					<td>
						<button class="icon-btn" aria-label={m.admin_tags_delete_aria()} disabled={deletingId === tag.id} onclick={() => (deleteTarget = { id: tag.id, name: tag.name })}>
							{#if deletingId === tag.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
						</button>
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="4" class="empty">
						{#if search}
							{m.admin_tags_no_match({ search })}
						{:else}
							{m.admin_tags_empty()}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each filtered as tag}
		<div class="mobile-tag-item">
			<span class="hash">#</span>
			<span class="mobile-tag-name">{tag.name}</span>
			<span class="mobile-tag-count">{tag.usageCount}</span>
			<div class="mobile-tag-actions">
				<form method="POST" action="?/delete" use:enhance={() => {
					deletingId = tag.id;
					return async ({ update }) => {
						await update();
						deletingId = null;
					};
				}} class="inline-form">
					<input type="hidden" name="id" value={tag.id} />
					<button type="submit" class="icon-btn" aria-label={m.admin_tags_delete_aria()} disabled={deletingId === tag.id}>
						{#if deletingId === tag.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
					</button>
				</form>
			</div>
		</div>
	{:else}
		<p class="empty">{search ? m.admin_tags_no_match({ search }) : m.admin_tags_empty()}</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (showAdd = true)}>+ {m.admin_tags_new()}</button>
</div>

{#if data.totalPages > 1}
	<nav class="pagination">
		{#if data.page > 1}
			<a href="?page={data.page - 1}" class="btn btn-secondary">{m.gallery_previous()}</a>
		{/if}
		<span class="page-info">{m.admin_page_info({ page: data.page, total: data.totalPages })}</span>
		{#if data.page < data.totalPages}
			<a href="?page={data.page + 1}" class="btn btn-secondary">{m.gallery_next()}</a>
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
		title={m.admin_tags_delete_title()}
		message={m.admin_tags_delete_message({ name: deleteTarget.name })}
		onconfirm={() => { deletingId = deleteTarget!.id; deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
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

	.icon-btn:hover {
		color: var(--destructive);
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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

		.mobile-tag-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 12px 0;
			border-bottom: 1px solid var(--border);
		}

		.hash {
			color: var(--primary);
			font-family: var(--font-primary);
			font-weight: 700;
			font-size: 16px;
		}

		.mobile-tag-name {
			flex: 1;
			font-size: 14px;
			font-weight: 500;
		}

		.mobile-tag-count {
			font-size: 12px;
			font-weight: 600;
			color: var(--primary);
			background: rgba(255, 132, 0, 0.15);
			padding: 2px 8px;
			border-radius: var(--radius-pill);
		}

		.mobile-tag-actions {
			display: flex;
			gap: 4px;
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
	}
</style>
