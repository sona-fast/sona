<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { Camera, ShieldCheck, Search, Loader2, CheckCircle2, AlertTriangle, ImageOff, Trash2 } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

	let { data, form } = $props();

	let character = $state(data.character);
	let selected = $state<Set<number>>(new Set());
	let importing = $state(false);
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

	function check() {
		goto(`/admin/fursuit?character=${encodeURIComponent(character)}&check=1`);
	}

	function toggle(id: number, on: boolean) {
		if (on) selected.add(id);
		else selected.delete(id);
		selected = new Set(selected);
	}

	function selectAllEligible(on: boolean) {
		selected = on ? new Set(bulkEligible.map((c) => c.id)) : new Set();
	}

	const statusLabel = { new: 'New', imported: 'Already imported', excluded: 'Excluded' };
</script>

<div class="page-header"><h1>Import from FurTrack</h1></div>
<p class="intro">Pull fursuit photos of your character from FurTrack into your gallery. Only photos with a Creative Commons or Public Domain license can be imported; they're downloaded and self-hosted.</p>

{#if form?.deleted}
	<div class="banner ok"><CheckCircle2 size={18} /> Photo deleted.</div>
{/if}

{#if !data.enabled}
	<div class="banner warn">
		<AlertTriangle size={18} /> FurTrack import is turned off. Set <code>FURTRACK_MODE</code> to
		<code>mock</code> (dev) or <code>live</code> (after FurTrack approves API access) to enable it.
	</div>
{:else if form?.success}
	{@const r = form.result}
	<div class="banner ok"><CheckCircle2 size={18} /> Imported {r.imported} photo{r.imported === 1 ? '' : 's'}{r.skipped ? ` · ${r.skipped} already imported` : ''}{r.failed ? ` · ${r.failed} failed` : ''}.</div>
	<div class="actions">
		<a class="btn btn-primary" href="/gallery?view=fursuit">View in gallery →</a>
		<button class="btn btn-outline" onclick={check}>Check FurTrack again</button>
	</div>
{:else}
	<div class="controls">
		<div class="tag-field">
			<label for="tag">FurTrack character tag</label>
			<input
				id="tag"
				class="input"
				list="char-suggestions"
				bind:value={character}
				placeholder="e.g. aspen_(zangoose)"
				onkeydown={(e) => { if (e.key === 'Enter') check(); }}
			/>
			<datalist id="char-suggestions">
				{#each data.characters as c}<option value={c.name}></option>{/each}
			</datalist>
		</div>
		<button class="btn btn-primary" onclick={check}><Search size={16} /> Check FurTrack for new photos</button>
	</div>
	<p class="hint">The tag as it appears on FurTrack (the part after <code>1:</code>). Queries <code>1:{character || '…'}</code>.</p>

	<div class="banner info">
		Only Creative Commons (CC-BY, CC-BY-NC, CC-BY-ND, CC-BY-NC-ND) or Public Domain photos are imported.
		All Rights Reserved or unspecified photos are excluded automatically — protecting you and the photographers.
	</div>

	{#if data.reachError}
		<div class="banner err"><AlertTriangle size={18} /> Couldn't reach FurTrack. Try again in a moment.</div>
	{:else if !data.checked}
		<div class="empty"><Camera size={36} /><p>Pick a character and check FurTrack to see importable photos.</p></div>
	{:else if data.candidates.length === 0}
		<div class="empty"><ImageOff size={36} /><p>No photos found on FurTrack for "{data.character}".</p></div>
	{:else}
		<div class="summary">{counts.new} new · {counts.imported} already imported · {counts.excluded} excluded (license)</div>
		{#if data.capped}<p class="muted">Showing the most recent photos — older ones aren't loaded.</p>{/if}

		<form method="POST" action="?/import" use:enhance={() => {
			importing = true;
			return async ({ update }) => { await update(); importing = false; selected = new Set(); permissions = {}; };
		}}>
			<input type="hidden" name="character" value={data.character} />

			<div class="toolbar">
				<label class="select-all">
					<input type="checkbox" onchange={(e) => selectAllEligible(e.currentTarget.checked)} disabled={bulkEligible.length === 0} />
					Select all eligible ({bulkEligible.length})
				</label>
				<button type="submit" class="btn btn-primary" disabled={selected.size === 0 || importing}>
					{importing ? 'Importing…' : `Import ${selected.size} selected`}
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
						<div class="cell thumb"><img src={photo.imageUrl} alt="by {photo.photographer}" loading="lazy" /></div>
						<div class="cell who"><Camera size={13} /> {photo.photographer}</div>
						<div class="cell ev">{photo.event ?? '—'}</div>
						<div class="cell lic" title={photo.license.terms}><ShieldCheck size={12} /> {photo.license.label}</div>
						<div class="cell st">
							<span class="status {photo.status}">{statusLabel[photo.status]}</span>
							{#if photo.status === 'excluded'}<span class="reason">{src ? 'manual permission' : 'license'}</span>{/if}
						</div>
						<div class="cell link"><a href={photo.furtrackUrl} target="_blank" rel="noopener">FurTrack ↗</a></div>
					</div>
					{#if photo.status === 'excluded'}
						<div class="grant-row">
							<input type="text" class="input perm-source"
								bind:value={permissions[photo.id]}
								placeholder="Permission source (e.g. Telegram DM 2026-05-30) — required to import this photo"
								aria-label="Permission source for {photo.photographer}" />
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
			<h2>Imported photos ({data.imported.length})</h2>
			<p class="manage-sub">Delete a photo to remove it from the gallery, the stored file, and (if any) the recorded manual permission. Re-importing the same FurTrack post will work fresh.</p>
		</div>
		<div class="imp-rows">
			{#each data.imported as photo}
				<div class="imp-row">
					<div class="cell thumb"><img src={photo.imageUrl} alt="by {photo.photographer}" loading="lazy" /></div>
					<div class="cell who"><Camera size={13} /> {photo.photographer}</div>
					<div class="cell ev">{photo.event ?? '—'}</div>
					<div class="cell lic" title={photo.license.terms}><ShieldCheck size={12} /> {photo.license.label}</div>
					<div class="cell perm">
						{#if photo.permissionSource}
							<span class="badge perm" title={photo.permissionSource}><ShieldCheck size={11} /> manual permission</span>
						{/if}
					</div>
					<div class="cell link"><a href="/gallery/fursuit/{photo.id}" target="_blank" rel="noopener">View ↗</a></div>
					<div class="cell del">
						<button type="button" class="btn-icon" aria-label="Delete photo by {photo.photographer}" onclick={() => (deleteTarget = photo)}>
							<Trash2 size={16} />
						</button>
					</div>
				</div>
			{/each}
		</div>
	</section>
{/if}

<form method="POST" action="?/delete" use:enhance bind:this={deleteForm} style="display:none">
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete fursuit photo"
		message={`Delete the photo by ${deleteTarget.photographer}${deleteTarget.event ? ` at ${deleteTarget.event}` : ''}? The stored file${deleteTarget.permissionSource ? ' and the recorded permission grant will both' : ' will'} be removed. This can't be undone.`}
		onconfirm={() => { deleteForm.requestSubmit(); deleteTarget = null; }}
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
</style>
