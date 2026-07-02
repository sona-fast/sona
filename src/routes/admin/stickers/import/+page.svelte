<script lang="ts">
	import { goto } from '$app/navigation';
	import { deserialize } from '$app/forms';
	import { untrack } from 'svelte';
	import { toast } from '$lib/toast.svelte';
	import { Smile, Loader2, CheckCircle2, AlertTriangle, Film, ArrowLeft, ArrowRight, Download, RefreshCw, Check, Plus, UserPlus, Info, Shield, Palette } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	const ownerName = $derived(data.ownerName || data.siteName || m.admin_stickers_site_owner());

	let packInput = $state(data.nameOrUrl);
	let managerArtistId = $state<number | ''>(''); // '' = "myself" (the site owner)
	// Reactive artist pool, seeded from the server. Artists created inline are
	// appended here so they instantly appear in every dropdown.
	let artists = $state([...data.artists]);
	let defaultArtistId = $state<string>('');
	let importing = $state(false);
	let checking = $state(false);
	let showConfirm = $state(false);

	// Progress across the batched import loop (done / total eligible stickers).
	let progress = $state({ done: 0, total: 0 });

	// Final (or partial, if a batch hard-failed mid-loop) import result. Replaces the
	// old server-action `form.result` — the import now runs as a client-driven batch
	// loop, so the success UI reads this local state instead.
	type FailedItem = { status: 'failed'; fileId: string; emoji: string | null; index: number; error: string };
	type ClientImportResult = { imported: number; updated: number; skipped: number; failed: number; items: FailedItem[] };
	let result = $state<ClientImportResult | null>(null);

	// Batches are bounded so each request finishes well under Cloudflare's ~100s
	// edge/request timeout. A production 100+ pack imported one-shot was TERMINATED
	// mid-loop (~65 sequential getFile + download + R2 put ≈ 100s). 20 sequential
	// downloads+stores per request leaves comfortable headroom; kept conservative
	// because animated (.tgs) stickers add gunzip+sanitize CPU on top of the I/O.
	const BATCH_SIZE = 20;

	// New-artist modal. `newArtistTarget` = where to apply the created artist:
	// 'default' (pack-wide default), a number (that sticker index), or 'pool' (just
	// add it to the dropdowns from the review "+ New artist").
	let showNewArtist = $state(false);
	let newArtistTarget = $state<'default' | 'pool' | 'bulk' | number>('pool');

	function openNewArtist(target: 'default' | 'pool' | 'bulk' | number) {
		newArtistTarget = target;
		showNewArtist = true;
	}
	function onArtistCreated(artist: { id: number; name: string }) {
		artists = [...artists, artist].sort((a, b) => a.name.localeCompare(b.name));
		const id = String(artist.id);
		if (newArtistTarget === 'default') defaultArtistId = id;
		else if (newArtistTarget === 'bulk') applyArtistToSelected(id);
		else if (typeof newArtistTarget === 'number' && perSticker[newArtistTarget]) perSticker[newArtistTarget].artistId = id;
		showNewArtist = false;
	}

	// Per-sticker state: excluded, nsfw, artistId override, emoji edit.
	type PerSticker = { excluded: boolean; nsfw: boolean; artistId: string; emojis: string };

	function buildPerSticker(candidates: typeof data.candidates, seedArtist: string): Record<number, PerSticker> {
		const m: Record<number, PerSticker> = {};
		for (const c of candidates) {
			if (c.existing) {
				// Already in this pack: seed from its CURRENT stored metadata so the grid
				// shows real state and stays editable (re-sync updates it in place). Not
				// excluded — "exclude" is only for new stickers the admin skips.
				m[c.index] = {
					excluded: false,
					nsfw: c.existing.nsfw,
					artistId: c.existing.artistId != null ? String(c.existing.artistId) : '',
					emojis: c.existing.emojis.join(', ')
				};
			} else {
				m[c.index] = { excluded: false, nsfw: false, artistId: seedArtist, emojis: c.emoji ?? '' };
			}
		}
		return m;
	}

	// Initialize SYNCHRONOUSLY (not in an $effect) so the review grid has its
	// per-sticker entries during SSR. Each sticker is pre-seeded to the pack default.
	// Re-seed only when a NEW pack is fetched (candidates change) — untrack
	// defaultArtistId so changing/overriding artists later doesn't wipe picks.
	let perSticker = $state<Record<number, PerSticker>>(buildPerSticker(data.candidates, defaultArtistId));
	$effect(() => {
		data.candidates;
		perSticker = buildPerSticker(data.candidates, untrack(() => defaultArtistId));
		// A fresh fetch (e.g. "Retry failed" re-check) clears the prior run's summary so
		// the review grid shows again instead of the now-stale result.
		result = null;
	});

	// Surface fetch/import failures as toasts. Guard against re-firing on unrelated
	// reactive updates by only toasting when the value transitions into an error.
	let lastReachError = false;
	$effect(() => {
		if (data.reachError && !lastReachError) toast.error(m.admin_import_reach_toast());
		lastReachError = data.reachError;
	});
	let lastFormError: string | undefined;
	$effect(() => {
		const err = form?.error;
		if (err && err !== lastFormError) toast.error(err);
		lastFormError = err;
	});

	async function check() {
		if (!packInput.trim() || checking) return;
		// Show the loading state on the button while the ?check navigation re-runs the
		// load (which hits the Telegram Bot API server-side). goto resolves once the
		// new data is in, so we clear it after.
		checking = true;
		await goto(`/admin/stickers/import?pack=${encodeURIComponent(packInput.trim())}&check=1`);
		checking = false;
	}

	const eligibleCount = $derived(
		data.candidates.filter((c) => !perSticker[c.index]?.excluded).length
	);
	const nsfwCount = $derived(
		data.candidates.filter((c) => !perSticker[c.index]?.excluded && perSticker[c.index]?.nsfw).length
	);
	const artistsCount = $derived(
		new Set(
			data.candidates
				.filter((c) => !perSticker[c.index]?.excluded)
				.map((c) => perSticker[c.index]?.artistId || 'none')
		).size
	);
	// Eligible stickers with no artist chosen — imported as "unattributed" (allowed;
	// assign later in the pack editor). Surfaced as a note, not a blocker.
	const unattributedCount = $derived(
		data.candidates.filter((c) => !perSticker[c.index]?.excluded && !perSticker[c.index]?.artistId).length
	);

	const managerName = $derived(artists.find((a) => a.id === managerArtistId)?.name ?? '');
	const defaultArtistDisplay = $derived(artists.find((a) => String(a.id) === defaultArtistId)?.name ?? '');

	// Re-sync framing: when the checked pack already has imported stickers, this is a
	// top-up of an existing pack, not a fresh import. Drives the header/labels + counts.
	const alreadyCount = $derived(data.candidates.filter((c) => c.alreadyImported).length);
	const newCount = $derived(data.candidates.length - alreadyCount);
	const isResync = $derived(alreadyCount > 0);

	const showReview = $derived(
		data.telegramEnabled && data.checked && !data.reachError && data.candidates.length > 0 && !result
	);

	// --- Bulk selection: label many stickers at once (a 100-pack is painful 1-by-1).
	// Click a sticker to highlight it, shift-click for a range, then bulk-assign an
	// artist / exclude / mark NSFW for the whole selection.
	let selected = $state<Set<number>>(new Set());
	let lastClicked = $state<number | null>(null);
	let bulkArtist = $state('');
	const orderedIndexes = $derived(data.candidates.map((c) => c.index));

	function toggleSelect(index: number, ev: MouseEvent | KeyboardEvent) {
		const next = new Set(selected);
		if (ev.shiftKey && lastClicked !== null) {
			const a = orderedIndexes.indexOf(lastClicked);
			const b = orderedIndexes.indexOf(index);
			if (a !== -1 && b !== -1) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				for (let i = lo; i <= hi; i++) next.add(orderedIndexes[i]);
			}
		} else {
			if (next.has(index)) next.delete(index);
			else next.add(index);
			lastClicked = index;
		}
		selected = next;
	}
	function selectAll() {
		selected = new Set(orderedIndexes);
	}
	function clearSelection() {
		selected = new Set();
		lastClicked = null;
	}
	// Sets the artist for the whole selection. Pass '' to clear back to unattributed
	// (the bulk "Unassign" button does this); the "Apply" button is disabled when no
	// artist is picked, so it never reaches here with an empty id.
	function applyArtistToSelected(id: string) {
		for (const i of selected) if (perSticker[i]) perSticker[i].artistId = id;
	}
	function bulkSetExcluded(v: boolean) {
		for (const i of selected) if (perSticker[i]) perSticker[i].excluded = v;
	}
	function bulkSetNsfw(v: boolean) {
		for (const i of selected) if (perSticker[i]) perSticker[i].nsfw = v;
	}

	// Client-driven batched import. Collect the eligible stickers (not excluded),
	// then POST them to ?/importBatch in bounded BATCH_SIZE chunks, accumulating
	// per-batch results so a 100+ pack never rides in a single (timeout-prone) request.
	// Already-imported rows ride along too: the server re-syncs their metadata in place
	// (no re-download) or skips them if unchanged. On a hard/network error mid-loop we
	// stop cleanly; already-stored batches stay (re-run to resume — server dedupes).
	async function runImport() {
		if (importing) return;
		const eligible = data.candidates.filter((c) => !perSticker[c.index]?.excluded);
		if (eligible.length === 0) return;

		importing = true;
		progress = { done: 0, total: eligible.length };
		let imported = 0;
		let updated = 0;
		let skipped = 0;
		const failedItems: FailedItem[] = [];

		try {
			for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
				const slice = eligible.slice(i, i + BATCH_SIZE);
				const items = slice.map((c) => {
					const ps = perSticker[c.index];
					return {
						fileId: c.fileId,
						emojis: (ps?.emojis ?? '').split(',').map((e) => e.trim()).filter(Boolean),
						artistId: ps?.artistId ? Number(ps.artistId) : null,
						nsfw: !!ps?.nsfw
					};
				});

				const fd = new FormData();
				fd.set('nameOrUrl', data.nameOrUrl);
				if (managerArtistId !== '') fd.set('managerArtistId', String(managerArtistId));
				fd.set('items', JSON.stringify(items));

				const resp = await fetch('?/importBatch', { method: 'POST', body: fd });
				const des = deserialize(await resp.text());
				if (des.type === 'error') throw des.error ?? new Error(m.admin_import_batch_failed());
				if (des.type === 'failure') {
					throw new Error((des.data as { error?: string } | undefined)?.error ?? m.admin_import_batch_failed());
				}
				if (des.type !== 'success') throw new Error(m.admin_import_unexpected());

				const batch = (des.data as { batch: { imported: number; updated: number; skipped: number; failed: { fileId: string; reason: string }[] } }).batch;
				imported += batch.imported;
				updated += batch.updated;
				skipped += batch.skipped;
				for (const f of batch.failed) {
					const c = slice.find((s) => s.fileId === f.fileId);
					failedItems.push({ status: 'failed', fileId: f.fileId, emoji: c?.emoji ?? null, index: c?.index ?? -1, error: f.reason });
				}
				progress = { done: Math.min(i + slice.length, eligible.length), total: eligible.length };
			}

			result = { imported, updated, skipped, failed: failedItems.length, items: failedItems };
			if (failedItems.length === 0) {
				const parts = [m.admin_import_toast_imported({ count: imported })];
				if (updated) parts.push(m.admin_import_toast_updated({ count: updated }));
				toast.success(parts.join(' · '));
			} else {
				toast.error(m.admin_import_toast_failed({ count: failedItems.length }));
			}
		} catch (e) {
			// Hard/network error mid-loop: surface it and stop. Already-stored batches
			// persist; show the partial result so the admin can see what got in + retry.
			toast.error(e instanceof Error ? e.message : m.admin_import_failed());
			if (imported > 0 || updated > 0 || skipped > 0 || failedItems.length > 0) {
				result = { imported, updated, skipped, failed: failedItems.length, items: failedItems };
			}
		} finally {
			importing = false;
		}
	}
</script>

<a class="back-link" href="/admin/stickers"><ArrowLeft size={16} /> {m.admin_pack_back()}</a>

<div class="page-header">
	<h1>{showReview ? `${isResync ? m.admin_import_resync() : m.admin_import_review()} — ${data.setTitle}` : m.admin_stickers_import_telegram()}</h1>
	<p class="subtitle">
		{#if showReview}
			{#if isResync}
				{m.admin_import_resync_sub({ already: alreadyCount, newCount })}
			{:else}
				{m.admin_import_review_sub({ count: data.candidates.length })}
			{/if}
		{:else}
			{m.admin_import_intro()}
		{/if}
	</p>
</div>

{#if !data.telegramEnabled}
	<div class="banner warn"><AlertTriangle size={18} /> {m.admin_import_disabled_pre()}<code>TELEGRAM_BOT_TOKEN</code>{m.admin_import_disabled_post()}</div>
{:else if result}
	{@const r = result}
	<div class="alert ok">
		<CheckCircle2 size={18} />
		<div>
			<strong>{m.admin_import_result_main({ count: r.imported })}{r.updated ? m.admin_import_result_updated({ count: r.updated }) : ''}{r.skipped ? m.admin_import_result_skipped({ count: r.skipped }) : ''}{r.failed ? m.admin_import_result_failed({ count: r.failed }) : ''}</strong>
			<p>{m.admin_import_result_note()}</p>
		</div>
	</div>
	<div class="summary">
		<div class="stat"><span class="stat-label">{m.admin_import_stat_imported()}</span><span class="stat-val">{r.imported}</span></div>
		<div class="stat"><span class="stat-label">{m.admin_import_stat_updated()}</span><span class="stat-val">{r.updated}</span></div>
		<div class="stat"><span class="stat-label">{m.admin_import_stat_skipped()}</span><span class="stat-val">{r.skipped}</span></div>
		<div class="stat"><span class="stat-label">{m.admin_import_stat_failed()}</span><span class="stat-val">{r.failed}</span></div>
	</div>
			{#if r.failed > 0}
			{@const failedItems = r.items.filter((it) => it.status === 'failed')}
			<div class="failed-block">
				<h3>{m.admin_import_failed_heading({ count: r.failed })}</h3>
				<p class="failed-hint">{m.admin_import_failed_hint()}</p>
				<div class="failed-grid">
					{#each failedItems as it}
						<div class="failed-card">
							<div class="failed-img">
								{#if it.fileId}
									<img src="/admin/stickers/import/preview?fileId={encodeURIComponent(it.fileId)}" alt="" loading="lazy" />
								{:else}
									<Smile size={18} />
								{/if}
							</div>
							<div class="failed-meta">
								<span class="failed-emoji">{it.emoji ?? '#' + (it.index + 1)}</span>
								<span class="failed-error" title={it.error}>{it.error ?? m.admin_import_unknown_error()}</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="actions">
		<a class="btn btn-primary" href="/admin/stickers"><ArrowRight size={16} /> {m.admin_import_view_section()}</a>
			{#if r.failed > 0 && data.nameOrUrl}
				<button class="btn btn-outline" disabled={checking} onclick={async () => {
					// Same re-check navigation as the Fetch pack button — reuse its loading state.
					checking = true;
					await goto(`/admin/stickers/import?pack=${encodeURIComponent(data.nameOrUrl)}&check=1`);
					checking = false;
				}}>
					{#if checking}<Loader2 size={16} class="spin" /> {m.admin_import_fetching()}{:else}<RefreshCw size={16} /> {m.admin_import_retry_failed({ count: r.failed })}{/if}
				</button>
			{/if}
		<button class="btn btn-outline" onclick={() => goto('/admin/stickers/import')}><Plus size={16} /> {m.admin_import_another()}</button>
	</div>
{:else}
	{#if data.reachError}
		<div class="alert err">
			<AlertTriangle size={18} />
			<div>
				<strong>{m.admin_import_reach_title()}</strong>
				<p>{m.admin_import_reach_body({ pack: data.nameOrUrl })}</p>
			</div>
		</div>
	{/if}

	{#if showReview}
		<div class="ctx">
			<span class="ctx-chip"><Shield size={13} /> {managerArtistId === '' ? m.admin_import_managed_by_you() : m.admin_import_managed_by({ name: managerName })}</span>
			{#if defaultArtistDisplay}
				<span class="ctx-chip"><Palette size={13} /> {m.admin_import_default_artist_chip({ name: defaultArtistDisplay })}</span>
			{/if}
			<button type="button" class="ctx-new-artist" onclick={() => openNewArtist('pool')}><UserPlus size={13} /> {m.admin_pack_new_artist()}</button>
		</div>

		<!-- Bulk-label bar: select stickers (click / shift-click range / Select all),
		     then assign an artist or toggle exclude/NSFW for the whole selection. -->
		<div class="bulk-bar" class:active={selected.size > 0}>
			{#if selected.size === 0}
				<span class="bulk-hint">{m.admin_import_bulk_tip()}</span>
				<button type="button" class="link-btn" onclick={selectAll}>{m.admin_pack_select_all({ count: data.candidates.length })}</button>
			{:else}
				<span class="bulk-count">{m.admin_pack_selected({ count: selected.size })}</span>
				<div class="bulk-actions">
					<select class="input sm" bind:value={bulkArtist} aria-label={m.admin_pack_bulk_artist_aria()}>
						<option value="">{m.admin_pack_set_artist()}</option>
						{#each artists as a}<option value={String(a.id)}>{a.name}</option>{/each}
					</select>
					<button type="button" class="btn-sm" disabled={!bulkArtist} onclick={() => applyArtistToSelected(bulkArtist)}>{m.admin_pack_apply()}</button>
					<button type="button" class="btn-sm" onclick={() => applyArtistToSelected('')}>{m.admin_pack_unassign()}</button>
					<button type="button" class="btn-sm" onclick={() => openNewArtist('bulk')}><UserPlus size={13} /> {m.admin_import_new()}</button>
					<span class="bulk-div"></span>
					<button type="button" class="btn-sm" onclick={() => bulkSetExcluded(true)}>{m.admin_import_exclude()}</button>
					<button type="button" class="btn-sm" onclick={() => bulkSetExcluded(false)}>{m.admin_import_include()}</button>
					<button type="button" class="btn-sm" onclick={() => bulkSetNsfw(true)}>NSFW</button>
				</div>
				<button type="button" class="link-btn" onclick={clearSelection}>{m.admin_pack_clear()}</button>
			{/if}
		</div>

		<div class="grid">
			{#each data.candidates as c}
				{@const ps = perSticker[c.index] ?? { excluded: false, nsfw: false, artistId: '', emojis: c.emoji ?? '' }}
				{@const isSel = selected.has(c.index)}
				<div class="sticker-card" class:excluded={ps.excluded} class:already={c.alreadyImported} class:selected={isSel}>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="sticker-img"
						class:selected={isSel}
						role="button"
						tabindex="0"
						aria-pressed={isSel}
						title={m.admin_pack_click_select()}
						onclick={(e) => toggleSelect(c.index, e)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(c.index, e); } }}
					>
						<span class="select-check" class:on={isSel}><Check size={12} /></span>
						{#if ps.nsfw}<span class="nsfw-badge">NSFW</span>{/if}
						<!-- Previews stream through our token-auth proxy (no token in the client). -->
						{#if c.format === 'animated'}
							<div class="img-placeholder"><Film size={28} /><span class="anim-label">{m.admin_import_animated()}</span></div>
						{:else if c.format === 'video'}
							<video
								src="/admin/stickers/import/preview?fileId={encodeURIComponent(c.fileId)}"
								muted
								loop
								playsinline
								preload="metadata"
								class="preview"
							></video>
						{:else}
							<img
								src="/admin/stickers/import/preview?fileId={encodeURIComponent(c.fileId)}"
								alt=""
								loading="lazy"
								class="preview"
							/>
						{/if}
					</div>
					<div class="sticker-meta">
						<div class="emoji-row">
							<span class="emoji-chip">{c.emoji ?? '?'}</span>
							<input
								class="input emoji-input"
								bind:value={ps.emojis}
								placeholder={m.admin_import_emoji_placeholder()}
								disabled={ps.excluded}
							/>
						</div>
						<select class="input sm artist-select" bind:value={ps.artistId} disabled={ps.excluded}>
							<option value="">{m.admin_import_unassigned()}</option>
							{#each artists as a}
								<option value={String(a.id)}>{a.name}</option>
							{/each}
						</select>
						<div class="card-footer">
							<div class="toggle-row">
								<label class="check-label">
									<input type="checkbox" bind:checked={ps.excluded} />
									{m.admin_import_exclude()}
								</label>
								<label class="check-label">
									<input type="checkbox" bind:checked={ps.nsfw} disabled={ps.excluded} />
									NSFW
								</label>
							</div>
							<div class="badge-row">
								<span class="fmt-chip">{c.format}</span>
								{#if c.alreadyImported}<span class="status-chip imported">{m.admin_import_chip_imported()}</span>{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>

		<div class="action-bar">
			<div class="action-summary">
				<strong>{m.admin_import_summary({ eligible: eligibleCount, total: data.candidates.length, artists: artistsCount, nsfw: nsfwCount })}</strong>
				{#if unattributedCount > 0}
					<span>{m.admin_import_unattributed_note({ count: unattributedCount })}</span>
				{:else}
					<span>{m.admin_import_hosted_note()}</span>
				{/if}
			</div>
			<div class="action-btns">
				<a class="btn btn-outline" href="/admin/stickers">{m.admin_cancel()}</a>
				<button class="btn btn-primary" onclick={() => (showConfirm = true)} disabled={eligibleCount === 0 || importing}>
					{#if importing}
						<Loader2 size={16} class="spin" /> {m.admin_fursuit_importing()} {progress.done} / {progress.total}
					{:else}
						<Check size={16} /> {isResync ? m.admin_import_resync_count({ count: eligibleCount }) : m.admin_import_import_count({ count: eligibleCount })}
					{/if}
				</button>
			</div>
		</div>

		{#if importing}
			<div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
				<div class="progress-bar" style="width: {progress.total ? (progress.done / progress.total) * 100 : 0}%"></div>
			</div>
		{/if}
	{:else}
		{#if data.checked && !data.reachError && data.candidates.length === 0}
			<div class="empty"><Smile size={36} /><p>{m.admin_import_none_found({ pack: data.nameOrUrl })}</p></div>
		{/if}

		<div class="form-card">
			<div class="field">
				<label for="pack-input">{m.admin_import_pack_link()}</label>
				<input
					id="pack-input"
					class="input"
					bind:value={packInput}
					placeholder="https://t.me/addstickers/PackName"
					onkeydown={(e) => { if (e.key === 'Enter') check(); }}
				/>
			</div>
			<div class="field">
				<label for="manager-select">{m.admin_import_managed_label()}</label>
				<select id="manager-select" class="input" bind:value={managerArtistId}>
					<option value="">{m.admin_pack_manager_self({ ownerName })}</option>
					{#each artists as a}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="default-artist">{m.admin_import_default_artist_label()}</label>
				<div class="select-with-action">
					<select id="default-artist" class="input" bind:value={defaultArtistId}>
						<option value="">{m.admin_upload_select_artist()}</option>
						{#each artists as a}
							<option value={String(a.id)}>{a.name}</option>
						{/each}
					</select>
					<button type="button" class="ctx-new-artist" onclick={() => openNewArtist('default')}><UserPlus size={13} /> {m.admin_pack_new_artist()}</button>
				</div>
				<p class="hint">{m.admin_import_default_artist_hint()}</p>
			</div>

			<div class="note">
				<Info size={18} />
				<div>
					<strong>{m.admin_import_note_title()}</strong>
					<p>{m.admin_import_note_body()}</p>
				</div>
			</div>

			<div class="card-actions">
				<button class="btn btn-primary" onclick={check} disabled={!packInput.trim() || checking}>
					{#if checking}
						<Loader2 size={16} class="spin" /> {m.admin_import_fetching()}
					{:else if data.reachError}
						<RefreshCw size={16} /> {m.admin_import_retry()}
					{:else}
						<Download size={16} /> {m.admin_import_fetch()}
					{/if}
				</button>
			</div>
		</div>
	{/if}

	{#if form?.error}
		<div class="banner err"><AlertTriangle size={18} /> {form.error}</div>
	{/if}
{/if}

{#if showConfirm}
	<ConfirmDialog
		title={m.admin_import_confirm_title()}
		message={m.admin_import_confirm_message({ count: eligibleCount, pack: data.setTitle || data.nameOrUrl })}
		confirmLabel={m.admin_import_confirm_label()}
		oncancel={() => (showConfirm = false)}
		onconfirm={() => {
			showConfirm = false;
			// Run the client-driven batch loop (bounded requests, real progress).
			runImport();
		}}
	/>
{/if}

{#if showNewArtist}
	<NewArtistDialog registryEnabled={data.registryEnabled} oncreated={onArtistCreated} oncancel={() => (showNewArtist = false)} />
{/if}

<style>
	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px;
	}
	.back-link:hover { color: var(--foreground); text-decoration: none; }
	.page-header { margin-bottom: 20px; }
	.page-header h1 { font-size: 22px; margin: 0 0 4px; }
	.subtitle { font-size: 13px; color: var(--muted-foreground); max-width: 70ch; margin: 0; }
	.banner {
		display: flex; align-items: center; gap: 8px; padding: 12px 16px;
		border-radius: var(--radius-s); font-size: 13px; margin-bottom: 16px;
	}
	.banner.warn { background: rgba(245,166,35,0.1); color: #f5a623; }
	.banner.err { background: rgba(248,113,113,0.12); color: #f87171; }
	code { background: var(--secondary); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

	/* Rich alerts (success / error) — icon + title + body */
	.alert {
		display: flex; align-items: flex-start; gap: 12px; padding: 16px;
		border-radius: var(--radius-s); margin-bottom: 18px;
	}
	.alert strong { display: block; font-size: 14px; font-weight: 600; }
	.alert p { margin: 2px 0 0; font-size: 12px; opacity: 0.85; }
	.alert.ok { background: rgba(74,222,128,0.1); color: #4ade80; }
	.alert.err { background: rgba(248,113,113,0.12); color: #f87171; }

	/* Success summary stats */
	.summary {
		display: flex; flex-wrap: wrap; gap: 32px; padding: 24px;
		border: 1px solid var(--border); border-radius: var(--radius-s); margin-bottom: 18px;
	}
	.stat { display: flex; flex-direction: column; gap: 4px; }
	.stat-label { font-size: 12px; color: var(--muted-foreground); }
	.stat-val { font: 700 22px var(--font-primary); }
	.actions { display: flex; gap: 12px; flex-wrap: wrap; }

	/* Failed-import detail */
	.failed-block { border: 1px solid var(--destructive); border-radius: var(--radius-s); padding: 16px; margin-bottom: 18px; background: rgba(248,113,113,0.06); }
	.failed-block h3 { font-size: 14px; margin: 0 0 4px; color: #f87171; }
	.failed-hint { font-size: 12px; color: var(--muted-foreground); margin: 0 0 12px; max-width: 70ch; }
	.failed-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
	.failed-card { display: flex; gap: 8px; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 8px; }
	.failed-img { width: 40px; height: 40px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--secondary); border-radius: var(--radius-xs); overflow: hidden; color: var(--muted-foreground); }
	.failed-img img { width: 100%; height: 100%; object-fit: contain; }
	.failed-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.failed-emoji { font-size: 16px; line-height: 1; }
	.failed-error { font-size: 11px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	/* Idle / error form card */
	.form-card {
		border: 1px solid var(--border); border-radius: var(--radius-m, 12px);
		background: var(--card); padding: 24px; max-width: 760px;
		display: flex; flex-direction: column; gap: 18px;
	}
	.field { display: flex; flex-direction: column; gap: 6px; }
	.field label { font-size: 12px; color: var(--muted-foreground); }
	/* Select + inline "New artist" action on one row — the same pattern as the pack
	   form's manager/default selects, so the control reads identically everywhere. */
	.select-with-action { display: flex; align-items: stretch; gap: 8px; }
	.select-with-action .input { flex: 1; min-width: 0; }
	.link-btn {
		display: inline-flex; align-items: center; gap: 5px; background: none; border: none;
		color: var(--primary); font-size: 12px; padding: 0; cursor: pointer;
	}
	.link-btn:hover { text-decoration: underline; }
	.hint { font-size: 11px; color: var(--muted-foreground); margin: 0; }
	.note {
		display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px;
		border-radius: var(--radius-s); background: rgba(245,166,35,0.08); color: #f5a623;
	}
	.note strong { display: block; font-size: 13px; font-weight: 600; }
	.note p { margin: 2px 0 0; font-size: 12px; color: var(--muted-foreground); }
	.card-actions { display: flex; justify-content: flex-end; }

	.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px; color: var(--muted-foreground); text-align: center; }

	/* Review context chips */
	.ctx { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
	.ctx-chip {
		display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px;
		border-radius: var(--radius-pill); background: var(--secondary);
		font-size: 12px; font-weight: 500; color: var(--foreground);
	}

	/* Review grid */
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px; }
	.sticker-card { border: 1px solid var(--border); border-radius: var(--radius-m, 10px); overflow: hidden; display: flex; flex-direction: column; background: var(--card); transition: opacity 0.15s; }
	.sticker-card.excluded { opacity: 0.55; }
	.sticker-card.already { border-color: var(--primary); }
	.sticker-img { position: relative; aspect-ratio: 16 / 9; background: var(--secondary); display: flex; align-items: center; justify-content: center; overflow: hidden; border-bottom: 1px solid var(--border); }
	.nsfw-badge { position: absolute; top: 8px; left: 8px; z-index: 1; background: var(--destructive); color: #fff; font: 700 10px var(--font-secondary); padding: 3px 8px; border-radius: var(--radius-pill); }

	/* Bulk selection */
	.bulk-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; padding: 8px 12px; border: 1px dashed var(--border); border-radius: var(--radius-s); }
	.bulk-bar.active { border-style: solid; border-color: var(--primary); background: color-mix(in srgb, var(--primary) 6%, transparent); }
	.bulk-hint { font-size: 12px; color: var(--muted-foreground); }
	.bulk-count { font-size: 13px; font-weight: 600; }
	.bulk-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.btn-sm { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); background: var(--secondary); color: var(--foreground); cursor: pointer; }
	.btn-sm:hover:not(:disabled) { border-color: var(--primary); }
	.btn-sm:disabled { opacity: 0.45; cursor: not-allowed; }
	.bulk-div { width: 1px; height: 20px; background: var(--border); }
	.bulk-bar .link-btn { margin-left: auto; }
	.sticker-card.selected { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary); }
	.sticker-img { cursor: pointer; }
	.sticker-img.selected::after { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--primary) 18%, transparent); pointer-events: none; }
	.select-check {
		position: absolute; top: 8px; right: 8px; z-index: 2; width: 20px; height: 20px; border-radius: 50%;
		border: 2px solid rgba(255,255,255,0.7); background: rgba(0,0,0,0.35);
		display: flex; align-items: center; justify-content: center; color: transparent;
	}
	.select-check.on { background: var(--primary); border-color: var(--primary); color: #fff; }
	.img-placeholder { color: var(--muted-foreground); display: flex; flex-direction: column; align-items: center; gap: 4px; }
	.anim-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
	.preview { width: 100%; height: 100%; object-fit: contain; }
	.sticker-meta { display: flex; flex-direction: column; gap: 9px; padding: 10px; }
	.emoji-row { display: flex; align-items: center; gap: 6px; }
	.emoji-chip { font-size: 20px; flex-shrink: 0; }
	.emoji-input { flex: 1; font-size: 12px; padding: 4px 8px; min-width: 0; }
	.artist-select.input.sm { font-size: 12px; padding: 5px 8px; width: 100%; }
	.ctx-new-artist {
		display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 10px;
		border-radius: var(--radius-pill); border: 1px dashed var(--border); background: none;
		color: var(--primary); cursor: pointer;
	}
	.ctx-new-artist:hover { border-color: var(--primary); }
	.warn-text { color: #f5a623 !important; }
	.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.toggle-row { display: flex; gap: 12px; }
	.check-label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted-foreground); cursor: pointer; }
	.badge-row { display: flex; gap: 4px; flex-wrap: wrap; }
	.fmt-chip { font-size: 10px; padding: 2px 6px; border-radius: var(--radius-pill); background: var(--secondary); color: var(--muted-foreground); }
	.status-chip.imported { font-size: 10px; padding: 2px 6px; border-radius: var(--radius-pill); background: rgba(74,222,128,0.1); color: #4ade80; }

	/* Review action bar */
	.action-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--border); }
	.action-summary { display: flex; flex-direction: column; gap: 2px; }
	.action-summary strong { font-size: 13px; font-weight: 500; }
	.action-summary span { font-size: 12px; color: var(--muted-foreground); }
	.action-btns { display: flex; gap: 10px; }

	/* Batched-import progress bar */
	.progress { margin-top: 14px; height: 6px; border-radius: var(--radius-pill); background: var(--secondary); overflow: hidden; }
	.progress-bar { height: 100%; background: var(--primary); border-radius: var(--radius-pill); transition: width 0.25s ease; }

	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
