<script lang="ts">
	import { enhance } from '$app/forms';
	import { flip } from 'svelte/animate';
	import { X, Plus, ArrowLeft, Check, Loader2, GripVertical, UserPlus } from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte';
	import { DragReorder } from '$lib/drag-reorder.svelte';
	import * as m from '$lib/paraglide/messages';
	import StickerMedia from '$lib/components/StickerMedia.svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';

	interface PackInit {
		name: string;
		managerArtistId: number | null;
		description: string | null;
		telegramUrl: string | null;
		// Vestigial: pack covers are now an auto-generated mosaic of the first ≤4
		// stickers, so the form no longer uploads a cover. Kept on the interface so
		// the edit page can still pass it without erroring.
		coverImageUrl?: string | null;
		published: boolean;
	}
	interface StickerInit {
		imageUrl: string;
		artistId: number | null;
		emojis: string[];
		nsfw: boolean;
		format: string;
	}
	interface Props {
		heading: string;
		submitLabel: string;
		intro?: string;
		artists: { id: number; name: string }[];
		/** Existing pack for edit mode; omit for create. */
		pack?: PackInit | null;
		/** Prefilled stickers for edit mode. */
		stickers?: StickerInit[];
		form?: { error?: string } | null;
		/** Site owner / persona name, used in the "managed by" labels. */
		ownerName?: string;
		/** Whether the shared registry is connected — forwarded to the New-artist modal. */
		registryEnabled?: boolean;
	}

	let { heading, submitLabel, intro, artists, pack = null, stickers = [], form = null, ownerName = m.admin_stickers_site_owner(), registryEnabled = false }: Props = $props();

	const isEdit = pack !== null;

	interface StickerEntry {
		// Client-only stable id: the each-block key for animate:flip. The server never
		// sees it — hidden inputs are still emitted by array order (`sticker[i][...]`).
		uid: number;
		imageUrl: string;
		artistId: string;
		emojis: string;
		nsfw: boolean;
		format: string;
	}

	let nextUid = 0;

	// Reactive artist pool, seeded from the server prop. Artists created inline via the
	// "New artist" modal are appended here so they instantly appear in every dropdown
	// (manager, default, bulk-apply, per-row) without a page reload. The `artists` prop
	// itself is left untouched — the load contract is unchanged.
	let artistList = $state([...artists]);

	let defaultArtistId = $state(pack?.managerArtistId ? String(pack.managerArtistId) : '');
	// A manager => single-artist pack: per-sticker artist overrides are ignored on
	// save (every sticker is credited to the manager). Track it so the form reflects
	// that rather than silently discarding overrides the admin set.
	let managerArtistId = $state(pack?.managerArtistId ? String(pack.managerArtistId) : '');
	const managerName = $derived(artistList.find((a) => String(a.id) === managerArtistId)?.name ?? '');

	// New-artist modal. `newArtistTarget` = where to apply the created artist once it
	// comes back from POST /api/artists: 'manager' (the manager select), 'default' (the
	// pack-wide default artist), or 'bulk' (the current bulk selection). Mirrors the
	// Telegram import review page's NewArtistDialog wiring.
	let showNewArtist = $state(false);
	let newArtistTarget = $state<'manager' | 'default' | 'bulk'>('default');

	function openNewArtist(target: 'manager' | 'default' | 'bulk') {
		newArtistTarget = target;
		showNewArtist = true;
	}
	function onArtistCreated(artist: { id: number; name: string }) {
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		const id = String(artist.id);
		if (newArtistTarget === 'manager') managerArtistId = id;
		else if (newArtistTarget === 'default') defaultArtistId = id;
		else if (newArtistTarget === 'bulk') applyArtistToSelected(id);
		showNewArtist = false;
	}

	let stickerEntries = $state<StickerEntry[]>(
		stickers.map((s) => ({
			uid: nextUid++,
			imageUrl: s.imageUrl,
			artistId: s.artistId != null ? String(s.artistId) : '',
			emojis: s.emojis.join(', '),
			nsfw: s.nsfw,
			format: s.format
		}))
	);

	let uploading = $state(false);
	let published = $state(pack?.published ?? false);
	let saving = $state(false);

	async function uploadFile(file: File): Promise<string | null> {
		const fd = new FormData();
		fd.append('file', file);
		// Keep sticker/cover uploads in the stickers/ partition instead of leaking
		// into artwork/ (the /api/upload default). These can't be per-pack
		// partitioned (stickers/{packSlug}/...) yet — the pack/slug doesn't exist
		// until the form is saved — so stickers/ is the correct target for now.
		fd.append('folder', 'stickers');
		const res = await fetch('/api/upload', { method: 'POST', body: fd });
		// 422 is the one failure the operator can act on: the file's metadata
		// could not be stripped, and a re-export fixes it (SONA-170).
		if (res.status === 422) return 'refused';
		if (!res.ok) return null;
		const { url } = (await res.json()) as { url: string };
		return url;
	}

	async function uploadStickers(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		if (!files.length) return;
		uploading = true;
		let ok = 0;
		let failed = 0;
		let refused = 0;
		try {
			for (const file of files) {
				let url: string | null = null;
				try {
					url = await uploadFile(file);
				} catch {
					url = null;
				}
				if (url === 'refused') {
					refused++;
					failed++;
				} else if (url) {
					ok++;
					stickerEntries.push({
						uid: nextUid++,
						imageUrl: url,
						artistId: '',
						emojis: '',
						nsfw: false,
						format: file.name.endsWith('.png') ? 'png' : 'webp'
					});
				} else {
					failed++;
				}
			}
			stickerEntries = [...stickerEntries];
		} finally {
			uploading = false;
		}
		// Keep the successful uploads; surface the failures without discarding them.
		// The count is shown whenever the batch was mixed: some file failed for a
		// reason other than a refusal, or some file got through alongside a
		// refusal. When every file was refused, the count would only repeat the
		// number the refusal message carries, so the refusal is shown alone.
		if (failed > 0 && (failed > refused || ok > 0)) {
			toast.error(m.admin_pack_upload_partial({ ok, total: files.length, failed }));
		}
		// A refused file has a fix the operator can apply, so say so rather than
		// leave it inside the failure count.
		if (refused > 0) toast.error(m.admin_pack_upload_unscrubbable({ refused }));
	}

	function removeSticker(i: number) {
		stickerEntries = stickerEntries.filter((_, idx) => idx !== i);
		// Indices shift after a removal, so any prior selection now points at the wrong
		// rows — drop it rather than silently retarget.
		clearSelection();
	}

	// --- Bulk editing: set artist / NSFW on many stickers at once. Editing a 100+
	// pack one row at a time is painful, so mirror the import review grid — click a
	// row's thumbnail to select, shift-click for a range, then bulk-apply. Selection
	// keys are array indices (stable until a row is added/removed, which resets it).
	let selected = $state<Set<number>>(new Set());
	let lastClicked = $state<number | null>(null);
	let bulkArtist = $state('');

	function toggleSelect(index: number, ev: MouseEvent | KeyboardEvent) {
		const next = new Set(selected);
		if (ev.shiftKey && lastClicked !== null) {
			const [lo, hi] = lastClicked < index ? [lastClicked, index] : [index, lastClicked];
			for (let i = lo; i <= hi; i++) next.add(i);
		} else {
			if (next.has(index)) next.delete(index);
			else next.add(index);
			lastClicked = index;
		}
		selected = next;
	}
	function selectAll() {
		selected = new Set(stickerEntries.map((_, i) => i));
	}
	function clearSelection() {
		selected = new Set();
		lastClicked = null;
	}
	// Sets the artist for the whole selection. Pass '' to clear back to "default
	// artist" (the bulk "Unassign" button); "Apply" is disabled with no artist picked.
	// Moot in manager mode (per-sticker artist is ignored on save), so those controls
	// are hidden when a manager is set — see the bulk bar markup.
	function applyArtistToSelected(id: string) {
		for (const i of selected) if (stickerEntries[i]) stickerEntries[i].artistId = id;
	}
	function bulkSetNsfw(v: boolean) {
		for (const i of selected) if (stickerEntries[i]) stickerEntries[i].nsfw = v;
	}

	// --- Drag-to-reorder (shared DragReorder helper: pointer drag + arrow-key
	// path + live announcement). Reordering the array directly is all that's
	// needed: the hidden inputs are emitted in array order and the server
	// assigns `position` from that order. animate:flip (keyed by uid) slides
	// the other rows into place. onMoved clears the selection: reordering
	// shifts every index, so the index-keyed selection would point at the wrong
	// rows (same reasoning as removeSticker).
	const reorder = new DragReorder({
		count: () => stickerEntries.length,
		move: (from, to) => {
			const next = [...stickerEntries];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			stickerEntries = next;
		},
		onMoved: clearSelection
	});
</script>

<a class="back-link" href="/admin/stickers"><ArrowLeft size={16} /> {m.admin_pack_back()}</a>
<div class="page-header">
	<h1>{heading}</h1>
	{#if intro}
		<p class="intro">{intro}</p>
	{/if}
</div>

{#if form?.error}
	<div class="banner err">{form.error}</div>
{/if}

<form
	method="POST"
	class="form"
	use:enhance={() => {
		saving = true;
		return async ({ update, result }) => {
			// On success the action redirects, which enhance follows; only failures stay here.
			await update({ reset: false });
			saving = false;
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? m.admin_pack_save_failed());
			else if (result.type === 'error') toast.error(m.admin_something_wrong());
		};
	}}
>
	<section class="section">
		<h2>{m.admin_pack_details()}</h2>
		<div class="fields">
			<label>
				<span>{m.admin_pack_name()}</span>
				<input type="text" class="input" name="name" value={pack?.name ?? ''} required placeholder={m.admin_pack_name_placeholder()} />
			</label>
			<label>
				<span>{m.admin_pack_manager({ ownerName })}</span>
				<div class="select-with-action">
					<select class="input" name="managerArtistId" bind:value={managerArtistId}>
						<option value="">{m.admin_pack_manager_self({ ownerName })}</option>
						{#each artistList as a}
							<option value={String(a.id)}>{a.name}</option>
						{/each}
					</select>
					<button type="button" class="new-artist-btn" onclick={() => openNewArtist('manager')}><UserPlus size={13} /> {m.admin_pack_new_manager()}</button>
				</div>
				{#if managerArtistId}
					<small class="manager-hint">{m.admin_pack_manager_hint({ managerName })}</small>
				{/if}
			</label>
			<label>
				<span>{m.admin_pack_description()}</span>
				<textarea class="input" name="description" rows="3" placeholder={m.admin_pack_description_placeholder()}>{pack?.description ?? ''}</textarea>
			</label>
			<label>
				<span>{m.admin_pack_telegram_link()}</span>
				<input type="text" class="input" name="telegramUrl" value={pack?.telegramUrl ?? ''} placeholder="https://t.me/addstickers/…" />
			</label>
			<div class="pub-row">
				<!-- No hidden fallback: an unchecked checkbox just omits `published`,
				     which the server reads as false. A hidden value="0" BEFORE the box
				     made data.get('published') return "0" even when checked, silently
				     unpublishing the pack on every save. -->
				<label class="switch-label">
					<input type="checkbox" name="published" value="1" bind:checked={published} class="sr-checkbox" />
					<span class="switch-visual"></span>
				</label>
				<div class="pub-text">
					<strong>{m.admin_pack_publish()}</strong>
					<span>{published ? m.admin_pack_publish_on() : m.admin_pack_publish_off()}</span>
				</div>
			</div>
		</div>
	</section>

	<section class="section">
		<h2>{m.admin_pack_default_artist()}</h2>
		<div class="select-with-action">
			<select class="input" name="defaultArtistId" bind:value={defaultArtistId}>
				<option value="">{m.admin_upload_select_artist()}</option>
				{#each artistList as a}
					<option value={String(a.id)}>{a.name}</option>
				{/each}
			</select>
			<button type="button" class="new-artist-btn" onclick={() => openNewArtist('default')}><UserPlus size={13} /> {m.admin_pack_new_artist()}</button>
		</div>
	</section>

	<section class="section">
		<h2>{m.admin_nav_stickers()}{isEdit ? ` (${stickerEntries.length})` : ''}</h2>
		{#if isEdit}
			<p class="hint">{m.admin_pack_edit_hint()}</p>
		{/if}

		<label class="upload-zone multi">
			<Plus size={20} />
			<span>{uploading ? m.admin_upload_uploading() : m.admin_pack_dropzone()}</span>
			<input type="file" accept="image/png,image/webp" multiple onchange={uploadStickers} disabled={uploading} style="display:none" />
		</label>

		{#if stickerEntries.length > 0}
			<!-- Bulk bar: select rows (click / shift-click range / Select all), then set
			     the artist or NSFW for the whole selection at once. -->
			<div class="bulk-bar" class:active={selected.size > 0}>
				{#if selected.size === 0}
					<span class="bulk-hint">{m.admin_pack_bulk_tip()}</span>
					<button type="button" class="link-btn" onclick={selectAll}>{m.admin_pack_select_all({ count: stickerEntries.length })}</button>
				{:else}
					<span class="bulk-count">{m.admin_pack_selected({ count: selected.size })}</span>
					<div class="bulk-actions">
						{#if managerArtistId}
							<span class="bulk-managed">{m.admin_pack_artist_locked({ managerName })}</span>
							<span class="bulk-div"></span>
						{:else}
							<select class="input sm" bind:value={bulkArtist} aria-label={m.admin_pack_bulk_artist_aria()}>
								<option value="">{m.admin_pack_set_artist()}</option>
								{#each artistList as a}<option value={String(a.id)}>{a.name}</option>{/each}
							</select>
							<button type="button" class="btn-sm" disabled={!bulkArtist} onclick={() => applyArtistToSelected(bulkArtist)}>{m.admin_pack_apply()}</button>
							<button type="button" class="btn-sm" onclick={() => applyArtistToSelected('')}>{m.admin_pack_unassign()}</button>
							<button type="button" class="new-artist-btn" onclick={() => openNewArtist('bulk')}><UserPlus size={13} /> {m.admin_pack_new_artist()}</button>
							<span class="bulk-div"></span>
						{/if}
						<button type="button" class="btn-sm" onclick={() => bulkSetNsfw(true)}>{m.admin_pack_nsfw_on()}</button>
						<button type="button" class="btn-sm" onclick={() => bulkSetNsfw(false)}>{m.admin_pack_nsfw_off()}</button>
					</div>
					<button type="button" class="link-btn" onclick={clearSelection}>{m.admin_pack_clear()}</button>
				{/if}
			</div>

			<!-- Always-mounted live region for the reorder announcements (arrow-key
			     moves have no visual cue a screen-reader user can follow). -->
			<span class="sr-only" aria-live="polite">{reorder.announcement}</span>
			<div class="sticker-list">
				{#each stickerEntries as sticker, i (sticker.uid)}
					{@const isSel = selected.has(i)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="sticker-row"
						class:selected={isSel}
						class:dragging={reorder.dragIndex === i}
						class:drop-target={reorder.overIndex === i && reorder.dragIndex !== null && reorder.dragIndex !== i}
						animate:flip={{ duration: 200 }}
						data-reorder-index={i}
					>
						<!-- Dedicated drag handle: the pointer-event reorder only ever starts here,
						     so it can't be triggered by a stray drag elsewhere on the row and never
						     fires the thumbnail's click-to-select. Arrow keys move the row too. -->
						<button
							type="button"
							class="drag-handle"
							aria-label={m.admin_pack_drag_reorder()}
							title={m.admin_pack_drag_reorder()}
							onpointerdown={(e) => reorder.handlePointerDown(i, e)}
							onpointermove={(e) => reorder.handlePointerMove(e)}
							onpointerup={() => reorder.handlePointerUp()}
							onpointercancel={() => reorder.reset()}
							onkeydown={(e) => reorder.handleKeydown(i, e)}
						>
							<GripVertical size={16} />
						</button>
						<div
							class="sticker-thumb"
							class:selected={isSel}
							role="button"
							tabindex="0"
							aria-pressed={isSel}
							title={m.admin_pack_click_select()}
							onclick={(e) => toggleSelect(i, e)}
							onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(i, e); } }}
						>
							<span class="select-check" class:on={isSel}><Check size={12} /></span>
							<StickerMedia format={sticker.format as 'png' | 'webp' | 'animated' | 'video'} imageUrl={sticker.imageUrl} alt={m.admin_pack_sticker_alt({ n: i + 1 })} width={112} />
						</div>
						<div class="sticker-fields">
							<input type="hidden" name="sticker[{i}][imageUrl]" value={sticker.imageUrl} />
							<input type="hidden" name="sticker[{i}][format]" value={sticker.format} />
							<label>
								<span>{m.stickers_emojis_label()}</span>
								<input type="text" class="input sm" name="sticker[{i}][emojis]" bind:value={sticker.emojis} placeholder="😀,🔥" />
							</label>
							{#if managerArtistId}
								<label>
									<span>{m.admin_field_artist()}</span>
									<span class="locked-artist">{managerName}</span>
								</label>
							{:else}
								<label>
									<span>{m.admin_field_artist()}</span>
									<select class="input sm" name="sticker[{i}][artistId]" bind:value={sticker.artistId}>
										<option value="">{m.admin_pack_default_artist()}</option>
										{#each artistList as a}
											<option value={String(a.id)}>{a.name}</option>
										{/each}
									</select>
								</label>
							{/if}
						</div>
						<div class="row-controls">
							<label class="check-label sm nsfw-check">
								<input type="hidden" name="sticker[{i}][nsfw]" value="0" />
								<input type="checkbox" name="sticker[{i}][nsfw]" value="1" bind:checked={sticker.nsfw} />
								NSFW
							</label>
							<button type="button" class="remove-btn" onclick={() => removeSticker(i)} aria-label={m.admin_pack_remove_sticker()}>
								<X size={16} />
							</button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="muted">{m.admin_pack_no_stickers()}</p>
		{/if}
	</section>

	<div class="save-bar">
		<span class="save-note">{m.stickers_source_self_hosted()} · {m.admin_count_stickers({ count: stickerEntries.length })}</span>
		<div class="save-actions">
			<a href="/admin/stickers" class="btn btn-outline">{m.admin_cancel()}</a>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}<Check size={16} /> {submitLabel}{/if}
			</button>
		</div>
	</div>
</form>

{#if showNewArtist}
	<NewArtistDialog
		title={newArtistTarget === 'manager' ? m.admin_new_manager_title() : m.admin_new_artist_title()}
		registryEnabled={registryEnabled}
		oncreated={onArtistCreated}
		oncancel={() => (showNewArtist = false)}
	/>
{/if}

<style>
	.back-link {
		display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
		color: var(--muted-foreground); margin-bottom: 16px; text-decoration: none;
	}
	.back-link:hover { color: var(--foreground); }
	.page-header { margin-bottom: 24px; }
	.page-header h1 { font-size: 22px; margin: 0 0 4px; }
	.intro { font-size: 13px; color: var(--muted-foreground); max-width: 70ch; margin: 0; }
	.banner { padding: 12px 16px; border-radius: var(--radius-s); font-size: 13px; margin-bottom: 16px; }
	.banner.err { background: rgba(248,113,113,0.12); color: #f87171; }
	.form { display: flex; flex-direction: column; gap: 32px; max-width: 700px; }
	.section { display: flex; flex-direction: column; gap: 16px; }
	h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
	.fields { display: flex; flex-direction: column; gap: 14px; }
	label { display: flex; flex-direction: column; gap: 4px; }
	label span { font-size: 12px; color: var(--muted-foreground); }
	.check-label { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
	.check-label.sm { font-size: 12px; }
	.check-label input[type='checkbox'] { margin: 0; flex-shrink: 0; }
	.hint { font-size: 12px; color: var(--muted-foreground); margin: -8px 0 0; }
	.manager-hint { font-size: 11px; color: var(--primary); margin-top: 2px; }
	.locked-artist { font-size: 12px; padding: 5px 8px; color: var(--muted-foreground); border: 1px dashed var(--border); border-radius: var(--radius-xs); }
	/* Select + inline "New artist" action sitting on one row. The select flexes; the
	   button hugs its content so it stays compact next to the dropdown. */
	.select-with-action { display: flex; align-items: stretch; gap: 8px; }
	.select-with-action .input { flex: 1; min-width: 0; }
	/* Small, orange (color:var(--primary)) dashed "New artist" button — matches the
	   Telegram import page's .ctx-new-artist so the inline new-artist control reads the
	   same everywhere (manager select, default-artist select, bulk bar). */
	.new-artist-btn {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex-shrink: 0;
		font-size: 12px; padding: 3px 10px; border-radius: var(--radius-pill);
		border: 1px dashed var(--border); background: none; color: var(--primary); cursor: pointer;
	}
	.new-artist-btn:hover { border-color: var(--primary); }
	.upload-zone {
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
		padding: 24px; border: 2px dashed var(--border); border-radius: var(--radius-s);
		color: var(--muted-foreground); cursor: pointer; font-size: 13px; transition: border-color 0.15s;
		min-height: 80px;
	}
	.upload-zone.multi { width: 100%; }
	.upload-zone:hover { border-color: var(--primary); }
	.remove-btn {
		display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
		background: none; color: var(--muted-foreground); border: 1px solid var(--border);
		border-radius: var(--radius-xs); cursor: pointer; flex-shrink: 0;
	}
	.remove-btn:hover { color: var(--destructive); border-color: var(--destructive); }
	.sticker-list { display: flex; flex-direction: column; gap: 10px; }
	.sticker-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-s); transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s; background: var(--background); }
	.sticker-row.selected { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
	/* The row being dragged dims; the row it would drop onto gets a primary outline +
	   tint so the landing spot is obvious. */
	.sticker-row.dragging { opacity: 0.4; }
	.sticker-row.drop-target { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--background)); }
	.drag-handle {
		display: flex; align-items: center; justify-content: center; width: 24px; align-self: stretch;
		padding: 0; background: none; border: none; color: var(--muted-foreground);
		cursor: grab; touch-action: none; flex-shrink: 0;
	}
	.drag-handle:hover { color: var(--foreground); }
	.drag-handle:active { cursor: grabbing; }
	.drag-handle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: var(--radius-xs); }
	.sticker-thumb { position: relative; width: 56px; height: 56px; border-radius: var(--radius-xs); background: var(--secondary); flex-shrink: 0; overflow: hidden; cursor: pointer; }
	.sticker-thumb:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
	.sticker-thumb.selected::after { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--primary) 18%, transparent); pointer-events: none; }
	.select-check {
		position: absolute; top: 4px; right: 4px; z-index: 2; width: 18px; height: 18px; border-radius: 50%;
		border: 2px solid rgba(255,255,255,0.7); background: rgba(0,0,0,0.4);
		display: flex; align-items: center; justify-content: center; color: transparent;
	}
	.select-check.on { background: var(--primary); border-color: var(--primary); color: #fff; }
	.sticker-fields { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
	/* Right-side controls (NSFW + delete) vertically centered against the row so they
	   read as one neat cluster rather than the delete-top / NSFW-bottom stagger. */
	.row-controls { display: flex; align-items: center; gap: 10px; align-self: center; flex-shrink: 0; }
	.nsfw-check { white-space: nowrap; color: var(--muted-foreground); }
	.input.sm { font-size: 12px; padding: 5px 8px; }
	.muted { color: var(--muted-foreground); font-size: 13px; }

	/* Bulk-edit bar */
	.bulk-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; padding: 8px 12px; border: 1px dashed var(--border); border-radius: var(--radius-s); }
	.bulk-bar.active { border-style: solid; border-color: var(--primary); background: color-mix(in srgb, var(--primary) 6%, transparent); }
	.bulk-hint { font-size: 12px; color: var(--muted-foreground); }
	.bulk-count { font-size: 13px; font-weight: 600; }
	.bulk-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.bulk-managed { font-size: 12px; color: var(--muted-foreground); font-style: italic; }
	.btn-sm { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); background: var(--secondary); color: var(--foreground); cursor: pointer; }
	.btn-sm:hover:not(:disabled) { border-color: var(--primary); }
	.btn-sm:disabled { opacity: 0.45; cursor: not-allowed; }
	.bulk-div { width: 1px; height: 20px; background: var(--border); }
	.bulk-bar .link-btn { margin-left: auto; }
	.link-btn { background: none; border: none; color: var(--primary); font-size: 12px; padding: 0; cursor: pointer; }
	.link-btn:hover { text-decoration: underline; }

	/* Publish switch */
	.pub-row { display: flex; align-items: center; gap: 12px; padding-top: 14px; border-top: 1px solid var(--border); margin-top: 2px; }
	.switch-label { flex-direction: row; cursor: pointer; }
	.sr-checkbox { position: absolute; opacity: 0; width: 0; height: 0; }
	.switch-visual {
		display: inline-flex; align-items: center; width: 36px; height: 20px; flex-shrink: 0;
		border-radius: var(--radius-pill); background: var(--secondary); transition: background 0.15s;
	}
	.switch-visual::after {
		content: ''; width: 14px; height: 14px; border-radius: 50%; background: #fff;
		margin-left: 3px; transition: transform 0.15s;
	}
	.sr-checkbox:checked + .switch-visual { background: var(--primary); }
	.sr-checkbox:checked + .switch-visual::after { transform: translateX(16px); }
	.pub-text { display: flex; flex-direction: column; gap: 1px; }
	.pub-text strong { font-size: 13px; font-weight: 500; }
	.pub-text span { font-size: 11px; color: var(--muted-foreground); }

	/* Save bar */
	.save-bar {
		display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
		padding-top: 16px; border-top: 1px solid var(--border);
	}
	.save-note { font-size: 12px; color: var(--muted-foreground); }
	.save-actions { display: flex; gap: 12px; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* .sr-only comes from the global rule in app.css — no local copy. */
</style>
