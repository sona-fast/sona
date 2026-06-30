<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Search, Upload, Pencil, Trash2, ArrowUpDown, Eye, EyeOff } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { plural, formatDate, cdnImage } from '$lib';

	let { data } = $props();

	let deleteTarget = $state<{ id: number; title: string } | null>(null);
	let deleteForm: HTMLFormElement;

	function toggleSort(col: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (data.sort === col) {
			params.set('dir', data.dir === 'desc' ? 'asc' : 'desc');
		} else {
			params.set('sort', col);
			params.set('dir', 'desc');
		}
		goto(`?${params.toString()}`, { replaceState: true });
	}

	let search = $state('');

	let filtered = $derived(
		data.images.filter(
			(img) =>
				img.title.toLowerCase().includes(search.toLowerCase()) ||
				img.artistName?.toLowerCase().includes(search.toLowerCase())
		)
	);
</script>

<div class="page-header">
	<div>
		<h1>All Images <span class="count">{plural(data.total, 'item')}</span></h1>
	</div>
	<a href="/admin/upload" class="btn btn-primary desktop-upload"><Upload size={16} /> Upload New</a>
</div>

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
				<th class="col-thumb">Thumbnail</th>
				<th>Title</th>
				<th>Artist</th>
				<th>Tags</th>
				<th class="sortable" onclick={() => toggleSort('commissioned')}>
					Commissioned {#if data.sort === 'commissioned'}<span class="sort-arrow">{data.dir === 'asc' ? '↑' : '↓'}</span>{/if}
				</th>
				<th class="sortable" onclick={() => toggleSort('uploaded')}>
					Uploaded {#if data.sort === 'uploaded'}<span class="sort-arrow">{data.dir === 'asc' ? '↑' : '↓'}</span>{/if}
				</th>
				<th class="col-status">Status</th>
				<th class="col-actions">Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each filtered as image}
				<tr>
					<td class="col-thumb">
						<div class="thumb">
							<img src={cdnImage(image.thumbnailUrl || image.imageUrl, 200)} alt={image.title} loading="lazy" />
						</div>
					</td>
					<td>
						<a href="/gallery/{image.slug}" class="image-title">{image.title}</a>
						{#if image.nsfw}<span class="nsfw-badge">NSFW</span>{/if}
					</td>
					<td>
						{#if image.artistName}
							<a href="/gallery?artist={encodeURIComponent(image.artistName)}">{image.artistName}</a>
						{:else}
							—
						{/if}
					</td>
					<td>
						<div class="tag-list">
							{#each image.tags as tag}
								<span class="tag">{tag}</span>
							{/each}
						</div>
					</td>
					<td class="date">{image.commissionedAt ? formatDate(image.commissionedAt) : '—'}</td>
					<td class="date">{formatDate(image.createdAt)}</td>
					<td class="col-status">
						<form method="POST" action="?/togglePublished" use:enhance class="inline-form">
							<input type="hidden" name="id" value={image.id} />
							<button
								type="submit"
								class="status-btn"
								class:is-private={!image.published}
								aria-label={image.published ? 'Make private' : 'Make public'}
								title={image.published ? 'Public — click to hide' : 'Private — click to publish'}
							>
								{#if image.published}
									<Eye size={14} />
									<span>Public</span>
								{:else}
									<EyeOff size={14} />
									<span>Private</span>
								{/if}
							</button>
						</form>
					</td>
					<td class="col-actions">
						<a href="/admin/images/{image.id}/edit" class="icon-btn" aria-label="Edit image">
							<Pencil size={16} />
						</a>
						<button class="icon-btn" aria-label="Delete image" onclick={() => (deleteTarget = { id: image.id, title: image.title })}>
							<Trash2 size={16} />
						</button>
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="8" class="empty">
						{#if search}
							No images matching "{search}"
						{:else}
							No images uploaded yet.
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list view -->
<div class="mobile-list">
	{#each filtered as image}
		<div class="mobile-item">
			<div class="mobile-thumb">
				<img src={cdnImage(image.thumbnailUrl || image.imageUrl, 200)} alt={image.title} loading="lazy" />
			</div>
			<div class="mobile-info">
				<p class="mobile-title">{image.title}</p>
				<p class="mobile-meta">
					{#if image.artistName}
						<a href="/gallery?artist={encodeURIComponent(image.artistName)}">{image.artistName}</a>
					{:else}
						—
					{/if}
					{#if image.commissionedAt}
						&bull; {formatDate(image.commissionedAt, { month: 'short', day: 'numeric' })}
					{/if}
				</p>
				{#if image.nsfw}
					<span class="nsfw-badge">NSFW</span>
				{:else}
					<span class="sfw-badge">SFW</span>
				{/if}
				{#if !image.published}
					<span class="private-badge">Private</span>
				{/if}
			</div>
			<div class="mobile-actions">
				<form method="POST" action="?/togglePublished" use:enhance class="inline-form">
					<input type="hidden" name="id" value={image.id} />
					<button type="submit" class="icon-btn" aria-label={image.published ? 'Make private' : 'Make public'}>
						{#if image.published}<Eye size={16} />{:else}<EyeOff size={16} />{/if}
					</button>
				</form>
				<a href="/admin/images/{image.id}/edit" class="icon-btn"><Pencil size={16} /></a>
				<form method="POST" action="?/delete" use:enhance class="inline-form">
					<input type="hidden" name="id" value={image.id} />
					<button type="submit" class="icon-btn"><Trash2 size={16} /></button>
				</form>
			</div>
		</div>
	{:else}
		<p class="empty">{search ? `No images matching "${search}"` : 'No images uploaded yet.'}</p>
	{/each}
</div>

<a href="/admin/upload" class="fab">
	<Upload size={24} />
</a>

{#if data.totalPages > 1}
	<nav class="pagination">
		{#if data.page > 1}
			<a href="?page={data.page - 1}&sort={data.sort}&dir={data.dir}" class="btn btn-secondary">Previous</a>
		{/if}
		<span class="page-info">Page {data.page} of {data.totalPages}</span>
		{#if data.page < data.totalPages}
			<a href="?page={data.page + 1}&sort={data.sort}&dir={data.dir}" class="btn btn-secondary">Next</a>
		{/if}
	</nav>
{/if}

<form method="POST" action="?/delete" use:enhance bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete Image"
		message={`Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.`}
		onconfirm={() => { deleteForm.requestSubmit(); deleteTarget = null; }}
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

	.sortable {
		cursor: pointer;
		user-select: none;
	}

	.sortable:hover {
		color: var(--foreground);
	}

	.sort-arrow {
		font-size: 12px;
	}

	.toolbar {
		display: flex;
		gap: 12px;
		margin-bottom: 20px;
	}

	.search-wrapper {
		position: relative;
		max-width: 300px;
		flex: 1;
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

	.col-thumb {
		width: 60px;
	}

	.col-actions {
		width: 60px;
	}

	.col-status {
		width: 100px;
	}

	.status-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 4px 6px;
		border-radius: var(--radius-xs);
		font: 12px var(--font-secondary);
		color: var(--foreground);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.status-btn:hover {
		background: var(--secondary);
	}

	.status-btn.is-private {
		color: var(--muted-foreground);
	}

	.private-badge {
		font-size: 10px;
		font-weight: 600;
		font-family: var(--font-primary);
		color: var(--muted-foreground);
		margin-left: 8px;
	}

	.thumb {
		width: 48px;
		height: 48px;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.image-title {
		font-weight: 500;
	}

	.nsfw-badge {
		font-size: 10px;
		font-weight: 600;
		font-family: var(--font-primary);
		color: var(--destructive);
		margin-left: 8px;
	}

	.tag-list {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.date {
		white-space: nowrap;
		color: var(--muted-foreground);
		font-size: 13px;
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

	.fab {
		display: none;
	}

	@media (max-width: 768px) {
		.page-header h1 {
			font-size: 20px;
		}

		.desktop-upload {
			display: none;
		}

		.table-wrapper {
			display: none;
		}

		.mobile-list {
			display: flex;
			flex-direction: column;
		}

		.mobile-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 0;
			border-bottom: 1px solid var(--border);
		}

		.mobile-thumb {
			width: 56px;
			height: 56px;
			border-radius: var(--radius-xs);
			overflow: hidden;
			background: var(--secondary);
			flex-shrink: 0;
		}

		.mobile-thumb img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}

		.mobile-info {
			flex: 1;
			min-width: 0;
		}

		.mobile-title {
			font-size: 14px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.mobile-meta {
			font-size: 12px;
			color: var(--muted-foreground);
		}

		.sfw-badge {
			font-size: 10px;
			font-weight: 600;
			font-family: var(--font-primary);
			color: #4ade80;
		}

		.mobile-actions {
			display: flex;
			gap: 4px;
			flex-shrink: 0;
		}

		.fab {
			display: flex;
			align-items: center;
			justify-content: center;
			position: fixed;
			bottom: 88px;
			right: 20px;
			width: 56px;
			height: 56px;
			border-radius: 50%;
			background: var(--primary);
			color: var(--primary-foreground);
			text-decoration: none;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
			z-index: 40;
		}
	}
</style>
