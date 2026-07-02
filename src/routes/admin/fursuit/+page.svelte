<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { Camera, ShieldCheck, Search, Loader2, CheckCircle2, AlertTriangle, ImageOff, Trash2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let character = $state(data.character);
	let selected = $state<Set<number>>(new Set());
	let importing = $state(false);
	let checking = $state(false);
	let deletingId = $state<number | null>(null);
	// One photo at a time — captures the row the admin clicked Delete on so the
	// ConfirmDialog can name it specifically before the hidden form is submitted.
	let deleteTarget = $state<(typeof data.imported)[number] | null>(null);
	let deleteForm: HTMLFormElement;
	// Per-postId source string when the admin records direct permission for an
	// otherwise-excluded photo (e.g. "Telegram DM 2026-05-30"). Empty source = no
	// grant; the import checkbox stays disabled until something is typed.
	let permissions = $state<Record<number, string>>({});

	const newCandidates = $derived(data.candidates.filter((c) => c.status === 'new'));
	// Everything the "Select all eligible" button should pick up: brand-new
	// candidates AND excluded ones the admin has typed a permission source for
	// (which makes them importable via the override). Re-derives when typing.
	const bulkEligible = $derived(
		data.candidates.filter(
			(c) =>
				c.status === 'new' ||
				(c.status === 'excluded' && (permissions[c.id] ?? '').trim() !== '')
		)
	);
	const counts = $derived({
		new: data.candidates.filter((c) => c.status === 'new').length,
		imported: data.candidates.filter((c) => c.status === 'imported').length,
		excluded: data.candidates.filter((c) => c.status === 'excluded').length
	});

	async function check() {
		if (checking) return;
		// The ?check navigation re-runs the load (which queries FurTrack server-side);
		// goto resolves once the new data is in, so show the loading state until then.
		checking = true;
		await goto(`/admin/fursuit?character=${encodeURIComponent(character)}&check=1`);
		checking = false;
	}

	function toggle(id: number, on: boolean) {
		if (on) selected.add(id);
		else selected.delete(id);
		selected = new Set(selected);
	}

	function selectAllEligible(on: boolean) {
		selected = on ? new Set(bulkEligible.map((c) => c.id)) : new Set();
	}

	const statusLabel = { new: m.admin_fursuit_status_new, imported: m.admin_fursuit_status_imported, excluded: m.admin_fursuit_status_excluded };
</script>

<div class="page-header"><h1>{m.admin_fursuit_title()}</h1></div>
<p class="intro">{m.admin_fursuit_intro()}</p>

{#if form?.deleted}
	<div class="banner ok"><CheckCircle2 size={18} /> {m.admin_fursuit_photo_deleted()}</div>
{/if}

{#if !data.enabled}
	<div class="banner warn">
		<AlertTriangle size={18} /> {m.admin_fursuit_disabled_pre()}<code>FURTRACK_MODE</code>{m.admin_fursuit_disabled_mid1()}<code>mock</code>{m.admin_fursuit_disabled_mid2()}<code>live</code>{m.admin_fursuit_disabled_post()}
	</div>
{:else if form?.success}
	{@const r = form.result}
	<div class="banner ok"><CheckCircle2 size={18} /> {m.admin_fursuit_import_summary({ count: r.imported })}{r.skipped ? m.admin_fursuit_import_skipped({ count: r.skipped }) : ''}{r.failed ? m.admin_fursuit_import_failed({ count: r.failed }) : ''}</div>
	<div class="actions">
		<a class="btn btn-primary" href="/gallery?view=fursuit">{m.admin_fursuit_view_gallery()} →</a>
		<button class="btn btn-outline" onclick={check} disabled={checking}>
			{#if checking}<Loader2 size={16} class="spin" /> {m.admin_checking()}{:else}{m.admin_fursuit_check_again()}{/if}
		</button>
	</div>
{:else}
	<div class="controls">
		<div class="tag-field">
			<label for="tag">{m.admin_fursuit_tag_label()}</label>
			<input
				id="tag"
				class="input"
				list="char-suggestions"
				bind:value={character}
				placeholder={m.admin_fursuit_tag_placeholder()}
				onkeydown={(e) => { if (e.key === 'Enter') check(); }}
			/>
			<datalist id="char-suggestions">
				{#each data.characters as c}<option value={c.name}></option>{/each}
			</datalist>
		</div>
		<button class="btn btn-primary" onclick={check} disabled={checking}>
			{#if checking}<Loader2 size={16} class="spin" /> {m.admin_checking()}{:else}<Search size={16} /> {m.admin_fursuit_check()}{/if}
		</button>
	</div>
	<p class="hint">{m.admin_fursuit_tag_hint_pre()}<code>1:</code>{m.admin_fursuit_tag_hint_mid()}<code>1:{character || '…'}</code></p>

	<div class="banner info">
		{m.admin_fursuit_license_info()}
	</div>

	{#if data.reachError}
		<div class="banner err"><AlertTriangle size={18} /> {m.admin_fursuit_reach_error()}</div>
	{:else if !data.checked}
		<div class="empty"><Camera size={36} /><p>{m.admin_fursuit_pick_prompt()}</p></div>
	{:else if data.candidates.length === 0}
		<div class="empty"><ImageOff size={36} /><p>{m.admin_fursuit_none_found({ character: data.character })}</p></div>
	{:else}
		<div class="summary">{m.admin_fursuit_summary({ newCount: counts.new, imported: counts.imported, excluded: counts.excluded })}</div>
		{#if data.capped}<p class="muted">{m.admin_fursuit_capped()}</p>{/if}

		<form method="POST" action="?/import" use:enhance={() => {
			importing = true;
			return async ({ update }) => { await update(); importing = false; selected = new Set(); permissions = {}; };
		}}>
			<input type="hidden" name="character" value={data.character} />

			<div class="toolbar">
				<label class="select-all">
					<input type="checkbox" onchange={(e) => selectAllEligible(e.currentTarget.checked)} disabled={bulkEligible.length === 0} />
					{m.admin_fursuit_select_all({ count: bulkEligible.length })}
				</label>
				<button type="submit" class="btn btn-primary" disabled={selected.size === 0 || importing}>
					{importing ? m.admin_fursuit_importing() : m.admin_fursuit_import_selected({ count: selected.size })}
				</button>
			</div>

			<div class="rows">
				{#each data.candidates as photo}
					{@const src = (permissions[photo.id] ?? '').trim()}
					<div class="row" class:excluded={photo.status === 'excluded' && !src} class:imported={photo.status === 'imported'}>
						<div class="cell check">
							{#if photo.status === 'new'}
								<input type="checkbox" name="postId" value={photo.id} checked={selected.has(photo.id)} onchange={(e) => toggle(photo.id, e.currentTarget.checked)} />
							{:else if photo.status === 'excluded'}
								<input type="checkbox" name="postId" value={photo.id} disabled={!src} checked={selected.has(photo.id)} onchange={(e) => toggle(photo.id, e.currentTarget.checked)} />
							{/if}
						</div>
						<div class="cell thumb"><img src={photo.imageUrl} alt={m.fursuit_card_by({ photographer: photo.photographer })} loading="lazy" /></div>
						<div class="cell who"><Camera size={13} /> {photo.photographer}</div>
						<div class="cell ev">{photo.event ?? '—'}</div>
						<div class="cell lic" title={photo.license.terms}><ShieldCheck size={12} /> {photo.license.label}</div>
						<div class="cell st">
							<span class="status {photo.status}">{statusLabel[photo.status]()}</span>
							{#if photo.status === 'excluded'}<span class="reason">{src ? m.admin_fursuit_reason_manual() : m.admin_fursuit_reason_license()}</span>{/if}
						</div>
						<div class="cell link"><a href={photo.furtrackUrl} target="_blank" rel="noopener">FurTrack ↗</a></div>
					</div>
					{#if photo.status === 'excluded'}
						<div class="grant-row">
							<input type="text" class="input perm-source"
								bind:value={permissions[photo.id]}
								placeholder={m.admin_fursuit_permission_placeholder()}
								aria-label={m.admin_fursuit_permission_aria({ photographer: photo.photographer })} />
							{#if selected.has(photo.id) && src}
								<input type="hidden" name="permission[{photo.id}]" value={src} />
							{/if}
						</div>
					{/if}
				{/each}
			</div>
		</form>
	{/if}
{/if}

{#if form?.error}<p class="error">{form.error}</p>{/if}

{#if data.imported.length > 0}
	<section class="manage">
		<div class="manage-header">
			<h2>{m.admin_fursuit_imported_heading({ count: data.imported.length })}</h2>
			<p class="manage-sub">{m.admin_fursuit_manage_sub()}</p>
		</div>
		<div class="imp-rows">
			{#each data.imported as photo}
				<div class="imp-row">
					<div class="cell thumb"><img src={photo.imageUrl} alt={m.fursuit_card_by({ photographer: photo.photographer })} loading="lazy" /></div>
					<div class="cell who"><Camera size={13} /> {photo.photographer}</div>
					<div class="cell ev">{photo.event ?? '—'}</div>
					<div class="cell lic" title={photo.license.terms}><ShieldCheck size={12} /> {photo.license.label}</div>
					<div class="cell perm">
						{#if photo.permissionSource}
							<span class="badge perm" title={photo.permissionSource}><ShieldCheck size={11} /> {m.admin_fursuit_reason_manual()}</span>
						{/if}
					</div>
					<div class="cell link"><a href="/gallery/fursuit/{photo.id}" target="_blank" rel="noopener">{m.admin_view()} ↗</a></div>
					<div class="cell del">
						<button type="button" class="btn-icon" aria-label={m.admin_fursuit_delete_aria({ photographer: photo.photographer })} disabled={deletingId === photo.id} onclick={() => (deleteTarget = photo)}>
							{#if deletingId === photo.id}<Loader2 size={16} class="spin" />{:else}<Trash2 size={16} />{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	</section>
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
		title={m.admin_fursuit_delete_title()}
		message={(deleteTarget.event ? m.admin_fursuit_delete_q_event({ photographer: deleteTarget.photographer, event: deleteTarget.event }) : m.admin_fursuit_delete_q({ photographer: deleteTarget.photographer })) + ' ' + (deleteTarget.permissionSource ? m.admin_fursuit_delete_perm_both() : m.admin_fursuit_delete_file_only())}
		onconfirm={() => { deletingId = deleteTarget!.id; deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

<style>
	.page-header h1 { font-size: 24px; }
	.intro { font-size: 13px; color: var(--muted-foreground); max-width: 70ch; margin-bottom: 20px; }
	.controls { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
	.tag-field { display: flex; flex-direction: column; gap: 4px; }
	.tag-field label { font-size: 12px; color: var(--muted-foreground); }
	.tag-field .input { min-width: 280px; }
	.hint { font-size: 11px; color: var(--muted-foreground); margin: -8px 0 16px; }
	.banner { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-s); font-size: 13px; margin-bottom: 16px; }
	.banner.info { background: var(--secondary); color: var(--muted-foreground); }
	.banner.ok { background: rgba(74,222,128,0.1); color: #4ade80; }
	.banner.warn { background: rgba(245,166,35,0.1); color: #f5a623; }
	.banner.err { background: rgba(248,113,113,0.12); color: #f87171; }
	.summary { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
	.muted { font-size: 12px; color: var(--muted-foreground); margin-bottom: 12px; }
	.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; flex-wrap: wrap; }
	.select-all { display: flex; align-items: center; gap: 8px; font-size: 13px; }
	.rows { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-s); overflow: hidden; }
	.row { display: grid; grid-template-columns: 36px 56px 1.5fr 1fr 1.2fr 1.3fr 80px; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
	.row:last-child { border-bottom: none; }
	.row.excluded { opacity: 0.55; }
	.row.imported { opacity: 0.75; }
	.cell.thumb img { width: 44px; height: 44px; object-fit: contain; background: var(--secondary); border-radius: var(--radius-xs); }
	.cell.who { display: flex; align-items: center; gap: 5px; font-weight: 500; }
	.cell.lic { display: inline-flex; align-items: center; gap: 4px; color: var(--muted-foreground); cursor: help; }
	.status { font-size: 11px; padding: 2px 7px; border-radius: var(--radius-pill); }
	.status.new { background: var(--primary, #f5a623); color: var(--background, #000); }
	.status.imported { color: var(--muted-foreground); }
	.status.excluded { color: #f87171; }
	.reason { font-size: 10px; color: #f87171; margin-left: 4px; }
	.grant-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 12px 10px;
		border-bottom: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.12);
	}
	.grant-row .input { flex: 1; font-size: 12px; padding: 6px 10px; }
	.manage { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--border); }
	.manage-header h2 { font-size: 18px; margin: 0 0 4px; }
	.manage-sub { font-size: 12px; color: var(--muted-foreground); margin: 0 0 16px; max-width: 70ch; }
	.imp-rows { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-s); overflow: hidden; }
	.imp-row { display: grid; grid-template-columns: 56px 1.5fr 1fr 1.2fr 1.5fr 60px 40px; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
	.imp-row:last-child { border-bottom: none; }
	.imp-row .cell.thumb img { width: 44px; height: 44px; object-fit: contain; background: var(--secondary); border-radius: var(--radius-xs); }
	.imp-row .cell.who { display: flex; align-items: center; gap: 5px; font-weight: 500; }
	.imp-row .cell.lic { display: inline-flex; align-items: center; gap: 4px; color: var(--muted-foreground); cursor: help; }
	.badge.perm { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border: 1px solid var(--primary); border-radius: var(--radius-s); color: var(--primary); font-size: 11px; cursor: help; }
	.imp-row .cell.link a { color: var(--primary); font-size: 12px; }
	.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-s); background: transparent; color: var(--muted-foreground); cursor: pointer; transition: color 0.15s, border-color 0.15s; }
	.btn-icon:hover { color: #f87171; border-color: #f87171; }
	.cell.link a { color: var(--primary); font-size: 12px; }
	.actions { display: flex; gap: 12px; margin: 16px 0; }
	.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px; color: var(--muted-foreground); text-align: center; }
	.error { color: #f87171; font-size: 14px; margin-top: 12px; }
	code { background: var(--secondary); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
