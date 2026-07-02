<script lang="ts">
	import { enhance } from '$app/forms';
	import { CloudUpload, Check, Loader2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let artistMode = $state<'existing' | 'new'>(data.artists.length > 0 ? 'existing' : 'new');
	let imageUrl = $state('');
	let imageWidth = $state(0);
	let imageHeight = $state(0);
	let fileSize = $state(0);
	let uploadStatus = $state<'idle' | 'uploading' | 'done' | 'error'>('idle');
	let uploadError = $state('');
	let dragOver = $state(false);
	let isUploading = $state(false);
	let saving = $state(false);
	let previewUrl = $state('');
	let fileInput: HTMLInputElement;

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

	async function handleFiles(files: FileList | File[]) {
		const fileArray = Array.from(files);
		if (fileArray.length === 0) return;

		const file = fileArray[0];
		fileSize = file.size;

		// Create local preview
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = URL.createObjectURL(file);

		const dims = await getImageDimensions(file);
		imageWidth = dims.width;
		imageHeight = dims.height;

		// Check for duplicate before uploading
		uploadStatus = 'uploading';
		uploadError = '';
		isUploading = true;

		try {
			const checkRes = await fetch('/api/check-duplicate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileName: file.name, fileSize: file.size })
			});
			const { exists } = await checkRes.json();

			if (exists && !confirm(m.admin_upload_duplicate_confirm({ fileName: file.name }))) {
				uploadStatus = 'idle';
				isUploading = false;
				previewUrl = '';
				return;
			}

			const fd = new FormData();
			fd.append('file', file);
			const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd });
			if (!uploadRes.ok) throw new Error(m.admin_upload_failed_status({ status: uploadRes.status }));
			const result = await uploadRes.json();
			imageUrl = result.url;
			uploadStatus = 'done';
		} catch (e) {
			uploadError = e instanceof Error ? e.message : m.admin_upload_failed();
			uploadStatus = 'error';
		} finally {
			isUploading = false;
		}
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
		}
	}
</script>

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
	<input type="hidden" name="imageUrl" value={imageUrl} />
	<input type="hidden" name="width" value={imageWidth} />
	<input type="hidden" name="height" value={imageHeight} />
	<input type="hidden" name="fileSize" value={fileSize} />

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="dropzone"
		class:drag-over={dragOver}
		class:uploaded={uploadStatus === 'done'}
		class:error={uploadStatus === 'error'}
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		onclick={() => fileInput?.click()}
		role="button"
		tabindex="0"
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput?.click(); }}
	>
		{#if previewUrl}
			<div class="preview-container">
				<img src={previewUrl} alt={m.admin_upload_preview_alt()} class="preview-image" />
				<div class="preview-overlay">
					{#if uploadStatus === 'uploading'}
						<Loader2 size={24} class="spin" />
						<span>{m.admin_upload_uploading()}</span>
					{:else if uploadStatus === 'done'}
						<Check size={24} />
						<span>{m.admin_upload_uploaded()}</span>
					{:else if uploadStatus === 'error'}
						<span class="error-text">{uploadError}</span>
					{/if}
				</div>
			</div>
			<p class="dropzone-hint">{imageWidth} x {imageHeight} &bull; {formatSize(fileSize)}</p>
			<p class="dropzone-hint">{m.admin_upload_replace_hint()}</p>
		{:else if uploadStatus === 'error'}
			<CloudUpload size={40} />
			<p class="error-text">{uploadError}</p>
			<p class="dropzone-hint">{m.admin_upload_retry_hint()}</p>
		{:else}
			<CloudUpload size={40} />
			<p>{m.admin_upload_dropzone()}</p>
			<p class="dropzone-hint">{m.admin_upload_formats()}</p>
		{/if}
	</div>

	<input
		type="file"
		accept="image/*"
		bind:this={fileInput}
		onchange={handleFileSelect}
		style="display: none"
	/>

	<h2>{m.admin_upload_image_details()}</h2>

	<label>
		<span>{m.admin_field_title()}</span>
		<input type="text" class="input" placeholder={m.admin_upload_title_placeholder()} name="title" required />
	</label>

	<fieldset class="artist-section">
		<legend>{m.admin_field_artist()}</legend>
		<div class="artist-toggle">
			<button
				type="button"
				class="toggle-btn"
				class:active={artistMode === 'existing'}
				onclick={() => (artistMode = 'existing')}
				disabled={data.artists.length === 0}
			>
				{m.admin_upload_select_existing()}
			</button>
			<button
				type="button"
				class="toggle-btn"
				class:active={artistMode === 'new'}
				onclick={() => (artistMode = 'new')}
			>
				{m.admin_upload_add_new_artist()}
			</button>
		</div>

		{#if artistMode === 'existing'}
			<label>
				<span>{m.admin_field_artist()}</span>
				<select class="input" name="artistId" required>
					<option value="">{m.admin_upload_select_artist()}</option>
					{#each data.artists as artist}
						<option value={artist.id}>{artist.name}</option>
					{/each}
				</select>
			</label>
		{:else}
			<input type="hidden" name="artistId" value="new" />
			<label>
				<span>{m.admin_field_artist_name()}</span>
				<input type="text" class="input" placeholder={m.admin_upload_artist_name_placeholder()} name="artistName" required />
			</label>
			<div class="social-grid">
				<label>
					<span>Twitter/X</span>
					<input type="text" class="input" placeholder={m.admin_social_handle_placeholder()} name="twitter" />
				</label>
				<label>
					<span>Bluesky</span>
					<input type="text" class="input" placeholder="bsky.app/profile/..." name="bluesky" />
				</label>
				<label>
					<span>Telegram</span>
					<input type="text" class="input" placeholder="t.me/..." name="telegram" />
				</label>
				<label>
					<span>FurAffinity</span>
					<input type="text" class="input" placeholder="furaffinity.net/user/..." name="furaffinity" />
				</label>
				<label>
					<span>DeviantArt</span>
					<input type="text" class="input" placeholder="deviantart.com/..." name="deviantart" />
				</label>
				<label>
					<span>Patreon</span>
					<input type="text" class="input" placeholder="patreon.com/..." name="patreon" />
				</label>
				<label>
					<span>Instagram</span>
					<input type="text" class="input" placeholder="instagram.com/..." name="instagram" />
				</label>
			</div>
		{/if}
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
		<button type="submit" class="btn btn-primary" disabled={!imageUrl || isUploading || saving}>
			{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_upload_submit()}{/if}
		</button>
	</div>
</form>

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
		transition: border-color 0.15s, background 0.15s;
	}

	.dropzone:hover,
	.dropzone.drag-over {
		border-color: var(--primary);
		background: rgba(255, 132, 0, 0.05);
	}

	.dropzone.uploaded {
		border-color: #4ade80;
		color: #4ade80;
	}

	.dropzone.error {
		border-color: var(--destructive);
	}

	.preview-container {
		position: relative;
		max-width: 300px;
		max-height: 200px;
		border-radius: var(--radius-xs);
		overflow: hidden;
	}

	.preview-image {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.preview-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 6px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 13px;
		font-family: var(--font-primary);
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

	.artist-toggle {
		display: flex;
		gap: 4px;
		background: var(--secondary);
		border-radius: var(--radius-pill);
		padding: 4px;
		width: fit-content;
	}

	.toggle-btn {
		padding: 6px 16px;
		border-radius: var(--radius-pill);
		border: none;
		background: none;
		color: var(--muted-foreground);
		font-size: 13px;
		font-family: var(--font-primary);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.toggle-btn.active {
		background: var(--background);
		color: var(--foreground);
	}

	.toggle-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.social-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
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

		.social-grid {
			grid-template-columns: 1fr;
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
