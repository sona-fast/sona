<script lang="ts">
	import type { PageData } from './$types';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { CircleCheck, ClipboardList, Eye, ImagePlus, Loader2, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import ArtistAvatar from '$lib/components/ArtistAvatar.svelte';
	import CommissionIntro from '$lib/components/CommissionIntro.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import LiveAnnouncer from '$lib/components/LiveAnnouncer.svelte';
	import PieceThumb from '$lib/components/PieceThumb.svelte';
	import { Announcer } from '$lib/live-announcer.svelte';
	import { toast } from '$lib/toast.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { isActiveStatus, PAYMENT_LABELS, STATUS_LABELS, STATUS_TONES } from '$lib/commissions';
	import * as m from '$lib/paraglide/messages';

	// Read from `page`, not the `data` prop: a Back press that interrupts a
	// navigation between two ledger pages can leave the prop holding the other
	// page's data for good (sveltejs/kit#13276), while `page.data` is this page's.
	const data = $derived(page.data as PageData);

	// "Added to your gallery" after an upload from an entry. The server built it
	// from the saved rows; the piece's title is the link inside the sentence,
	// and each language puts it where its word order wants it.
	const added = $derived.by(() => {
		const notice = data.added;
		if (!notice) return null;
		const [pre, post] =
			notice.kind === 'piece'
				? notice.published
					? [m.admin_commissions_added_piece_pre(), m.admin_commissions_added_piece_post()]
					: [m.admin_commissions_added_piece_private_pre(), m.admin_commissions_added_piece_private_post()]
				: [
						notice.published
							? m.admin_commissions_added_variants_pre({ count: notice.count })
							: m.admin_commissions_added_variants_private_pre({ count: notice.count }),
						m.admin_commissions_added_variants_post()
					];
		const title = notice.kind === 'piece' ? notice.title : notice.pieceTitle;
		const pieceId = notice.kind === 'piece' ? notice.imageId : notice.pieceId;
		return { pre, post, title, href: `/admin/images/${pieceId}/edit` };
	});

	// This page's live region reads the notice out once the page arrives.
	// untrack: say() reads and bumps the announcer's counter, and an effect that
	// tracked it would rerun on its own write.
	const announcer = new Announcer();
	$effect(() => {
		const notice = added;
		if (notice) untrack(() => announcer.say(`${notice.pre}${notice.title}${notice.post}`));
	});

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

	// A row's Delete asks with the entry page's own words. Without the page's
	// script it opens that page's in-page confirmation instead.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	let deleteTarget = $state<Entry | null>(null);
	let deletingId = $state<number | null>(null);
	let deletingTitle = '';
	// Where focus goes once the row is gone: the next row's link, else the
	// previous row's, else the page heading.
	let focusAfterDelete: number | null = null;
	let deleteForm = $state<HTMLFormElement>();
	let heading = $state<HTMLHeadingElement>();

	function deleteMessage(entry: Entry): string {
		return entry.piece
			? m.admin_commissions_delete_message_linked({ title: entry.title, piece: entry.piece.title, artist: entry.artistName })
			: m.admin_commissions_delete_message({ title: entry.title, artist: entry.artistName });
	}

	const enhanceDelete: SubmitFunction = ({ formData }) => {
		// The id travels with this submit, not in a field the next row could change.
		formData.set('id', String(deletingId));
		return async ({ update, result }) => {
			const id = deletingId;
			// An error result would swap the list for the error page, so it stays with a toast.
			if (result.type !== 'error') await update();
			deletingId = null;
			const missing = result.type === 'failure' && (result.data as { missing?: boolean } | undefined)?.missing;
			if (result.type === 'success' || missing) {
				// Already deleted somewhere else: the delete is done either way.
				if (missing) await invalidateAll();
				else toast.success(m.admin_commissions_deleted({ title: deletingTitle }));
				await tick();
				const next = document.querySelector<HTMLElement>(`a[href="/admin/commissions/${focusAfterDelete}/edit"]`);
				(next ?? heading)?.focus();
				return;
			}
			toast.error(result.type === 'failure' ? m.admin_commissions_delete_failed() : m.admin_something_wrong());
			// The row stays: give focus back to its Delete, enabled again.
			await tick();
			document.querySelector<HTMLElement>(`button[data-delete-id="${id}"]`)?.focus();
		};
	};
</script>

<div class="page-header">
	<h1 tabindex="-1" bind:this={heading}>
		{m.admin_nav_commissions()}
		{#if data.entries.length > 0}<span class="count">{m.admin_commissions_count({ count: data.entries.length })}</span>{/if}
	</h1>
	{#if data.gate.open}
		<div class="header-actions">
			<a href="/admin/commissions/new" class="btn btn-primary"><Plus size={16} aria-hidden="true" /> {m.admin_commissions_new()}</a>
		</div>
	{/if}
</div>

<LiveAnnouncer {announcer} />
{#if added}
	<div class="notice ok">
		<span class="ok-mark"><CircleCheck size={16} aria-hidden="true" /></span>
		<p>
			{added.pre}<a href={added.href}>{added.title}</a>{added.post}
		</p>
	</div>
{/if}

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
												<PieceThumb src={entry.piece.thumb} />
												<a href="/admin/images/{entry.piece.id}/edit">{entry.piece.title}</a>
											</div>
										</td>
									{:else if entry.status === 'delivered'}
										<td data-label={m.admin_commissions_col_gallery()}>
											<div class="not-linked">
												<span class="muted">{m.admin_commissions_not_in_gallery()}</span>
												{#if data.gate.open}
													<!-- Named for its entry: every delivered row has one. -->
													<a
														class="btn-compact"
														href="/admin/upload?commission={entry.id}"
														aria-label={m.admin_commissions_add_to_gallery_aria({ title: entry.title })}
														><ImagePlus size={14} aria-hidden="true" /> {m.admin_commissions_add_to_gallery()}</a
													>
												{/if}
											</div>
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
										{#if hydrated}
											<button
												type="button"
												class="icon-btn"
												aria-label={m.admin_commissions_delete_aria({ title: entry.title })}
												data-delete-id={entry.id}
												disabled={deletingId !== null}
												onclick={() => (deleteTarget = entry)}
											>
												{#if deletingId === entry.id}<Loader2 size={16} class="tag-spin" aria-hidden="true" />{:else}<Trash2 size={16} aria-hidden="true" />{/if}
											</button>
										{:else}
											<a
												href="/admin/commissions/{entry.id}/edit?delete=confirm#delete-confirm"
												class="icon-btn"
												aria-label={m.admin_commissions_delete_aria({ title: entry.title })}
											>
												<Trash2 size={16} aria-hidden="true" />
											</a>
										{/if}
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

<!-- Never gated: an owner can always remove their own private data. -->
<form method="POST" action="?/delete" bind:this={deleteForm} hidden use:enhance={enhanceDelete}></form>

{#if deleteTarget}
	<ConfirmDialog
		title={m.admin_commissions_delete_title()}
		message={deleteMessage(deleteTarget)}
		onconfirm={() => {
			deletingId = deleteTarget!.id;
			deletingTitle = deleteTarget!.title;
			const order = groups.flatMap((g) => g.rows.map((r) => r.id));
			const at = order.indexOf(deletingId);
			focusAfterDelete = order[at + 1] ?? order[at - 1] ?? null;
			deleteTarget = null;
			deleteForm?.requestSubmit();
		}}
		oncancel={() => (deleteTarget = null)}
	/>
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
	/* The entry title in the body face and full foreground, not the header row's
	   smaller monospace label style, so it reads first in its row. */
	.ledger-table th[scope='row'] {
		font-weight: 400; text-align: left;
		font-family: var(--font-secondary); color: var(--foreground); white-space: normal;
	}
	.ledger-table td { vertical-align: middle; }
	.col-chars { width: 7rem; }
	.col-status, .col-pay { width: 6.5rem; }
	/* Room for the 40px thumbnail and a short title on one line beside it. */
	.col-gallery { width: 11rem; }
	/* Two icon buttons: Edit (or View) and Delete. */
	.col-actions { width: 80px; white-space: nowrap; }

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

	.not-linked { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }

	.notice {
		display: flex; align-items: center; gap: 12px; max-width: 720px;
		background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-s);
		padding: 12px 16px; margin-bottom: 20px;
	}
	/* The notice quotes an owner-typed title, so a long word breaks inside it. */
	.notice p { font-size: 13px; line-height: 1.55; margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
	.notice a { color: var(--foreground); text-decoration: underline; }
	.ok-mark { color: var(--status-ok); display: inline-flex; }

	.icon-btn {
		background: none; border: none; color: var(--muted-foreground); cursor: pointer;
		padding: 4px; border-radius: var(--radius-xs); display: inline-flex; transition: color 0.15s;
	}
	.icon-btn:hover { color: var(--foreground); }

	/* Cards when the section is narrower than the seven columns need, which is
	   760px in the mocks. In a card, the row header leaves room on its right for
	   the row's two buttons, which sit in the top-right corner. */
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
		.data-table th[scope='row'] { display: block; padding: 0 72px 6px 0; border: none; }
		.data-table th[scope='row'] + td { border-top: 1px solid var(--border); }
		.data-table td.col-actions {
			position: absolute; top: 6px; right: 6px; width: auto; padding: 0; border: none;
		}
		.data-table td.col-actions::before { display: none; }
		.data-table td.col-actions .icon-btn { padding: 8px; }
		.data-table td.gallery-none { display: none; }
		.data-table .artist-cell { text-align: right; }
		.not-linked { align-items: flex-end; }
	}
</style>
