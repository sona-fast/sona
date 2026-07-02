<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plus, Trash2, ExternalLink, RefreshCw } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();

	let showAdd = $state(false);
	let showManual = $state(false);
	let syncing = $state(false);
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	let syncForm: HTMLFormElement;

	function sourceLabel(e: { name: string; location: string; startDate: string }): string {
		const loc = e.location ? ` · ${e.location}` : '';
		return `${e.name}${loc} (${e.startDate.replaceAll('-', '.')})`;
	}

	function fmt(d: string): string {
		return d.replaceAll('-', '.');
	}
	function dateRange(start: string, end: string | null): string {
		if (!end || end === start) return fmt(start);
		// Same year: trim the year off the end date for brevity (2026.09.12 → 09.14)
		const same = start.slice(0, 4) === end.slice(0, 4);
		return `${fmt(start)} → ${same ? fmt(end).slice(5) : fmt(end)}`;
	}
</script>

<div class="page-header">
	<h1>Conventions <span class="count">{data.conventions.length}</span></h1>
	<div class="header-actions">
		<button class="btn btn-outline" disabled={syncing} onclick={() => syncForm.requestSubmit()}>
			<RefreshCw size={16} /> {syncing ? 'Syncing…' : 'Sync from cons.fyi'}
		</button>
		<button class="btn btn-primary" onclick={() => (showAdd = !showAdd)}><Plus size={16} /> Add Convention</button>
	</div>
</div>

<form
	method="POST"
	action="?/sync"
	bind:this={syncForm}
	use:enhance={() => {
		syncing = true;
		return async ({ update }) => {
			await update();
			syncing = false;
		};
	}}
	style="display:none"
></form>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}
{#if form?.message}
	<p class="success">{form.message}</p>
{/if}

{#if showAdd}
	<div class="add-panel">
		<!-- Primary: pick from the cons.fyi feed -->
		<form
			method="POST"
			action="?/addFromSource"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
				};
			}}
			class="pick-form"
		>
			<label class="grow">
				<span>Add from cons.fyi</span>
				<select class="input" name="sourceId" required>
					<option value="" disabled selected>Select a convention…</option>
					{#each data.available as e}
						<option value={e.id}>{sourceLabel(e)}</option>
					{:else}
						<option value="" disabled>No upcoming cons available from the feed</option>
					{/each}
				</select>
			</label>
			<label class="status-field">
				<span>Status</span>
				<select class="input" name="status">
					<option value="confirmed">Confirmed</option>
					<option value="maybe">Maybe</option>
					<option value="considering">Considering</option>
				</select>
			</label>
			<button type="submit" class="btn btn-primary" disabled={data.available.length === 0}>Add</button>
		</form>

		<button type="button" class="manual-toggle" onclick={() => (showManual = !showManual)}>
			{showManual ? '− Hide manual entry' : "+ Can't find it? Add manually"}
		</button>

		{#if showManual}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					return async ({ update }) => {
						await update();
						showManual = false;
					};
				}}
				class="add-form"
			>
				<div class="add-grid">
					<label>
						<span>Name</span>
						<input type="text" class="input" name="name" placeholder="Midwest FurFest" required />
					</label>
					<label>
						<span>Location</span>
						<input type="text" class="input" name="location" placeholder="Chicago, IL" />
					</label>
					<label>
						<span>Start date</span>
						<input type="date" class="input" name="startDate" required />
					</label>
					<label>
						<span>End date</span>
						<input type="date" class="input" name="endDate" />
					</label>
					<label>
						<span>Website</span>
						<input type="text" class="input" name="url" placeholder="https://…" />
					</label>
					<label>
						<span>Status</span>
						<select class="input" name="status">
							<option value="confirmed">Confirmed</option>
							<option value="maybe">Maybe</option>
							<option value="considering">Considering</option>
						</select>
					</label>
				</div>
				<div class="add-actions">
					<button type="submit" class="btn btn-primary">Add manually</button>
				</div>
			</form>
		{/if}
	</div>
{/if}

<div class="table-wrapper">
	<table class="data-table">
		<thead>
			<tr>
				<th>Convention</th>
				<th>Dates</th>
				<th>Location</th>
				<th>Status</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.conventions as con}
				<tr>
					<td>
						<span class="con-name">{con.name}</span>
						{#if con.sourceId}
							<span class="src-badge" title="Added from cons.fyi">cons.fyi</span>
						{/if}
						{#if con.url}
							<a href={con.url} target="_blank" rel="noopener noreferrer" class="con-link" aria-label="Open website">
								<ExternalLink size={13} />
							</a>
						{/if}
					</td>
					<td>{dateRange(con.startDate, con.endDate)}</td>
					<td>{con.location ?? '—'}</td>
					<td><span class="status status-{con.status}">{con.status}</span></td>
					<td>
						<button class="icon-btn" aria-label="Delete convention" onclick={() => (deleteTarget = { id: con.id, name: con.name })}>
							<Trash2 size={16} />
						</button>
					</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="empty">No conventions yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each data.conventions as con}
		<div class="mobile-item">
			<div class="mobile-main">
				<span class="con-name">{con.name}</span>
				<span class="mobile-meta">{dateRange(con.startDate, con.endDate)}{con.location ? ` · ${con.location}` : ''}</span>
			</div>
			<span class="status status-{con.status}">{con.status}</span>
			<form method="POST" action="?/delete" use:enhance class="inline-form">
				<input type="hidden" name="id" value={con.id} />
				<button type="submit" class="icon-btn" aria-label="Delete convention"><Trash2 size={16} /></button>
			</form>
		</div>
	{:else}
		<p class="empty">No conventions yet.</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (showAdd = true)}>+ New Convention</button>
	<button class="mobile-add-row" disabled={syncing} onclick={() => syncForm.requestSubmit()}>
		{syncing ? 'Syncing…' : '⟳ Sync from cons.fyi'}
	</button>
</div>

<form method="POST" action="?/delete" use:enhance bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete Convention"
		message={`Delete "${deleteTarget.name}" from your schedule?`}
		onconfirm={() => {
			deleteForm.requestSubmit();
			deleteTarget = null;
		}}
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

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.success {
		color: #4ade80;
		font-size: 14px;
		margin-bottom: 16px;
	}

	.add-panel {
		margin-bottom: 24px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.pick-form {
		display: flex;
		gap: 12px;
		align-items: flex-end;
	}

	.pick-form .grow {
		flex: 1;
	}

	.pick-form label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.pick-form label span {
		font-size: 13px;
		font-weight: 500;
	}

	.status-field {
		width: 150px;
		flex-shrink: 0;
	}

	.manual-toggle {
		margin-top: 14px;
		background: none;
		border: none;
		padding: 0;
		color: var(--primary);
		font-size: 13px;
		font-family: var(--font-secondary);
		cursor: pointer;
	}

	.add-form {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	.src-badge {
		display: inline-block;
		margin-left: 8px;
		padding: 1px 7px;
		border-radius: var(--radius-pill);
		font-size: 10px;
		font-weight: 600;
		background: var(--secondary);
		color: var(--muted-foreground);
		vertical-align: middle;
	}

	.add-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.add-grid label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.add-grid span {
		font-size: 13px;
		font-weight: 500;
	}

	.add-actions {
		display: flex;
		gap: 8px;
		margin-top: 16px;
	}

	.table-wrapper {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow: hidden;
	}

	.con-name {
		font-weight: 500;
	}

	.con-link {
		display: inline-flex;
		margin-left: 6px;
		color: var(--muted-foreground);
		vertical-align: middle;
	}

	.status {
		display: inline-block;
		padding: 2px 10px;
		border-radius: var(--radius-pill);
		font-size: 12px;
		font-weight: 600;
		text-transform: capitalize;
	}

	.status-confirmed {
		background: color-mix(in srgb, #22c55e 18%, transparent);
		color: #22c55e;
	}

	.status-maybe {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
		color: var(--primary);
	}

	.status-considering {
		background: var(--secondary);
		color: var(--muted-foreground);
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

	.icon-btn:hover {
		color: var(--destructive);
	}

	.inline-form {
		display: inline;
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

		.add-grid {
			grid-template-columns: 1fr;
		}

		.pick-form {
			flex-direction: column;
			align-items: stretch;
		}

		.status-field {
			width: 100%;
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

		.mobile-main {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 0;
		}

		.mobile-meta {
			font-size: 12px;
			color: var(--muted-foreground);
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
	}
</style>
