<script lang="ts">
	import { enhance } from '$app/forms';
	import { CloudUpload, Check, FileBox, Loader2, Plus, X } from 'lucide-svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import { extractImageFiles, isTextEditable, shouldHandleImagePaste } from '$lib/clipboard';
	import { dropFiles, partitionByAccept, swallowStrayFileDrop } from '$lib/drop-files';
	import { GALLERY_ACCEPT, MAX_BUFFER_BYTES } from '$lib/config';
	import { toast } from '$lib/toast.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	// A newly created artist (via the New Artist dialog) is appended here so it
	// appears in the select without a reload. `data.artists` is left untouched.
	let artistList = $state<{ id: number; name: string }[]>(
		data.artists.map((a) => ({ id: a.id, name: a.name }))
	);
	let selectedArtistId = $state('');
	let showNewArtist = $state(false);
	let saving = $state(false);
	let announce = $state('');
	// Bumped on every write so {#key} replaces the node inside the live region:
	// two identical batches say the same thing, and re-assigning text the region
	// already holds changes no DOM, so nothing would be announced. Same shape the
	// VR and sticker forms use.
	let announceUid = $state(0);
	function setAnnounce(text: string) {
		announce = text;
		announceUid++;
	}
	let fileInput: HTMLInputElement;

	type Tile = {
		key: number;
		fileName: string;
		previewUrl: string;
		url: string;
		width: number;
		height: number;
		fileSize: number;
		status: 'uploading' | 'done' | 'error';
		error: string;
		label: string;
		nsfw: boolean;
	};
	let tiles = $state<Tile[]>([]);
	let tileKey = 0;
	// Two drops can overlap: a second batch starts while the first is still
	// uploading. Only the last batch in flight writes the terminal announcement,
	// so neither closes the other out, and it carries any error either of them
	// hit. Not $state — nothing renders them.
	let inFlightBatches = 0;
	let batchHadErrors = false;
	let parentIndex = $state(0);
	// 'new' = the set becomes a new piece (one tile is the parent);
	// 'existing' = every file becomes a variant of an already-uploaded piece.
	let groupMode = $state<'new' | 'existing'>('new');
	let existingParentId = $state('');

	const isUploading = $derived(tiles.some((t) => t.status === 'uploading'));
	const allUploaded = $derived(tiles.length > 0 && tiles.every((t) => t.status === 'done'));
	const isGroup = $derived(tiles.length > 1 || groupMode === 'existing');

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				resolve({ width: img.naturalWidth, height: img.naturalHeight });
				URL.revokeObjectURL(img.src);
			};
			img.onerror = () => resolve({ width: 0, height: 0 });
			img.src = URL.createObjectURL(file);
		});
	}

	async function uploadOne(tile: Tile, file: File) {
		try {
			const checkRes = await fetch('/api/check-duplicate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileName: file.name, fileSize: file.size })
			});
			const { exists } = await checkRes.json();

			if (exists && !confirm(m.admin_upload_duplicate_confirm({ fileName: file.name }))) {
				tiles = tiles.filter((t) => t.key !== tile.key);
				return;
			}

			const fd = new FormData();
			fd.append('file', file);
			const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd });
			if (!uploadRes.ok) throw new Error(m.admin_upload_failed_status({ status: uploadRes.status }));
			// The cast validates nothing: a 2xx whose body carries no usable url
			// is a failure too (same check as the other two forms), not a tile
			// pointing at nothing.
			const { url } = (await uploadRes.json()) as { url?: unknown };
			if (typeof url !== 'string' || !url) throw new Error(m.admin_upload_failed());
			tile.url = url;
			tile.status = 'done';
		} catch (e) {
			tile.error = e instanceof Error ? e.message : m.admin_upload_failed();
			tile.status = 'error';
		}
	}

	// `rejected` holds files the accept string refused — from a drop, which the
	// attribute never constrains, or from a picker the operator switched to "All
	// files". They get a tile like an oversized file does (same slot accounting,
	// same way to dismiss) but never a dimension probe or a POST.
	async function handleFiles(files: FileList | File[], rejected: File[] = []) {
		const incoming = [
			...Array.from(files).map((file) => ({ file, badType: false })),
			...rejected.map((file) => ({ file, badType: true }))
		];
		const room = Math.max(0, data.maxVariantSet - tiles.length);
		const fileArray = incoming.slice(0, room);
		const skipped = incoming.length - fileArray.length;
		if (skipped > 0) {
			toast.info(m.admin_upload_over_limit({ count: skipped, max: data.maxVariantSet }));
		}
		if (fileArray.length === 0) return;

		// Pass 1 (synchronous): create a tile for EVERY file before any await, so
		// tiles.length reflects the whole batch at once — `room` above can't
		// over-admit a second drop that lands while this batch is still
		// uploading, and the announcement below counts tiles that really exist.
		const batch: { key: number; file: File }[] = [];
		// Every tile this call creates, in the batch or not: the terminal
		// announcement reports on all of them, so a file refused before the batch
		// opened can't be closed out as a clean finish.
		const created: number[] = [];
		for (const { file, badType } of fileArray) {
			// The two ways a file fails before it is ever sent: a type the server
			// refuses, and a size over the server's cap (which could only come back
			// as a 413, so fail it here instead of firing a doomed POST). One
			// expression drives the status, the message, and the batch below.
			const error = badType
				? m.admin_upload_error_bad_type()
				: file.size > MAX_BUFFER_BYTES
					? m.admin_upload_error_too_large({ max: formatSize(MAX_BUFFER_BYTES) })
					: '';
			const tile: Tile = {
				key: tileKey++,
				fileName: file.name,
				// A wrong-type file gets no object URL: handed to <img> it can only
				// paint the browser's broken-image glyph. Its tile shows the resting
				// surface and a file icon instead.
				previewUrl: badType ? '' : URL.createObjectURL(file),
				url: '',
				width: 0,
				height: 0,
				fileSize: file.size,
				status: error ? 'error' : 'uploading',
				error,
				label: '',
				nsfw: false
			};
			tiles = [...tiles, tile];
			created.push(tile.key);
			// A failed tile never enters the batch: no dimension probe (pass 2 would
			// decode a >64 MB image for a tile that already failed) and no doomed
			// POST. Its tile keeps 0×0 dims — it can't be saved anyway.
			if (!error) batch.push({ key: tile.key, file });
		}

		// Every file that did not enter the batch is counted, wrong-type or
		// oversized alike, so the opening announcement covers every tile this call
		// created; the mixed case is its own message so each locale can punctuate
		// the two sentences its own way.
		const notUploaded = fileArray.length - batch.length;
		setAnnounce(
			batch.length > 0 && notUploaded > 0
				? m.admin_upload_images_added_and_rejected({ added: batch.length, rejected: notUploaded })
				: batch.length > 0
					? m.admin_upload_images_added({ count: batch.length })
					: m.admin_upload_images_rejected({ count: notUploaded })
		);

		// Tiles the batch dropped — a declined duplicate, a removal mid-upload —
		// are simply gone, so only survivors can report an error.
		const createdAnError = () =>
			created.some((key) => tiles.find((t) => t.key === key)?.status === 'error');

		if (batch.length === 0) {
			// Nothing to upload, so no batch opens and no "finished" follows the
			// counts above — but a batch already in flight must not close out clean
			// when this call just put an error tile on the screen.
			if (inFlightBatches > 0 && createdAnError()) batchHadErrors = true;
			return;
		}
		// Pass 2: probe dimensions and upload. Uploads run one at a time WITHIN
		// this batch (matching VrAvatarForm's media flow) so a full batch can't
		// fire eight concurrent POSTs; a second drop mid-batch starts its own
		// loop, so the guarantee is per-invocation, not global. Each tile still
		// shows its own status. Mutate the tile via the `tiles` state proxy
		// (not the pass-1 local) so updates stay reactive.
		inFlightBatches++;
		try {
			for (const { key, file } of batch) {
				const dims = await getImageDimensions(file);
				const tile = tiles.find((t) => t.key === key);
				if (!tile) continue; // removed while the batch was still working
				tile.width = dims.width;
				tile.height = dims.height;
				await uploadOne(tile, file);
			}
		} finally {
			// The per-tile outcome is only visible as an icon or a line of text on
			// the tile, so close the batch out in the live region too (mirroring the
			// VR media flow). EVERY tile this call created counts, not just the
			// uploaded ones — a file refused before the batch opened went wrong too,
			// and calling that "finished" would be a lie.
			if (createdAnError()) batchHadErrors = true;
			inFlightBatches--;
			if (inFlightBatches === 0) {
				setAnnounce(batchHadErrors ? m.admin_upload_batch_issues() : m.admin_upload_batch_done());
				batchHadErrors = false;
			}
		}
	}

	function removeTile(key: number) {
		const idx = tiles.findIndex((t) => t.key === key);
		if (idx === -1) return;
		// A wrong-type tile never got an object URL to revoke.
		if (tiles[idx].previewUrl) URL.revokeObjectURL(tiles[idx].previewUrl);
		tiles = tiles.filter((t) => t.key !== key);
		if (parentIndex >= tiles.length) parentIndex = 0;
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			// `accept` is a filter the OS dialog can override ("All files"), so a
			// picked SVG can arrive here; partition it the same way a drop is.
			const { accepted, rejected } = partitionByAccept([...input.files], GALLERY_ACCEPT);
			handleFiles(accepted, rejected);
			input.value = '';
		}
	}

	function isEditable(el: EventTarget | null): boolean {
		return el instanceof HTMLElement && isTextEditable(el);
	}

	function handlePaste(e: ClipboardEvent) {
		// The New Artist dialog owns the clipboard while open (its name field
		// autofocuses); don't create tiles behind the modal.
		if (showNewArtist) return;
		// A save in flight is already sending these tiles; the drop zone and the
		// picker are disabled for the same reason, so paste can't be the one way in.
		if (saving) return;
		const dt = e.clipboardData;
		if (!dt) return;
		const files = extractImageFiles(dt.items);
		if (
			!shouldHandleImagePaste({
				imageCount: files.length,
				focusInEditable: isEditable(e.target)
			})
		)
			return;
		e.preventDefault();
		// Clipboard images skip the accept filter the same way a drop does — a
		// pasted SVG is a file /api/upload refuses — so partition them too.
		const { accepted, rejected } = partitionByAccept(files, GALLERY_ACCEPT);
		handleFiles(accepted, rejected);
	}

	function onArtistCreated(artist: { id: number; name: string }) {
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		selectedArtistId = String(artist.id);
		showNewArtist = false;
	}
</script>

<svelte:window onpaste={handlePaste} ondragover={swallowStrayFileDrop} ondrop={swallowStrayFileDrop} />

<!-- The region itself stays put; only the node inside it is keyed, so repeating
     an announcement still mutates the region and gets read out. -->
<div class="sr-only" aria-live="polite">{#key announceUid}<span>{announce}</span>{/key}</div>

<div class="page-header">
	<h1>{m.admin_upload_title()}</h1>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<form method="POST" use:enhance={() => {
	saving = true;
	return async ({ update }) => {
		await update();
		saving = false;
	};
}} class="upload-form">
	<input type="hidden" name="count" value={tiles.length} />
	{#if groupMode === 'new'}
		<input type="hidden" name="parentIndex" value={parentIndex} />
	{:else}
		<input type="hidden" name="existingParentId" value={existingParentId} />
	{/if}
	{#each tiles as tile, i (tile.key)}
		<input type="hidden" name="imageUrl_{i}" value={tile.url} />
		<input type="hidden" name="width_{i}" value={tile.width} />
		<input type="hidden" name="height_{i}" value={tile.height} />
		<input type="hidden" name="fileSize_{i}" value={tile.fileSize} />
	{/each}

	{#if tiles.length === 0}
		<div
			class="dropzone"
			class:disabled={saving}
			{@attach dropFiles({ accept: GALLERY_ACCEPT, onFiles: handleFiles, disabled: () => saving })}
			onclick={() => { if (!saving) fileInput?.click(); }}
			role="button"
			tabindex="0"
			aria-disabled={saving}
			onkeydown={(e) => {
				if (saving) return;
				if (e.key === 'Enter' || e.key === ' ') {
					// Space on a role="button" scrolls the page unless it's cancelled.
					if (e.key === ' ') e.preventDefault();
					fileInput?.click();
				}
			}}
		>
			<CloudUpload size={40} />
			<p>{m.admin_upload_dropzone_multi({ max: data.maxVariantSet })}</p>
			<p class="dropzone-hint">{m.admin_upload_formats()}</p>
		</div>
	{:else}
		<div
			class="tile-grid"
			{@attach dropFiles({
				accept: GALLERY_ACCEPT,
				onFiles: handleFiles,
				disabled: () => saving,
				// This zone wraps the variant label inputs, so a text drag has to
				// reach them instead of being cancelled on the way.
				passThroughNonFileDrags: true
			})}
		>
			{#each tiles as tile, i (tile.key)}
				<div class="tile" class:tile-error={tile.status === 'error'} class:tile-parent={isGroup && groupMode === 'new' && parentIndex === i}>
					<div class="tile-preview">
						{#if tile.previewUrl}
							<img src={tile.previewUrl} alt={tile.fileName} />
						{:else}
							<!-- A refused file has no preview to show; the icon stands in
							     for it and carries the file name the img alt used to. -->
							<div class="tile-placeholder" role="img" aria-label={tile.fileName}>
								<FileBox size={36} />
							</div>
						{/if}
						<div class="tile-status">
							{#if tile.status === 'uploading'}
								<Loader2 size={16} class="spin" />
							{:else if tile.status === 'done'}
								<Check size={16} />
							{:else}
								<!-- .error-text only tunes its wrapping — the status band already
								     supplies the color; the class doubles as a test hook. -->
								<span class="error-text">{tile.error}</span>
							{/if}
						</div>
						<button type="button" class="tile-remove" aria-label={m.admin_variant_remove_file()} onclick={() => removeTile(tile.key)}>
							<X size={14} />
						</button>
					</div>
					<div class="tile-meta">{tile.width} x {tile.height} &bull; {formatSize(tile.fileSize)}</div>
					{#if isGroup}
						{#if groupMode === 'new'}
							<label class="tile-parent-pick">
								<input type="radio" name="parentPick" checked={parentIndex === i} onchange={() => (parentIndex = i)} />
								<span>{m.admin_variant_parent_radio()}</span>
							</label>
						{/if}
						{#if groupMode === 'existing' || parentIndex !== i}
							<input
								type="text"
								class="input tile-label"
								name="label_{i}"
								placeholder={m.admin_variant_label_placeholder()}
								bind:value={tile.label}
							/>
							<label class="tile-nsfw">
								<input type="checkbox" name="nsfw_{i}" bind:checked={tile.nsfw} />
								<span>{m.admin_field_mark_nsfw()}</span>
							</label>
						{/if}
					{/if}
				</div>
			{/each}
			{#if tiles.length < data.maxVariantSet}
				<!-- aria-disabled rather than `disabled`, matching the dropzone: a
				     native disabled button loses focus the moment the save starts,
				     dropping the keyboard user back on <body>. The click guard is what
				     actually refuses. -->
				<button type="button" class="tile tile-add" aria-disabled={saving} onclick={() => { if (!saving) fileInput?.click(); }}>
					<Plus size={20} />
					<span>{m.admin_variant_add_files()}</span>
				</button>
			{/if}
		</div>
	{/if}

	<input
		type="file"
		accept={GALLERY_ACCEPT}
		multiple
		bind:this={fileInput}
		onchange={handleFileSelect}
		disabled={saving}
		style="display: none"
	/>

	{#if tiles.length > 0}
		<fieldset class="group-section">
			<legend>{m.admin_variant_group_legend()}</legend>
			<label class="radio-label">
				<input type="radio" checked={groupMode === 'new'} onchange={() => (groupMode = 'new')} />
				<span>{tiles.length > 1 ? m.admin_variant_group_new() : m.admin_variant_group_single()}</span>
			</label>
			<label class="radio-label">
				<input type="radio" checked={groupMode === 'existing'} onchange={() => (groupMode = 'existing')} />
				<span>{m.admin_variant_group_existing()}</span>
			</label>
			{#if groupMode === 'existing'}
				<select class="input" bind:value={existingParentId} required>
					<option value="">{m.admin_variant_pick_parent()}</option>
					{#each data.parentCandidates as candidate}
						<option value={String(candidate.id)}>{candidate.title}</option>
					{/each}
				</select>
			{/if}
		</fieldset>
	{/if}

	<h2>{m.admin_upload_image_details()}</h2>

	{#if groupMode === 'new'}
		<label>
			<span>{m.admin_field_title()}</span>
			<input type="text" class="input" placeholder={m.admin_upload_title_placeholder()} name="title" required />
			{#if tiles.length > 1}
				<small class="hint">{m.admin_variant_title_hint()}</small>
			{/if}
		</label>
	{/if}

	<fieldset class="artist-section">
		<legend>{m.admin_field_artist()}</legend>
		<label>
			<span>{m.admin_field_artist()}</span>
			<select class="input" name="artistId" bind:value={selectedArtistId} required>
				<option value="">{m.admin_upload_select_artist()}</option>
				{#each artistList as artist}
					<option value={artist.id}>{artist.name}</option>
				{/each}
			</select>
		</label>
		<button type="button" class="add-artist-btn" onclick={() => (showNewArtist = true)}>
			<Plus size={14} /> {m.admin_upload_add_new_artist()}
		</button>
	</fieldset>

	<div class="row">
		<label class="flex-1">
			<span>{m.admin_field_collection()}</span>
			<select class="input" name="collectionId">
				<option value="">{m.admin_upload_no_collection()}</option>
				{#each data.collections as collection}
					<option value={collection.id}>{collection.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex-1">
			<span>{m.admin_field_tags()}</span>
			<input type="text" class="input" placeholder={m.admin_upload_tags_placeholder()} name="tags" />
			{#if data.tags.length > 0}
				<small class="hint">{m.admin_upload_existing_tags({ tags: data.tags.map((t) => t.name).join(', ') })}</small>
			{/if}
		</label>
	</div>

	{#if data.characters.length > 0}
		<div class="field">
			<span class="field-label">{m.gallery_featured_characters()}</span>
			<div class="character-chips">
				{#each data.characters as char}
					<label class="chip">
						<input type="checkbox" name="char-{char.id}" onchange={(e) => {
							const el = document.querySelector('input[name="characters"]') as HTMLInputElement;
							const current = new Set(el.value.split(',').filter(Boolean));
							if (e.currentTarget.checked) current.add(String(char.id));
							else current.delete(String(char.id));
							el.value = Array.from(current).join(',');
						}} />
						<span>{char.name}</span>
						{#if char.ownerName}<span class="chip-owner">({char.ownerName})</span>{/if}
					</label>
				{/each}
			</div>
			<input type="hidden" name="characters" value="" />
		</div>
	{/if}

	<label>
		<span>{m.admin_field_commissioned_date()}</span>
		<input type="date" class="input" name="commissionedAt" />
		<small class="hint">{m.admin_hint_commissioned_date()}</small>
	</label>

	<label class="checkbox-label">
		<input type="checkbox" name="nsfw" />
		<span>{m.admin_field_mark_nsfw()}</span>
	</label>

	<label class="checkbox-label">
		<input type="checkbox" name="published" />
		<span>{m.admin_field_private()} <span class="checkbox-helper">{m.admin_field_private_hint()}</span></span>
	</label>

	{#if data.ownerCharacter}
		<label class="checkbox-label">
			<input type="checkbox" name="useAsReference" />
			<span>{m.admin_image_reference_set({ name: data.ownerCharacter.name })}{#if data.ownerCharacter.hasReference} <span class="checkbox-helper">{m.admin_image_reference_replaces()}</span>{/if}</span>
		</label>
	{/if}

	<label>
		<span>{m.admin_field_source_url()}</span>
		<input type="url" class="input" placeholder={m.admin_upload_source_placeholder()} name="sourcePostUrl" />
	</label>

	<div class="form-actions">
		<a href="/admin/images" class="btn btn-secondary">{m.admin_cancel()}</a>
		<button type="submit" class="btn btn-primary" disabled={!allUploaded || isUploading || saving}>
			{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_upload_submit()}{/if}
		</button>
	</div>
</form>

{#if showNewArtist}
	<NewArtistDialog
		registryEnabled={data.registryEnabled}
		oncreated={onArtistCreated}
		oncancel={() => (showNewArtist = false)}
	/>
{/if}

<style>

	.page-header {
		margin-bottom: 24px;
	}

	h1 {
		font-size: 24px;
	}

	.error {
		color: var(--destructive);
		font-size: 14px;
		margin-bottom: 16px;
	}

	.upload-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 800px;
	}

	.upload-form h2 {
		font-size: 18px;
	}

	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 48px;
		border: 2px dashed var(--border);
		border-radius: var(--radius-s);
		text-align: center;
		color: var(--muted-foreground);
		font-size: 14px;
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
	}

	.dropzone:hover {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* Highlight while a file is dragged over the zone (SONA-216) — :global
	   because the drop attachment sets the class imperatively, so Svelte can't
	   see it in the markup. Same treatment as the VR and sticker zones. */
	.dropzone:global(.drag-over) {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* No pointer-events: none — the attachment has to receive dragover/drop to
	   preventDefault, or a drop while the save is in flight navigates away from
	   the form. The zone only shows this state when every tile was removed
	   after submitting; it still refuses the drop either way. */
	.dropzone.disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* Keeping pointer events also keeps :hover alive, so hold the resting look
	   while the zone is busy rather than inviting a click it won't take. */
	.dropzone.disabled:hover {
		border-color: var(--border);
		background-color: transparent;
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 12px;
		/* A transparent resting border reserves the space the drag-over highlight
		   paints into, so dragging over the grid doesn't shift the tiles. */
		border: 2px dashed transparent;
		border-radius: var(--radius-s);
		transition: border-color 0.15s, background-color 0.15s;
	}

	.tile-grid:global(.drag-over) {
		border-color: var(--primary);
		background-color: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	/* While the whole grid is the drop target, the add tile's own dashed border
	   sits 12px inside the grid's and reads as a second, competing zone. */
	.tile-grid:global(.drag-over) .tile-add {
		border-color: transparent;
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--card);
	}

	.tile-parent {
		border-color: var(--primary);
	}

	.tile-error {
		border-color: var(--destructive);
	}

	/* The two error bands are tinted differently (a placeholder tile mixes in
	   --destructive, an image tile keeps the black band for contrast over
	   artwork), so give both the same destructive edge to read as one treatment. */
	.tile-error .tile-status {
		border-top: 2px solid var(--destructive);
	}

	.tile-preview {
		position: relative;
		aspect-ratio: 1;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
	}

	/* A placeholder tile has no picture for the band to sit over, and its error
	   line runs to four lines in ja — as an overlay the band covered the icon.
	   Stack the two in normal flow instead, so the band takes the height it needs
	   and the icon keeps what's left. Scoped by :has() so an <img> tile is
	   untouched: there the band still floats over the picture. */
	.tile-preview:has(.tile-placeholder) {
		display: flex;
		flex-direction: column;
	}

	/* The band is also tinted toward --destructive here so the failure reads
	   without parsing the text. Only here: the backdrop is the known tile
	   surface, where white on this mix measures 6.3:1 to 7.4:1 across the six
	   themes. Over an image preview the backdrop is the artwork, and on a white
	   one the same mix falls to 4.2:1 — under AA, and worse than the plain black
	   band's 5.7:1 — so image tiles keep the black band. */
	.tile-preview:has(.tile-placeholder) .tile-status {
		position: static;
		margin-top: auto;
		background: color-mix(in srgb, var(--destructive) 55%, rgba(0, 0, 0, 0.6));
	}

	.tile-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* Stand-in for a refused file, which gets no object URL to preview. Takes the
	   height the band above leaves rather than the whole preview box. */
	.tile-placeholder {
		display: flex;
		flex: 1;
		min-height: 0;
		align-items: center;
		justify-content: center;
		width: 100%;
		color: var(--muted-foreground);
	}

	.tile-status {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 4px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 11px;
	}

	/* Error text wraps to several lines in a narrow tile; even it out rather than
	   leaving a one-word last line. */
	.error-text {
		text-wrap: pretty;
	}

	.tile-remove {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius-pill);
		background: rgba(0, 0, 0, 0.6);
		color: white;
		cursor: pointer;
	}

	.tile-remove:hover {
		background: var(--destructive);
		color: var(--destructive-foreground);
	}

	.tile-meta {
		font-size: 11px;
		color: var(--muted-foreground);
		word-break: break-all;
	}

	.tile-parent-pick,
	.tile-nsfw {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.tile-parent-pick input,
	.tile-nsfw input {
		width: 14px;
		height: 14px;
	}

	.tile-parent .tile-parent-pick {
		color: var(--primary);
		font-weight: 500;
	}

	.tile-label {
		font-size: 12px;
		padding: 6px 8px;
	}

	.tile-add {
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 160px;
		border-style: dashed;
		background: none;
		color: var(--muted-foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
	}

	.tile-add:hover {
		border-color: var(--primary);
		color: var(--primary);
	}

	/* Mirrors .dropzone.disabled — the other way into the picker has to read as
	   unavailable while the save is in flight, not just refuse the click. */
	.tile-add[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* aria-disabled leaves the button hoverable, so undo exactly what :hover
	   above sets and hold the resting look. */
	.tile-add[aria-disabled='true']:hover {
		border-color: var(--border);
		color: var(--muted-foreground);
	}

	.group-section {
		gap: 10px;
	}

	.radio-label {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		cursor: pointer;
	}

	.radio-label input {
		width: 15px;
		height: 15px;
	}

	.dropzone-hint {
		font-size: 12px;
		color: var(--muted-foreground);
		word-break: break-all;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label > span {
		font-size: 14px;
		font-weight: 500;
	}

	.hint {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	legend {
		font-size: 14px;
		font-weight: 500;
		padding: 0 8px;
	}

	.add-artist-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: none;
		color: var(--foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
	}

	.add-artist-btn:hover {
		border-color: var(--primary);
		color: var(--primary);
	}

	.row {
		display: flex;
		gap: 16px;
	}

	.flex-1 {
		flex: 1;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-label {
		font-size: 14px;
		font-weight: 500;
	}

	.character-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		font-size: 13px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.chip:has(input:checked) {
		background: var(--primary);
		color: var(--primary-foreground);
	}

	.chip input {
		display: none;
	}

	.chip-owner {
		color: var(--muted-foreground);
		font-size: 11px;
	}

	.chip:has(input:checked) .chip-owner {
		color: var(--primary-foreground);
		opacity: 0.7;
	}

	.checkbox-label {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.checkbox-label input {
		width: 16px;
		height: 16px;
	}

	.checkbox-helper {
		color: var(--muted-foreground);
		font-size: 12px;
		margin-left: 4px;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding-top: 8px;
	}

	.form-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 768px) {
		.page-header {
			display: none;
		}

		.dropzone {
			padding: 32px 16px;
		}

		.tile-grid {
			grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		}

		.row {
			flex-direction: column;
		}

		.form-actions {
			flex-direction: column-reverse;
		}

		.form-actions .btn {
			width: 100%;
		}
	}
</style>
