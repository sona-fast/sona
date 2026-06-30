<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let artistMode = $state<'existing' | 'new'>('existing');
</script>

<div class="page-header">
	<h1>Edit Image</h1>
</div>

{#if form?.error}
	<p class="error">{form.error}</p>
{/if}

<div class="edit-layout">
	<div class="image-preview">
		<img src={data.image.imageUrl} alt={data.image.title} />
	</div>

	<form method="POST" use:enhance class="edit-form">
		<label>
			<span>Title</span>
			<input type="text" class="input" name="title" value={data.image.title} required />
		</label>

		<fieldset class="artist-section">
			<legend>Artist</legend>
			<div class="artist-toggle">
				<button
					type="button"
					class="toggle-btn"
					class:active={artistMode === 'existing'}
					onclick={() => (artistMode = 'existing')}
				>
					Select Existing
				</button>
				<button
					type="button"
					class="toggle-btn"
					class:active={artistMode === 'new'}
					onclick={() => (artistMode = 'new')}
				>
					Add New Artist
				</button>
			</div>

			{#if artistMode === 'existing'}
				<label>
					<span>Artist</span>
					<select class="input" name="artistId" required>
						<option value="">Select artist...</option>
						{#each data.artists as artist}
							<option value={artist.id} selected={artist.id === data.image.artistId}>{artist.name}</option>
						{/each}
					</select>
				</label>
			{:else}
				<input type="hidden" name="artistId" value="new" />
				<label>
					<span>Artist Name</span>
					<input type="text" class="input" placeholder="Artist name..." name="artistName" required />
				</label>
				<div class="social-grid">
					<label>
						<span>Twitter/X</span>
						<input type="text" class="input" placeholder="@handle or URL" name="twitter" />
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
				<span>Collection</span>
				<select class="input" name="collectionId">
					<option value="">No collection</option>
					{#each data.collections as collection}
						<option value={collection.id} selected={collection.id === data.image.collectionId}>{collection.name}</option>
					{/each}
				</select>
			</label>
			<label class="flex-1">
				<span>Tags</span>
				<input type="text" class="input" name="tags" value={data.imageTags.join(', ')} />
				{#if data.tags.length > 0}
					<small class="hint">Existing: {data.tags.map((t) => t.name).join(', ')}</small>
				{/if}
			</label>
		</div>

		{#if data.characters.length > 0}
			<div class="field">
				<span class="field-label">Featured Characters</span>
				<div class="character-chips">
					{#each data.characters as char}
						<label class="chip">
							<input type="checkbox" name="char-{char.id}" checked={data.imageCharacterIds.includes(char.id)} onchange={(e) => {
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
				<input type="hidden" name="characters" value={data.imageCharacterIds.join(',')} />
			</div>
		{/if}

		<label>
			<span>Commissioned Date</span>
			<input type="date" class="input" name="commissionedAt" value={data.image.commissionedAt || ''} />
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="nsfw" checked={data.image.nsfw} />
			<span>Mark as NSFW</span>
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="published" checked={!data.image.published} />
			<span>Private <span class="checkbox-helper">(not shown in gallery)</span></span>
		</label>

		<label>
			<span>Source Post URL</span>
			<input type="url" class="input" name="sourcePostUrl" value={data.image.sourcePostUrl || ''} />
		</label>

		<div class="form-actions">
			<a href="/admin/images" class="btn btn-secondary">Cancel</a>
			<button type="submit" class="btn btn-primary">Save Changes</button>
		</div>
	</form>
</div>

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

	.edit-layout {
		display: grid;
		grid-template-columns: 300px 1fr;
		gap: 32px;
		align-items: start;
	}

	.image-preview {
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.image-preview img {
		width: 100%;
		display: block;
	}

	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: 600px;
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

	@media (max-width: 768px) {
		.page-header {
			display: none;
		}

		.edit-layout {
			grid-template-columns: 1fr;
			gap: 20px;
		}

		.image-preview {
			max-height: 200px;
		}

		.image-preview img {
			object-fit: contain;
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

		.form-actions .btn,
		.form-actions a {
			width: 100%;
			text-align: center;
		}
	}
</style>
