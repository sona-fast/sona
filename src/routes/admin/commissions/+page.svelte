<script lang="ts">
	import { ClipboardList, Eye, Image as ImageIcon, Pencil, Plus } from 'lucide-svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import CommissionIntro from '$lib/components/CommissionIntro.svelte';
	import { isActiveStatus, PAYMENT_LABELS, STATUS_LABELS, STATUS_TONES } from '$lib/commissions';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	type Entry = (typeof data.entries)[number];

	const groups = $derived([
		{
			key: 'active',
			heading: m.admin_commissions_active(),
			empty: m.admin_commissions_active_empty(),
			rows: data.entries.filter((e) => isActiveStatus(e.status))
		},
		{
			key: 'finished',
			heading: m.admin_commissions_finished(),
			empty: m.admin_commissions_finished_empty(),
			rows: data.entries.filter((e) => !isActiveStatus(e.status))
		}
	]);

	// While the gate is closed the row's one link views the entry (read-only,
	// with Delete still offered) instead of editing it.
	function rowLinkLabel(entry: Entry): string {
		return data.gate.open
			? m.admin_commissions_edit_aria({ title: entry.title })
			: m.admin_commissions_view_aria({ title: entry.title });
	}
</script>

<div class="page-header">
	<h1>
		{m.admin_nav_commissions()}
		{#if data.entries.length > 0}<span class="count">{m.admin_commissions_count({ count: data.entries.length })}</span>{/if}
	</h1>
	{#if data.gate.open}
		<div class="header-actions">
			<a href="/admin/commissions/new" class="btn btn-primary"><Plus size={16} aria-hidden="true" /> {m.admin_commissions_new()}</a>
		</div>
	{/if}
</div>

<CommissionIntro gate={data.gate} empty={data.entries.length === 0} />

{#if data.entries.length === 0}
	<div class="empty">
		<ClipboardList size={36} aria-hidden="true" />
		<h2>{m.admin_commissions_empty_title()}</h2>
		<p>{data.gate.open ? m.admin_commissions_empty_body() : m.admin_commissions_empty_body_gated()}</p>
	</div>
{:else}
	{#each groups as group (group.key)}
		<section class="section" aria-labelledby="h-{group.key}">
			<div class="section-head">
				<h2 id="h-{group.key}">{group.heading}</h2>
				<span class="count"
					><span aria-hidden="true">{group.rows.length}</span><span class="sr-only"
						>{m.admin_commissions_count({ count: group.rows.length })}</span
					></span
				>
			</div>
			{#if group.rows.length === 0}
				<p class="section-empty">{group.empty}</p>
			{:else}
				<div class="table-wrapper">
					<table class="data-table ledger-table" aria-labelledby="h-{group.key}">
						<thead>
							<tr>
								<th class="col-entry">{m.admin_commissions_col_entry()}</th>
								<th class="col-artist">{m.admin_commissions_col_artist()}</th>
								<th class="col-chars">{m.admin_commissions_col_characters()}</th>
								<th class="col-status">{m.admin_commissions_col_status()}</th>
								<th class="col-pay">{m.admin_commissions_col_payment()}</th>
								<th class="col-gallery">{m.admin_commissions_col_gallery()}</th>
								<th class="col-actions"><span class="sr-only">{m.admin_col_actions()}</span></th>
							</tr>
						</thead>
						<tbody>
							{#each group.rows as entry (entry.id)}
								<!-- data-label feeds the card layout's ::before labels; the CSS
								     hooks select by class, never by the localized label text. -->
								<tr>
									<th scope="row">
										<div class="entry-cell">
											<span class="entry-title">{entry.title}</span>
											{#if entry.kind}<span class="entry-kind">{entry.kind}</span>{/if}
										</div>
									</th>
									<td data-label={m.admin_commissions_col_artist()}>
										<div class="artist-cell">
											<ArtistAvatar name={entry.artistName} avatarUrl={entry.artistAvatarUrl} size={28} />
											<span>{entry.artistName}</span>
										</div>
									</td>
									<td data-label={m.admin_commissions_col_characters()}>
										{#if entry.characterNames.length > 0}
											<span class="chars">{entry.characterNames.join(', ')}</span>
										{:else}
											<span class="chars none">{m.admin_commissions_chars_none()}</span>
										{/if}
									</td>
									<td data-label={m.admin_commissions_col_status()}>
										<span class="chip {STATUS_TONES[entry.status]}">{STATUS_LABELS[entry.status]()}</span>
									</td>
									<td data-label={m.admin_commissions_col_payment()}>
										<span class="pay">{PAYMENT_LABELS[entry.payment]()}</span>
									</td>
									{#if entry.piece}
										<td data-label={m.admin_commissions_col_gallery()}>
											<div class="gallery-cell">
												<span class="thumb" aria-hidden="true"><ImageIcon size={16} /></span>
												<a href="/admin/images/{entry.piece.id}/edit">{entry.piece.title}</a>
											</div>
										</td>
									{:else if entry.status === 'delivered'}
										<td data-label={m.admin_commissions_col_gallery()}>
											<span class="muted">{m.admin_commissions_not_in_gallery()}</span>
										</td>
									{:else}
										<td class="gallery-none" data-label={m.admin_commissions_col_gallery()}>
											<span class="sr-only">{m.admin_commissions_not_in_gallery()}</span>
										</td>
									{/if}
									<td class="col-actions">
										<a href="/admin/commissions/{entry.id}/edit" class="icon-btn" aria-label={rowLinkLabel(entry)}>
											{#if data.gate.open}<Pencil size={16} aria-hidden="true" />{:else}<Eye size={16} aria-hidden="true" />{/if}
										</a>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/each}
{/if}

<style>
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 12px;
		flex-wrap: wrap;
	}
	h1 { font-size: 24px; margin: 0; }
	.count {
		font-size: 14px;
		font-weight: 400;
		color: var(--muted-foreground);
		font-family: var(--font-secondary);
	}
	.header-actions { display: flex; gap: 10px; flex-wrap: wrap; }

	.empty {
		display: flex; flex-direction: column; align-items: center; gap: 10px;
		padding: 56px 24px; color: var(--muted-foreground); text-align: center;
		border: 1px dashed var(--border); border-radius: var(--radius-s);
	}
	.empty h2 { font-size: 16px; color: var(--foreground); margin: 0; }
	.empty p { font-size: 14px; max-width: 46ch; line-height: 1.5; text-wrap: pretty; margin: 0; }

	/* The section is the container the card layout queries, so the tables
	   become cards whenever the section is too narrow, sidebar or not. */
	.section { margin-bottom: 32px; container-type: inline-size; }
	.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
	.section-head h2 { font-size: 16px; margin: 0; }
	.section-empty {
		font-size: 13px; line-height: 1.5; color: var(--muted-foreground);
		padding: 16px; border: 1px dashed var(--border); border-radius: var(--radius-s);
		text-wrap: pretty; margin: 0;
	}

	/* Scrolls sideways rather than clipping when a long word won't break. */
	.table-wrapper { border: 1px solid var(--border); border-radius: var(--radius-s); overflow-x: auto; }
	/* Titles, kinds, and names are typed by the owner, so a long word breaks
	   inside its cell instead of running under the next one. */
	.ledger-table { table-layout: fixed; overflow-wrap: anywhere; }
	.ledger-table th[scope='row'] { font-weight: 400; text-align: left; }
	.ledger-table td { vertical-align: middle; }
	.col-chars { width: 7rem; }
	.col-status, .col-pay { width: 6.5rem; }
	.col-gallery { width: 9.5rem; }
	.col-actions { width: 56px; white-space: nowrap; }

	.entry-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.entry-title { font-weight: 500; }
	.entry-kind { font-size: 12px; color: var(--muted-foreground); }
	.artist-cell { display: flex; align-items: center; gap: 10px; white-space: normal; min-width: 0; }
	.chars { font-size: 13px; color: var(--foreground); }
	.chars.none { color: var(--muted-foreground); }
	/* Chip text stays --foreground in every tone: the tint carries the hue, and
	   the label is what has to clear 4.5:1 in every theme. */
	.chip {
		display: inline-block; padding: 2px 8px; border-radius: var(--radius-pill);
		font-size: 11px; font-weight: 500; white-space: nowrap;
		background: var(--secondary); color: var(--foreground);
		border: 1px solid transparent;
	}
	.chip.progress { background: color-mix(in srgb, var(--primary) 16%, transparent); }
	.chip.done { background: color-mix(in srgb, var(--status-ok) 15%, transparent); }
	.chip.closed { background: transparent; border-color: var(--input); }
	.pay { font-size: 13px; white-space: nowrap; }
	.muted { font-size: 12px; color: var(--muted-foreground); }
	.gallery-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
	.gallery-cell a { min-width: 0; }
	.thumb {
		width: 40px; height: 40px; border-radius: var(--radius-xs);
		background: var(--secondary); color: var(--muted-foreground);
		display: flex; align-items: center; justify-content: center; flex: none;
	}

	.icon-btn {
		background: none; border: none; color: var(--muted-foreground); cursor: pointer;
		padding: 4px; border-radius: var(--radius-xs); display: inline-flex; transition: color 0.15s;
	}
	.icon-btn:hover { color: var(--foreground); }

	/* Cards when the section is narrower than the seven columns need, which is
	   760px in the mocks. In a card, the row header leaves room on its right for
	   the row's one link, which sits in the top-right corner. */
	@container (max-width: 760px) {
		.table-wrapper { border: none; border-radius: 0; overflow: visible; }
		.data-table { display: block; }
		.data-table thead { display: none; }
		.data-table tbody {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
			gap: 12px;
		}
		.data-table tr {
			display: block; position: relative;
			border: 1px solid var(--border); border-radius: var(--radius-s);
			background: var(--card, var(--secondary)); padding: 12px 14px;
		}
		.data-table td {
			display: flex; align-items: center; justify-content: space-between; gap: 12px;
			width: auto; padding: 6px 0; border: none; text-align: right;
		}
		.data-table td + td { border-top: 1px solid var(--border); }
		.data-table td::before {
			content: attr(data-label);
			font: 600 11px var(--font-secondary);
			color: var(--muted-foreground);
			text-transform: uppercase;
			letter-spacing: 0.04em;
			flex-shrink: 0;
			text-align: left;
		}
		.data-table th[scope='row'] { display: block; padding: 0 36px 6px 0; border: none; }
		.data-table th[scope='row'] + td { border-top: 1px solid var(--border); }
		.data-table td.col-actions {
			position: absolute; top: 6px; right: 6px; width: auto; padding: 0; border: none;
		}
		.data-table td.col-actions::before { display: none; }
		.data-table td.col-actions .icon-btn { padding: 8px; }
		.data-table td.gallery-none { display: none; }
		.data-table .artist-cell { text-align: right; }
	}
</style>
