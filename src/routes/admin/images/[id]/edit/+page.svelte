<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import { Loader2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let artistMode = $state<'existing' | 'new'>('existing');
	let saving = $state(false);
	let selectedParentId = $state(String(data.image.parentImageId ?? ''));
	// The reference button swaps between set/clear on toggle; move focus back to it
	// so keyboard/screen-reader users hear the new state instead of losing focus.
	let referenceButton = $state<HTMLButtonElement | null>(null);
</script>

<div class="page-header">
	<h1>{m.admin_image_edit_title()}</h1>
</div>

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

<div class="edit-layout">
	<div class="edit-sidebar">
		<div class="image-preview">
			<img src={data.image.imageUrl} alt={data.image.title} />
		</div>

		{#if data.ownerCharacter}
			<form method="POST" action="?/reference" use:enhance={() => {
				return async ({ update, result }) => {
					await update();
					await tick();
					if (result.type === 'success') referenceButton?.focus();
				};
			}} class="reference-control">
				<!-- Persistent live region: text toggles in place (rather than the node
				     being inserted/removed) so NVDA/JAWS announce the state change reliably. -->
				<p class="reference-current" role="status">
					{#if data.ownerCharacter.isReference}✓ {m.admin_image_reference_current({ name: data.ownerCharacter.name })}{/if}
				</p>
				{#if data.ownerCharacter.isReference}
					<input type="hidden" name="clear" value="on" />
					<button bind:this={referenceButton} type="submit" class="btn btn-secondary reference-btn">{m.admin_image_reference_clear()}</button>
				{:else}
					<button bind:this={referenceButton} type="submit" class="btn btn-secondary reference-btn">{m.admin_image_reference_set({ name: data.ownerCharacter.name })}</button>
					{#if data.ownerCharacter.replacesOther}
						<small class="hint">{m.admin_image_reference_replaces()}</small>
					{/if}
				{/if}
			</form>
		{/if}
	</div>

	<form method="POST" action="?/save" use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update();
			saving = false;
		};
	}} class="edit-form">
		<label>
			<span>{m.admin_field_title()}</span>
			<input type="text" class="input" name="title" value={data.image.title} required />
		</label>

		<fieldset class="artist-section">
			<legend>{m.admin_field_artist()}</legend>
			<div class="artist-toggle">
				<button
					type="button"
					class="toggle-btn"
					class:active={artistMode === 'existing'}
					onclick={() => (artistMode = 'existing')}
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
							<option value={artist.id} selected={artist.id === data.image.artistId}>{artist.name}</option>
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
						<option value={collection.id} selected={collection.id === data.image.collectionId}>{collection.name}</option>
					{/each}
				</select>
			</label>
			<label class="flex-1">
				<span>{m.admin_field_tags()}</span>
				<input type="text" class="input" name="tags" value={data.imageTags.join(', ')} />
				{#if data.tags.length > 0}
					<small class="hint">{m.admin_upload_existing_tags({ tags: data.tags.map((t) => t.name).join(', ') })}</small>
				{/if}
			</label>
		</div>

		{#if data.hasVariants}
			<p class="hint">{m.admin_variant_parent_hint()}</p>
		{:else}
			<div class="row">
				<label class="flex-1">
					<span>{m.admin_field_variant_of()}</span>
					<select class="input" name="parentImageId" bind:value={selectedParentId}>
						<option value="">{m.admin_variant_none()}</option>
						{#each data.parentCandidates as candidate}
							<option value={String(candidate.id)}>{candidate.title}</option>
						{/each}
					</select>
				</label>
				{#if selectedParentId}
					<label class="flex-1">
						<span>{m.admin_field_variant_label()}</span>
						<input
							type="text"
							class="input"
							name="variantLabel"
							placeholder={m.admin_variant_label_placeholder()}
							value={data.image.variantLabel || ''}
						/>
					</label>
				{/if}
			</div>
		{/if}

		{#if data.characters.length > 0}
			<div class="field">
				<span class="field-label">{m.gallery_featured_characters()}</span>
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
			<span>{m.admin_field_commissioned_date()}</span>
			<input type="date" class="input" name="commissionedAt" value={data.image.commissionedAt || ''} />
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="nsfw" checked={data.image.nsfw} />
			<span>{m.admin_field_mark_nsfw()}</span>
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="published" checked={!data.image.published} />
			<span>{m.admin_field_private()} <span class="checkbox-helper">{m.admin_field_private_hint()}</span></span>
		</label>

		<label class="checkbox-label">
			<input type="checkbox" name="featured" checked={data.image.featured} />
			<span>{m.admin_field_featured()}</span>
		</label>

		<label>
			<span>{m.admin_field_featured_order()}</span>
			<input type="number" class="input" name="featuredOrder" value={data.image.featuredOrder ?? ''} />
			<small class="hint">{m.admin_field_featured_order_hint()}</small>
		</label>

		<label>
			<span>{m.admin_field_source_url()}</span>
			<input type="url" class="input" name="sourcePostUrl" value={data.image.sourcePostUrl || ''} />
		</label>

		<div class="form-actions">
			<a href="/admin/images" class="btn btn-secondary">{m.admin_cancel()}</a>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{#if saving}<Loader2 size={16} class="spin" /> {m.admin_saving()}{:else}{m.admin_save_changes()}{/if}
			</button>
		</div>
	</form>
</div>

<style>
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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

	.edit-sidebar {
		display: flex;
		flex-direction: column;
	}

	.reference-control {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}

	.reference-current {
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
	}

	/* Desktop: size to content in the narrow sidebar column, not a full-width pill.
	   Mobile keeps the full-width button (restored in the media query below). The
	   long "use as reference sheet" label can wrap in the 300px column — left-align
	   the wrapped lines instead of the button's default centering. */
	.reference-btn {
		align-self: flex-start;
		text-align: left;
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

		.reference-btn {
			align-self: stretch;
		}
	}
</style>
