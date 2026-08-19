<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plus, Trash2, ExternalLink, RefreshCw, QrCode } from 'lucide-svelte';
	import { formatDate, formatDateRange } from '$lib';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	function statusLabel(status: string): string {
		if (status === 'confirmed') return m.admin_conventions_status_confirmed();
		if (status === 'maybe') return m.admin_conventions_status_maybe();
		if (status === 'considering') return m.admin_conventions_status_considering();
		return status;
	}

	let showAdd = $state(false);
	let showManual = $state(false);
	let syncing = $state(false);
	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	let syncForm: HTMLFormElement;

	function sourceLabel(e: { name: string; location: string; startDate: string }): string {
		const loc = e.location ? ` · ${e.location}` : '';
		return `${e.name}${loc} (${formatDate(e.startDate)})`;
	}

	// The event's own zone rides along on the line that already carries the
	// location. That zone is what decides whether a row counts as live, so it has
	// to be readable when it looks wrong.
	function metaLine(...parts: (string | null | undefined)[]): string {
		return parts.filter(Boolean).join(' · ');
	}
</script>

<div class="page-header">
	<h1>{m.admin_nav_conventions()} <span class="count">{data.conventions.length}</span></h1>
	<div class="header-actions">
		<button class="btn btn-outline" disabled={syncing} onclick={() => syncForm.requestSubmit()}>
			<RefreshCw size={16} /> {syncing ? m.admin_conventions_syncing() : m.admin_conventions_sync()}
		</button>
		<button class="btn btn-primary" onclick={() => (showAdd = !showAdd)}><Plus size={16} /> {m.admin_conventions_add()}</button>
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
				<span>{m.admin_conventions_add_from_source()}</span>
				<select class="input" name="sourceId" required>
					<option value="" disabled selected>{m.admin_conventions_select_placeholder()}</option>
					{#each data.available as e}
						<option value={e.id}>{sourceLabel(e)}</option>
					{:else}
						<option value="" disabled>{m.admin_conventions_none_available()}</option>
					{/each}
				</select>
			</label>
			<label class="status-field">
				<span>{m.admin_conventions_status()}</span>
				<select class="input" name="status">
					<option value="confirmed">{m.admin_conventions_status_confirmed()}</option>
					<option value="maybe">{m.admin_conventions_status_maybe()}</option>
					<option value="considering">{m.admin_conventions_status_considering()}</option>
				</select>
			</label>
			<button type="submit" class="btn btn-primary" disabled={data.available.length === 0}>{m.admin_add()}</button>
		</form>

		<button type="button" class="manual-toggle" onclick={() => (showManual = !showManual)}>
			{showManual ? m.admin_conventions_manual_hide() : m.admin_conventions_manual_show()}
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
						<span>{m.admin_conventions_field_name()}</span>
						<input type="text" class="input" name="name" placeholder="Midwest FurFest" required />
					</label>
					<label>
						<span>{m.admin_conventions_field_location()}</span>
						<input type="text" class="input" name="location" placeholder="Chicago, IL" />
					</label>
					<label>
						<span>{m.admin_conventions_field_start()}</span>
						<input type="date" class="input" name="startDate" required />
					</label>
					<label>
						<span>{m.admin_conventions_field_end()}</span>
						<input type="date" class="input" name="endDate" />
					</label>
					<label>
						<span>{m.admin_conventions_field_website()}</span>
						<input type="text" class="input" name="url" placeholder="https://…" />
					</label>
					<label>
						<span>{m.admin_conventions_status()}</span>
						<select class="input" name="status">
							<option value="confirmed">{m.admin_conventions_status_confirmed()}</option>
							<option value="maybe">{m.admin_conventions_status_maybe()}</option>
							<option value="considering">{m.admin_conventions_status_considering()}</option>
						</select>
					</label>
				</div>
				<div class="add-actions">
					<button type="submit" class="btn btn-primary">{m.admin_conventions_add_manually()}</button>
				</div>
			</form>
		{/if}
	</div>
{/if}

<div class="table-wrapper">
	<table class="data-table">
		<thead>
			<tr>
				<th>{m.admin_conventions_col_name()}</th>
				<th>{m.admin_conventions_col_dates()}</th>
				<th>{m.admin_conventions_field_location()}</th>
				<th>{m.admin_conventions_status()}</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.conventions as con}
				{@const live = con.id === data.liveId}
				<tr class:is-live={live}>
					<td>
						<span class="con-name">{con.name}</span>
						{#if con.sourceId}
							<span class="src-badge" title={m.admin_conventions_source_title()}>cons.fyi</span>
						{/if}
						{#if con.url}
							<a href={con.url} target="_blank" rel="noopener noreferrer" class="con-link" aria-label={m.admin_conventions_open_website()}>
								<ExternalLink size={13} />
							</a>
						{/if}
					</td>
					<td>{formatDateRange(con.startDate, con.endDate)}</td>
					<td>{metaLine(con.location, con.timezone) || '—'}</td>
					<td>
						{#if live}
							<span class="live-pill"><span class="live-dot"></span>{m.connect_here_now()}</span>
						{:else}
							<span class="status status-{con.status}">{statusLabel(con.status)}</span>
						{/if}
					</td>
					<td>
						<div class="row-actions">
							{#if live}
								<!-- A plain link on purpose: /connect/qr is public, so the scan target
								     still loads when admin has failed closed on a D1 outage, or when
								     convention wifi has not left the session cookie intact. -->
								<a href="/connect/qr" class="btn btn-primary qr-btn">
									<QrCode size={15} /> {m.admin_conventions_show_qr()}
								</a>
							{/if}
							<button class="icon-btn" aria-label={m.admin_conventions_delete_aria()} onclick={() => (deleteTarget = { id: con.id, name: con.name })}>
								<Trash2 size={16} />
							</button>
						</div>
					</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="empty">{m.admin_conventions_empty()}</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile list -->
<div class="mobile-list">
	{#each data.conventions as con}
		{@const live = con.id === data.liveId}
		<div class="mobile-item" class:is-live={live}>
			<div class="mobile-main">
				<span class="con-name">{con.name}</span>
				<span class="mobile-meta">{metaLine(formatDateRange(con.startDate, con.endDate), con.location, con.timezone)}</span>
				{#if live}
					<a href="/connect/qr" class="btn btn-primary qr-btn mobile-qr">
						<QrCode size={15} /> {m.admin_conventions_show_qr()}
					</a>
				{/if}
			</div>
			{#if live}
				<span class="live-pill"><span class="live-dot"></span>{m.connect_here_now()}</span>
			{:else}
				<span class="status status-{con.status}">{statusLabel(con.status)}</span>
			{/if}
			<form method="POST" action="?/delete" use:enhance class="inline-form">
				<input type="hidden" name="id" value={con.id} />
				<button type="submit" class="icon-btn" aria-label={m.admin_conventions_delete_aria()}><Trash2 size={16} /></button>
			</form>
		</div>
	{:else}
		<p class="empty">{m.admin_conventions_empty()}</p>
	{/each}
	<button class="mobile-add-row" onclick={() => (showAdd = true)}>+ {m.admin_conventions_add()}</button>
	<button class="mobile-add-row" disabled={syncing} onclick={() => syncForm.requestSubmit()}>
		{syncing ? m.admin_conventions_syncing() : `⟳ ${m.admin_conventions_sync()}`}
	</button>
</div>

<form method="POST" action="?/delete" use:enhance bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title={m.admin_conventions_delete_title()}
		message={m.admin_conventions_delete_message({ name: deleteTarget.name })}
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
		text-decoration: none;
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

	/* The live row. Same primary-mixed wash as the /connect here-now block rather
	   than a signal colour of its own, so it reads as elevated in every fork
	   theme. The bar is an inset shadow, not a border, so the row does not shift
	   by 3px when it goes live. Painted on the cells because a shadow on a <tr>
	   is dropped under border-collapse. */
	tr.is-live > td {
		background: color-mix(in srgb, var(--primary) 8%, transparent);
	}

	tr.is-live > td:first-child {
		box-shadow: inset 3px 0 0 var(--primary);
	}

	.live-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 10px;
		border-radius: var(--radius-pill);
		font-size: 12px;
		font-weight: 600;
		background: var(--primary);
		color: var(--primary-foreground);
		white-space: nowrap;
	}

	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--primary-foreground);
		flex: none;
	}

	/* Motion is a second cue here, never the only one: the pill's label carries
	   the state on its own for anyone who suppresses animation. */
	@media (prefers-reduced-motion: no-preference) {
		.live-dot {
			animation: blip 2.4s ease-in-out infinite;
		}
		@keyframes blip {
			0%,
			72%,
			100% {
				opacity: 1;
			}
			84% {
				opacity: 0.35;
			}
		}
	}

	.row-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}

	/* Shorter than the 40px default so a live row keeps the height of every other
	   row in the table. */
	.qr-btn {
		height: 32px;
		padding: 6px 14px;
		font-size: 13px;
		white-space: nowrap;
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

		.mobile-item.is-live {
			padding-left: 12px;
			background: color-mix(in srgb, var(--primary) 8%, transparent);
			box-shadow: inset 3px 0 0 var(--primary);
		}

		/* Under the meta line rather than in the cramped action slot: this is the
		   button that gets tapped in a hallway with one hand. */
		.mobile-qr {
			align-self: flex-start;
			margin-top: 8px;
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
