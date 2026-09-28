<script lang="ts">
	import { tick } from 'svelte';
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
	// The FurTrack event each row's select shows while it differs from the
	// saved one, keyed per form (the table and the mobile list each render one
	// per row). Save only shows for a pending change.
	let picked = $state<Record<string, string>>({});
	let syncForm: HTMLFormElement;
	let addPanel = $state<HTMLDivElement>();

	// The panel renders above the list, so an Add pressed at the foot of a long
	// list would open it out of sight: bring it into view and put focus in it.
	async function toggleAdd() {
		showAdd = !showAdd;
		if (!showAdd) return;
		await tick();
		// On a screen too short for the panel above the room kept clear for the
		// phone's bottom nav, 'nearest' would cut off its top: start there.
		const kept = parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
		const tall = (addPanel?.offsetHeight ?? 0) > window.innerHeight - kept;
		addPanel?.scrollIntoView({ block: tall ? 'start' : 'nearest' });
		addPanel?.querySelector('select')?.focus();
	}

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
		<button class="btn btn-outline btn-desktop-only" disabled={syncing} onclick={() => syncForm.requestSubmit()}>
			<RefreshCw size={16} /> {syncing ? m.admin_conventions_syncing() : m.admin_conventions_sync()}
		</button>
		<button class="btn btn-primary btn-desktop-only" aria-expanded={showAdd} onclick={toggleAdd}><Plus size={16} /> {m.admin_conventions_add()}</button>
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

<!-- Always rendered, so a result that lands while focus stays on a row's Save
     is announced: live regions only speak for changes inside them. Keyed on
     the result, so the same refusal twice in a row is announced twice. -->
<p class="error" id="conventions-error" role="alert">{#key form}{#if form?.error}{form.error}{/if}{/key}</p>
<p class="success" role="status">{#key form}{#if form?.message}{form.message}{/if}{/key}</p>

<!-- Hidden rather than removed when closed, so what was typed in it is still
     there when it opens again. -->
<div class="add-panel" hidden={!showAdd} bind:this={addPanel}>
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
				return async ({ result, update }) => {
					await update();
					// A refused add keeps the form open with what was typed.
					if (result.type === 'success') showManual = false;
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
				<label>
					<span>{m.admin_conventions_field_event()}</span>
					<select class="input" name="furtrackEvent">
						<option value="">{m.admin_conventions_event_none()}</option>
						{#each data.eventTags as tag}
							<option value={tag}>{tag}</option>
						{/each}
					</select>
				</label>
			</div>
			<div class="add-actions">
				<button type="submit" class="btn btn-primary">{m.admin_conventions_add_manually()}</button>
			</div>
		</form>
	{/if}
</div>

<!-- One row's FurTrack event: the link the passport's past stamps read. A
     tag no photo carries any more still shows as the row's value, so the list
     never hides a link and saving leaves it alone. Not reset after a save: the
     select already shows what was saved. A refused save puts the select back
     on the saved tag, so the row never shows a link it does not have. Both
     selects carry the convention's name in their accessible name; the mobile
     list has no column header, so it also shows a visible label. -->
{#snippet eventForm(con: { id: number; name: string; furtrackEvent: string | null }, mobile: boolean)}
	{@const key = `${mobile ? 'm' : 'd'}-${con.id}`}
	{@const saved = con.furtrackEvent ?? ''}
	{@const value = picked[key] ?? saved}
	<form
		method="POST"
		action="?/setEvent"
		use:enhance={({ formElement }) => {
			return async ({ result, update }) => {
				await update({ reset: false });
				delete picked[key];
				// Save hides once the change is saved or refused; keep focus on the
				// row rather than letting it fall to the page.
				if (result.type !== 'redirect') formElement.querySelector('select')?.focus();
			};
		}}
		class="event-form"
		class:mobile-event={mobile}
	>
		{#if mobile}
			<label class="event-label" for="event-{key}">{m.admin_conventions_field_event()}</label>
		{/if}
		<input type="hidden" name="id" value={con.id} />
		<select
			class="input event-select"
			id="event-{key}"
			name="furtrackEvent"
			{value}
			onchange={(e) => (picked[key] = e.currentTarget.value)}
			aria-label={m.admin_conventions_event_aria({ name: con.name })}
			aria-describedby={form && 'eventId' in form && form.eventId === con.id ? 'conventions-error' : undefined}
		>
			<option value="">{m.admin_conventions_event_none()}</option>
			{#if con.furtrackEvent && !data.eventTags.includes(con.furtrackEvent)}
				<option value={con.furtrackEvent}>{con.furtrackEvent}</option>
			{/if}
			{#each data.eventTags as tag}
				<option value={tag}>{tag}</option>
			{/each}
		</select>
		<button
			type="submit"
			class="btn btn-outline event-save"
			class:unchanged={value === saved}
			aria-label={m.admin_conventions_event_save_aria({ name: con.name })}
		>
			{m.admin_conventions_event_save()}
		</button>
	</form>
{/snippet}

<!-- A named tab stop, so the sideways scroll is reachable by keyboard and
     every browser announces the same thing when it lands there. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="table-wrapper" role="region" tabindex="0" aria-label={m.admin_nav_conventions()}>
	<table class="data-table">
		<thead>
			<tr>
				<th>{m.admin_conventions_col_name()}</th>
				<th>{m.admin_conventions_col_dates()}</th>
				<th>{m.admin_conventions_field_location()}</th>
				<th>{m.admin_conventions_field_event()}</th>
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
					<!-- The arrow keeps to its start date, so a range too wide for its
					     column breaks after the arrow on every row, not before it on some. -->
					<td class="dates">{formatDateRange(con.startDate, con.endDate).replace(' → ', '\u00a0→ ')}</td>
					<td>{metaLine(con.location, con.timezone) || '—'}</td>
					<td>{@render eventForm(con, false)}</td>
					<td>
						{#if live}
							<span class="live-pill">{m.connect_here_now()}</span>
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
								<a href="/connect/qr" class="btn btn-outline qr-btn">
									<QrCode size={15} /> {m.admin_conventions_show_qr()}
								</a>
							{/if}
							<button class="icon-btn" aria-label={m.admin_conventions_delete_aria({ name: con.name })} onclick={() => (deleteTarget = { id: con.id, name: con.name })}>
								<Trash2 size={16} />
							</button>
						</div>
					</td>
				</tr>
			{:else}
				<tr><td colspan="6" class="empty">{m.admin_conventions_empty()}</td></tr>
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
					<a href="/connect/qr" class="btn btn-outline qr-btn mobile-qr">
						<QrCode size={15} /> {m.admin_conventions_show_qr()}
					</a>
				{/if}
			</div>
			{#if live}
				<span class="live-pill">{m.connect_here_now()}</span>
			{:else}
				<span class="status status-{con.status}">{statusLabel(con.status)}</span>
			{/if}
			<button type="button" class="icon-btn" aria-label={m.admin_conventions_delete_aria({ name: con.name })} onclick={() => (deleteTarget = { id: con.id, name: con.name })}>
				<Trash2 size={16} />
			</button>
			{@render eventForm(con, true)}
		</div>
	{:else}
		<p class="empty">{m.admin_conventions_empty()}</p>
	{/each}
	<button class="mobile-add-row" aria-expanded={showAdd} onclick={toggleAdd}>+ {m.admin_conventions_add()}</button>
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
	/* Wraps, so on a narrow line the actions drop under the title as a unit
	   instead of squeezing their labels onto two lines. */
	.page-header {
		display: flex;
		flex-wrap: wrap;
		row-gap: 12px;
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

	/* Nowrap keeps each label on one line; the pair wraps instead, so large
	   text never pushes it past the page. */
	.header-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.header-actions > * {
		white-space: nowrap;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.success {
		color: var(--status-ok);
		font-size: 14px;
		margin-bottom: 16px;
	}

	/* The live regions stay in the page when there is nothing to say; empty,
	   they take no room. */
	.error:empty,
	.success:empty {
		margin-bottom: 0;
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
		color: var(--primary-text);
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

	/* Scrolls sideways when the columns outgrow it, so the row actions stay
	   reachable instead of being clipped. */
	.table-wrapper {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		overflow-x: auto;
		overflow-y: hidden;
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
		/* Transparent here so the confirmed chip's visible edge below costs it no
		   extra width and the chips stay the same size as each other. */
		border: 1px solid transparent;
	}

	/* 12%, not the 18% the other chips use: --status-ok on its own tint is the
	   tightest pairing on terracotta light, where 12% measures 4.56:1 and 13%
	   drops under the 4.5:1 floor. At 12% the fill nearly disappears on the light
	   themes, so the chip keeps its shape with an edge instead of a heavier fill.
	   All three chips draw that edge at 40% of their own ink, so the border is the
	   shared chip language rather than a mark that singles out one status.
	   Mixed over --background rather than transparent: a live row washes its cells
	   in 8% --primary, and a translucent fill composites with that wash and drops
	   to 4.12:1 on terracotta light. Opaque, the chip reads the same on a live row
	   as off one. */
	.status-confirmed {
		background: color-mix(in srgb, var(--status-ok) 12%, var(--background));
		border-color: color-mix(in srgb, var(--status-ok) 40%, transparent);
		color: var(--status-ok);
	}

	/* The label is --foreground, not --primary-text: --primary-text has 4.68:1 of
	   headroom on a bare surface, so no percentage of its own tint clears 4.5:1 on
	   terracotta light. The tint and the edge still carry the primary hue, the way
	   Callout's .text and the mobile list's live meta do. */
	.status-maybe {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
		border-color: color-mix(in srgb, var(--primary-text) 40%, transparent);
		color: var(--foreground);
	}

	.status-considering {
		background: var(--secondary);
		border-color: color-mix(in srgb, var(--muted-foreground) 40%, transparent);
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

	.icon-btn:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.event-form {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* The QR button's 32px, so the tag control does not make every row taller;
	   a minimum, so it still grows with enlarged text. Its own width, not the
	   input's 100%, so a short tag takes only the room it needs; the table and
	   the wide list cap it below. A tag cut short ends in an ellipsis. */
	.event-select {
		min-height: 32px;
		height: auto;
		padding-block: 0;
		width: auto;
		flex: 1 1 auto;
		font-size: 13px;
		text-overflow: ellipsis;
	}

	/* A select is as wide as its longest option, so one long tag would push
	   the row actions out of the table. The open picker still shows it whole. */
	.table-wrapper .event-select {
		max-width: 240px;
	}

	.event-save {
		min-height: 32px;
		height: auto;
		padding: 6px 14px;
		font-size: 13px;
	}

	/* Holds its place while hidden, so the row does not shift when it shows. */
	.event-save.unchanged {
		visibility: hidden;
	}

	/* The mobile row has nothing to keep in line, so the select takes the
	   whole line until there is a change to save. */
	.mobile-event .event-save.unchanged {
		display: none;
	}

	.mobile-list {
		display: none;
	}

	/* The list takes over well above phone width: below about 1240px the
	   table's columns outgrow the page and its edge cuts through the status
	   and the row actions. The header keeps Add and Sync down to phone width,
	   where they move to the foot of the list. */
	@media (max-width: 1240px) {
		.table-wrapper {
			display: none;
		}

		/* Caps the list at a readable width, so it looks the same at 1240px as
		   at 1024px. The header, the add panel and the messages share the cap, so
		   the header's actions end over the list's trash column. */
		.mobile-list {
			display: flex;
			flex-direction: column;
		}

		.mobile-list,
		.page-header,
		.add-panel,
		.error,
		.success {
			max-width: 760px;
		}

		/* Top-aligned, so the status pill sits level with the name; wraps, so the
		   FurTrack event gets a full-width line of its own under the row. */
		.mobile-item {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-start;
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

		/* The wash runs past the row's left edge instead of indenting it, so the
		   live row's name, meta and select line up with every other row. It ends
		   flush with the list's right edge, like the dividers. */
		.mobile-item.is-live {
			margin-left: -12px;
			padding-left: 12px;
			background: color-mix(in srgb, var(--primary) 8%, transparent);
			box-shadow: inset 3px 0 0 var(--primary);
		}

		/* The wash puts muted text under 4.5:1 on the light themes, and the meta
		   line is the dates and the venue, the row's only real content. */
		.mobile-item.is-live .mobile-meta {
			color: var(--foreground);
		}

		/* Under the meta line rather than in the cramped action slot: this is the
		   button that gets tapped in a hallway with one hand. */
		.mobile-qr {
			align-self: flex-start;
			margin-top: 8px;
		}

		/* Drops the minimum width the select's longest option would set, so a
		   long tag cannot widen the page past a narrow screen. */
		.mobile-event {
			flex-basis: 100%;
			flex-wrap: wrap;
			row-gap: 6px;
			min-width: 0;
		}

		.event-label {
			flex-basis: 100%;
			font-size: 13px;
			font-weight: 500;
		}

		/* On a wide line the select stops at a readable width and Save sits
		   beside it; a portrait phone's line is narrower than the cap, so there
		   the select fills it. */
		.mobile-event .event-select {
			min-width: 0;
			max-width: 480px;
		}

		/* Hidden until phone width; the block below shows it. */
		.mobile-add-row {
			display: none;
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
	}

	/* After the list's block, so these win over it. */
	@media (max-width: 768px) {
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

		/* Runs full bleed: the negative margin cancels the page's 16px gutter on
		   both sides. */
		.mobile-item.is-live {
			margin-inline: -16px;
			padding-inline: 16px;
		}

		/* The header's Add and Sync drop out at this same width (.btn-desktop-only
		   in app.css), so the list's own pair takes over with no width where both
		   or neither show. */
		.mobile-add-row {
			display: flex;
		}
	}
</style>
