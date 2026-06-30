<script lang="ts">
	import { enhance } from '$app/forms';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data, form } = $props();

	let siteName = $state(data.settings.siteName);
	let aboutText = $state(data.settings.aboutText);
	let primaryCharacter = $state(data.settings.primaryCharacter);
	let twitterUrl = $state(data.settings.twitterUrl);
	let blueskyUrl = $state(data.settings.blueskyUrl);
	let telegramUrl = $state(data.settings.telegramUrl);
	let furAffinityUrl = $state(data.settings.furAffinityUrl);
	let furtrackUrl = $state(data.settings.furtrackUrl);
	let autoResyncEnabled = $state(data.settings.autoResyncEnabled);

	let storageProvider = $state(data.settings.storageProvider);
	let r2PublicUrl = $state(data.settings.r2PublicUrl);
	let savingStorage = $state(false);

	// Usage bar reflects the ACTIVE provider. R2 has no simple usage API, so we use
	// the DB-tracked total (every image is on the active store) against the 10GB free tier.
	const R2_FREE_LIMIT = 10 * 1024 * 1024 * 1024;
	const activeUsage = $derived(
		data.settings.storageProvider === 'r2'
			? { label: 'Cloudflare R2', used: data.totalSize, limit: R2_FREE_LIMIT }
			: data.utUsage
				? { label: 'UploadThing', used: data.utUsage.usedBytes, limit: data.utUsage.limitBytes }
				: null
	);
	// Originals still sitting on UploadThing after migrating to R2.
	const utLeftover = $derived(
		data.settings.storageProvider === 'r2' && data.utUsage && data.utUsage.usedBytes > 0
			? data.utUsage.usedBytes
			: 0
	);

	let confirmingAction = $state<'deleteAll' | 'clearCache' | 'resetTags' | null>(null);
	let actionMessage = $state('');
	let actionError = $state('');

	let saving = $state(false);
	let exportForm: HTMLFormElement;
	let deleteAllForm: HTMLFormElement;
	let clearCacheForm: HTMLFormElement;
	let resetTagsForm: HTMLFormElement;

	// Sync from server when data changes (after form submission)
	$effect(() => {
		siteName = data.settings.siteName;
		aboutText = data.settings.aboutText;
		primaryCharacter = data.settings.primaryCharacter;
		twitterUrl = data.settings.twitterUrl;
		blueskyUrl = data.settings.blueskyUrl;
		telegramUrl = data.settings.telegramUrl;
		furAffinityUrl = data.settings.furAffinityUrl;
		furtrackUrl = data.settings.furtrackUrl;
		autoResyncEnabled = data.settings.autoResyncEnabled;
		storageProvider = data.settings.storageProvider;
		r2PublicUrl = data.settings.r2PublicUrl;
	});

	function formatSize(bytes: number): string {
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function downloadExport(json: string) {
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `sparky-ink-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	const confirmConfig = {
		deleteAll: {
			title: 'Delete All Data',
			message: 'This will delete ALL images, collections, tags, characters, and artists. Files will also be removed from your storage (R2 and UploadThing). This cannot be undone.',
			confirmLabel: 'Delete Everything'
		},
		clearCache: {
			title: 'Clear Upload Cache',
			message: 'This will find files in your storage (R2 and UploadThing) that are no longer referenced in your database and delete them. Useful for cleaning up orphaned uploads.',
			confirmLabel: 'Clear Cache'
		},
		resetTags: {
			title: 'Reset All Tags',
			message: 'This will remove all tags from all images. Images and collections are preserved. This cannot be undone.',
			confirmLabel: 'Reset Tags'
		}
	};
</script>

<form method="POST" action="?/save" use:enhance={() => {
	saving = true;
	return async ({ result, update }) => {
		await update();
		saving = false;
		if (result.type === 'success') toast.success('Settings saved');
	};
}} class="settings-page">
	<div class="page-header">
		<h1>Settings</h1>
		<button type="submit" class="btn btn-primary" disabled={saving}>
			{saving ? 'Saving...' : 'Save Changes'}
		</button>
	</div>

	<div class="settings-form">
		<section>
			<h2>Site Information</h2>
			<label>
				<span>Site Name</span>
				<input type="text" class="input" bind:value={siteName} name="siteName" />
			</label>
			<label>
				<span>About Text</span>
				<textarea class="input" rows="4" name="aboutText" bind:value={aboutText}></textarea>
			</label>
			<label>
				<span>Primary character (FurTrack tag)</span>
				<input type="text" class="input" bind:value={primaryCharacter} name="primaryCharacter" placeholder="e.g. aspen_(zangoose)" />
			</label>
		</section>

		<section>
			<h2>Your Social Links</h2>
			<div class="social-grid">
				<label>
					<span>Twitter / X</span>
					<input type="text" class="input" bind:value={twitterUrl} name="twitter" />
				</label>
				<label>
					<span>Bluesky</span>
					<input type="text" class="input" bind:value={blueskyUrl} name="bluesky" />
				</label>
				<label>
					<span>Telegram</span>
					<input type="text" class="input" bind:value={telegramUrl} name="telegram" />
				</label>
				<label>
					<span>FurAffinity</span>
					<input type="text" class="input" bind:value={furAffinityUrl} name="furaffinity" />
				</label>
				<label>
					<span>FurTrack</span>
					<input type="text" class="input" bind:value={furtrackUrl} name="furtrack" placeholder="https://www.furtrack.com/user/yourname" />
				</label>
			</div>
		</section>

		<section>
			<h2>Telegram</h2>
			<label class="checkbox-row">
				<input type="checkbox" name="autoResyncEnabled" bind:checked={autoResyncEnabled} />
				<span class="checkbox-text">
					<span class="checkbox-title">Automatically re-sync Telegram sticker packs</span>
					<span class="checkbox-desc">When on, new stickers in your Telegram packs are pulled in daily (via a scheduled job).</span>
				</span>
			</label>
		</section>

		<section>
			<h2>Storage</h2>
			{#if activeUsage}
				{@const pct = Math.min(100, (activeUsage.used / activeUsage.limit) * 100)}
				<div class="storage-bar-wrap">
					<div class="storage-bar-header">
						<span>{activeUsage.label}: {formatSize(activeUsage.used)} of {formatSize(activeUsage.limit)}</span>
						<span class="storage-pct">{pct.toFixed(1)}%</span>
					</div>
					<div class="storage-bar">
						<div class="storage-bar-fill" style="width: {pct}%" class:warning={pct > 80} class:danger={pct > 95}></div>
					</div>
				</div>
			{/if}
			{#if utLeftover > 0}
				<p class="ut-leftover">
					UploadThing still holds {formatSize(utLeftover)} of pre-migration originals.
					Delete them on the <a href="/admin/storage/migrate">Storage Migration</a> page (Clean up) to reclaim it.
				</p>
			{/if}
			<div class="storage-info">
				<div class="storage-stat">
					<span class="stat-label">Tracked</span>
					<span class="stat-value">{formatSize(data.totalSize)}</span>
				</div>
				<div class="storage-stat">
					<span class="stat-label">Images</span>
					<span class="stat-value">{data.imageCount}</span>
				</div>
				{#if data.utUsage}
					<div class="storage-stat">
						<span class="stat-label">UT Files</span>
						<span class="stat-value">{data.utUsage.filesUploaded}</span>
					</div>
				{/if}
				<div class="storage-stat">
					<span class="stat-label">Provider</span>
					<span class="stat-value provider">{data.settings.storageProvider === 'r2' ? 'Cloudflare R2' : 'UploadThing'}</span>
				</div>
			</div>
		</section>

	</div>
</form>

<form method="POST" action="?/saveStorage" class="settings-form" use:enhance={() => {
	savingStorage = true;
	return async ({ update }) => {
		await update({ reset: false });
		savingStorage = false;
	};
}}>
	<section>
		<h2>Storage Provider</h2>
		<p class="section-desc">
			Where new images (gallery + fursuit photos) are uploaded and served. Switching only
			changes where <em>new</em> uploads go — existing images keep working. To move existing
			images too, run a migration.
		</p>
		<div class="provider-options">
			<label class="provider-card" class:selected={storageProvider === 'r2'}>
				<input type="radio" name="storageProvider" value="r2" bind:group={storageProvider} />
				<span class="provider-name">Cloudflare R2 <span class="provider-badge">Recommended</span></span>
				<span class="provider-desc">10 GB free · no egress fees</span>
				{#if data.storageStatus.r2}
					<span class="provider-status ok">● Bucket binding connected</span>
				{:else}
					<span class="provider-status bad">● Not configured — add the IMAGES R2 binding in wrangler.toml</span>
				{/if}
			</label>
			<label class="provider-card" class:selected={storageProvider === 'uploadthing'}>
				<input type="radio" name="storageProvider" value="uploadthing" bind:group={storageProvider} />
				<span class="provider-name">UploadThing</span>
				<span class="provider-desc">Hosted uploads · 2 GB free</span>
				{#if data.storageStatus.uploadthingVerified}
					<span class="provider-status ok">● Token configured & verified</span>
				{:else if data.storageStatus.uploadthing}
					<span class="provider-status warn">● Token set (couldn't verify usage)</span>
				{:else}
					<span class="provider-status bad">● Not set — add UPLOADTHING_TOKEN as a secret</span>
				{/if}
			</label>
		</div>
		{#if storageProvider === 'r2'}
			<label>
				<span>R2 public domain</span>
				<input type="text" class="input" name="r2PublicUrl" bind:value={r2PublicUrl} placeholder="https://cdn.sparky.ink" />
			</label>
		{:else}
			<input type="hidden" name="r2PublicUrl" value={r2PublicUrl} />
		{/if}
		<div class="storage-actions">
			<button type="submit" class="btn btn-primary" disabled={savingStorage}>
				{savingStorage ? 'Saving…' : 'Save storage settings'}
			</button>
			<a href="/admin/storage/migrate" class="btn btn-outline">Migrate existing images →</a>
		</div>
	</section>
</form>

<section class="danger-zone">
	<h2>Danger Zone</h2>
	<div class="danger-divider"></div>

	{#if form?.message}
		<p class="success">{form.message}</p>
	{/if}
	{#if form?.error && !form.success}
		<p class="error">{form.error}</p>
	{/if}

	<div class="export-card">
		<div class="danger-text">
			<p class="danger-title">Export data</p>
			<p class="danger-desc">Download a full backup of all images, metadata, collections, and tags as a JSON file.</p>
		</div>
		<form method="POST" action="?/export" bind:this={exportForm} use:enhance={() => {
			return async ({ result }) => {
				if (result.type === 'success' && result.data?.export) {
					downloadExport(result.data.export as string);
				}
			};
		}}>
			<button type="submit" class="btn btn-outline">Export</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">Clear all data</p>
			<p class="danger-desc">Delete all images, collections, and tags. This cannot be undone.</p>
		</div>
		<form method="POST" action="?/deleteAll" bind:this={deleteAllForm} use:enhance>
			<button type="button" class="btn btn-destructive" onclick={() => (confirmingAction = 'deleteAll')}>Delete All</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">Clear upload cache</p>
			<p class="danger-desc">Remove orphaned files from your storage (R2 and UploadThing) that are no longer referenced in your database.</p>
		</div>
		<form method="POST" action="?/clearCache" bind:this={clearCacheForm} use:enhance>
			<button type="button" class="btn btn-destructive" onclick={() => (confirmingAction = 'clearCache')}>Clear Cache</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">Reset all tags</p>
			<p class="danger-desc">Remove all tags from images. Images and collections are preserved.</p>
		</div>
		<form method="POST" action="?/resetTags" bind:this={resetTagsForm} use:enhance>
			<button type="button" class="btn btn-destructive" onclick={() => (confirmingAction = 'resetTags')}>Reset Tags</button>
		</form>
	</div>
</section>

{#if confirmingAction}
	<ConfirmDialog
		title={confirmConfig[confirmingAction].title}
		message={confirmConfig[confirmingAction].message}
		confirmLabel={confirmConfig[confirmingAction].confirmLabel}
		onconfirm={() => {
			if (confirmingAction === 'deleteAll') deleteAllForm.requestSubmit();
			else if (confirmingAction === 'clearCache') clearCacheForm.requestSubmit();
			else if (confirmingAction === 'resetTags') resetTagsForm.requestSubmit();
			confirmingAction = null;
		}}
		oncancel={() => (confirmingAction = null)}
	/>
{/if}

<style>
	.settings-page {
		display: contents;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 32px;
	}

	h1 {
		font-size: 24px;
	}

	.success {
		color: #4ade80;
		font-size: 14px;
		margin-bottom: 16px;
	}

	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 40px;
		max-width: 700px;
	}

	.section-desc {
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 16px;
		max-width: 60ch;
	}

	.provider-options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-bottom: 16px;
	}

	.provider-card {
		flex-direction: column;
		gap: 4px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.provider-card.selected {
		border-color: var(--primary, var(--foreground));
	}

	.provider-card input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.provider-name {
		font-weight: 600;
		font-size: 14px;
	}

	.provider-badge {
		display: inline-block;
		margin-left: 6px;
		padding: 1px 7px;
		border-radius: var(--radius-pill);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: var(--primary, var(--foreground));
		color: var(--background, #000);
		vertical-align: middle;
	}

	.provider-desc {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.provider-status {
		font-size: 11px;
		margin-top: 4px;
	}

	.provider-status.ok {
		color: #4ade80;
	}

	.provider-status.warn {
		color: #f5a623;
	}

	.provider-status.bad {
		color: #f87171;
	}

	.ut-leftover {
		margin-top: 10px;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.storage-actions {
		display: flex;
		gap: 12px;
		align-items: center;
		margin-top: 16px;
		flex-wrap: wrap;
	}

	section h2 {
		font-size: 16px;
		margin-bottom: 16px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* Breathing room between stacked fields within a section (the section gap only
	   separates whole sections, not the fields inside one). */
	section > label + label {
		margin-top: 20px;
	}

	label > span {
		font-size: 14px;
		font-weight: 500;
	}

	.checkbox-row {
		flex-direction: row;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}

	.checkbox-row input {
		margin-top: 2px;
	}

	.checkbox-text {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.checkbox-title {
		font-size: 14px;
		font-weight: 500;
	}

	.checkbox-desc {
		font-size: 13px;
		font-weight: 400;
		color: var(--muted-foreground);
	}

	.row {
		display: flex;
		gap: 16px;
		margin-bottom: 16px;
	}

	.flex-1 {
		flex: 1;
	}

	.social-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	textarea {
		resize: vertical;
	}

	.storage-bar-wrap {
		margin-bottom: 12px;
	}

	.storage-bar-header {
		display: flex;
		justify-content: space-between;
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 6px;
	}

	.storage-pct {
		font-family: var(--font-primary);
		font-weight: 600;
		color: var(--foreground);
	}

	.storage-bar {
		width: 100%;
		height: 8px;
		background: var(--secondary);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}

	.storage-bar-fill {
		height: 100%;
		background: var(--primary);
		transition: width 0.3s ease;
	}

	.storage-bar-fill.warning {
		background: #f0b33a;
	}

	.storage-bar-fill.danger {
		background: var(--destructive);
	}

	.storage-info {
		display: flex;
		gap: 32px;
		padding: 16px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.storage-stat {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.stat-label {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.stat-value {
		font-size: 18px;
		font-family: var(--font-primary);
		font-weight: 600;
	}

	.provider {
		color: var(--primary);
	}

	.danger-zone {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.danger-zone h2 {
		color: var(--destructive);
		margin-bottom: 0;
	}

	.danger-divider {
		height: 1px;
		background: var(--destructive);
	}

	.export-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.danger-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border: 1px solid var(--destructive);
		border-radius: var(--radius-s);
	}

	.danger-text {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.danger-title {
		font-size: 14px;
		font-weight: 600;
	}

	.danger-desc {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	@media (max-width: 768px) {
		.page-header h1 {
			display: none;
		}

		.row {
			flex-direction: column;
			margin-bottom: 0;
		}

		.social-grid {
			grid-template-columns: 1fr;
		}

		.storage-info {
			flex-direction: column;
			gap: 12px;
		}

		.export-card,
		.danger-card {
			flex-direction: column;
			align-items: stretch;
			gap: 12px;
		}

		.export-card .btn,
		.danger-card .btn {
			width: 100%;
		}
	}
</style>
