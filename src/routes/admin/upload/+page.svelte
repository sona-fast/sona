<script lang="ts">
	import { enhance } from '$app/forms';
	import { CloudUpload, Check, Loader2, Plus, X } from 'lucide-svelte';
	import { tick } from 'svelte';
	import NewArtistDialog from '$lib/components/NewArtistDialog.svelte';
	import { extractImageFiles, isTextEditable, shouldHandleImagePaste } from '$lib/clipboard';
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
	let dragOver = $state(false);
	let saving = $state(false);
	let announce = $state('');
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
			const result = await uploadRes.json();
			tile.url = result.url;
			tile.status = 'done';
		} catch (e) {
			tile.error = e instanceof Error ? e.message : m.admin_upload_failed();
			tile.status = 'error';
		}
	}

	async function handleFiles(files: FileList | File[]) {
		const incoming = Array.from(files);
		const room = Math.max(0, data.maxVariantSet - tiles.length);
		const fileArray = incoming.slice(0, room);
		const skipped = incoming.length - fileArray.length;
		if (skipped > 0) {
			toast.info(m.admin_upload_over_limit({ count: skipped, max: data.maxVariantSet }));
		}
		if (fileArray.length === 0) return;

		// Reset then set on the next tick so identical consecutive adds still
		// re-announce to screen readers via the aria-live region.
		announce = '';
		await tick();
		announce = m.admin_upload_images_added({ count: fileArray.length });

		for (const file of fileArray) {
			const dims = await getImageDimensions(file);
			const tile: Tile = {
				key: tileKey++,
				fileName: file.name,
				previewUrl: URL.createObjectURL(file),
				url: '',
				width: dims.width,
				height: dims.height,
				fileSize: file.size,
				status: 'uploading',
				error: '',
				label: '',
				nsfw: false
			};
			tiles = [...tiles, tile];
			// Uploads run concurrently; each tile tracks its own progress.
			uploadOne(tiles[tiles.length - 1], file);
		}
	}

	function removeTile(key: number) {
		const idx = tiles.findIndex((t) => t.key === key);
		if (idx === -1) return;
		URL.revokeObjectURL(tiles[idx].previewUrl);
		tiles = tiles.filter((t) => t.key !== key);
		if (parentIndex >= tiles.length) parentIndex = 0;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files) {
			handleFiles(e.dataTransfer.files);
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			handleFiles(input.files);
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
		handleFiles(files);
	}

	function onArtistCreated(artist: { id: number; name: string }) {
		artistList = [...artistList, artist].sort((a, b) => a.name.localeCompare(b.name));
		selectedArtistId = String(artist.id);
		showNewArtist = false;
	}
</script>

<svelte:window onpaste={handlePaste} />

<div class="sr-only" aria-live="polite">{announce}</div>

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
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="dropzone"
			class:drag-over={dragOver}
			ondrop={handleDrop}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			onclick={() => fileInput?.click()}
			role="button"
			tabindex="0"
			onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput?.click(); }}
		>
			<CloudUpload size={40} />
			<p>{m.admin_upload_dropzone_multi({ max: data.maxVariantSet })}</p>
			<p class="dropzone-hint">{m.admin_upload_formats()}</p>
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="tile-grid"
			ondrop={handleDrop}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
		>
			{#each tiles as tile, i (tile.key)}
				<div class="tile" class:tile-error={tile.status === 'error'} class:tile-parent={isGroup && groupMode === 'new' && parentIndex === i}>
					<div class="tile-preview">
						<img src={tile.previewUrl} alt={tile.fileName} />
						<div class="tile-status">
							{#if tile.status === 'uploading'}
								<Loader2 size={16} class="spin" />
							{:else if tile.status === 'done'}
								<Check size={16} />
							{:else}
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
				<button type="button" class="tile tile-add" onclick={() => fileInput?.click()}>
					<Plus size={20} />
					<span>{m.admin_variant_add_files()}</span>
				</button>
			{/if}
		</div>
	{/if}

	<input
		type="file"
		accept="image/*"
		multiple
		bind:this={fileInput}
		onchange={handleFileSelect}
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
	</label>

	<label class="checkbox-label">
		<input type="checkbox" name="nsfw" />
		<span>{m.admin_field_mark_nsfw()}</span>
	</label>

	<label class="checkbox-label">
		<input type="checkbox" name="published" />
		<span>{m.admin_field_private()} <span class="checkbox-helper">{m.admin_field_private_hint()}</span></span>
	</label>

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
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

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
		transition: border-color 0.15s, background 0.15s;
	}

	.dropzone:hover,
	.dropzone.drag-over {
		border-color: var(--primary);
		background: rgba(255, 132, 0, 0.05);
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 12px;
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

	.tile-preview {
		position: relative;
		aspect-ratio: 1;
		border-radius: var(--radius-xs);
		overflow: hidden;
		background: var(--secondary);
	}

	.tile-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
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

	.error-text {
		color: var(--destructive);
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
