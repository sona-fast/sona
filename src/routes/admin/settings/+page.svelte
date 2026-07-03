<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { BACKUP_FILENAME_BASE } from '$lib/config';
	import { RefreshCw, Loader2 } from 'lucide-svelte';
	import { THEMES } from '$lib/themes';
	import { LANDING_LAYOUTS } from '$lib/landing';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let siteName = $state(data.settings.siteName);
	let ownerName = $state(data.settings.ownerName);
	let aboutText = $state(data.settings.aboutText);
	let themeId = $state(data.settings.themeId);
	let landingLayout = $state(data.settings.landingLayout);
	let registryOverridesLocal = $state(data.settings.registryOverridesLocal);
	let syncing = $state(false);
	let connectingRegistry = $state(false);
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
	let changingPassword = $state(false);

	let activeTab = $state<'site' | 'connections' | 'storage' | 'account'>('site');

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
	// Which danger-zone / export action is in flight (disables + labels
	// its button while the form round-trips).
	let runningAction = $state<'deleteAll' | 'clearCache' | 'resetTags' | 'export' | null>(null);
	let disconnecting = $state(false);
	let actionMessage = $state('');
	let actionError = $state('');

	let savingSite = $state(false);
	let savingConnections = $state(false);
	let exportForm: HTMLFormElement;
	let deleteAllForm: HTMLFormElement;
	let clearCacheForm: HTMLFormElement;
	let resetTagsForm: HTMLFormElement;

	// Sync from server when data changes (after form submission).
	// registryOverridesLocal is intentionally NOT resynced here: a registry sync
	// reloads `data` too, and resyncing would discard an unsaved toggle of this
	// checkbox mid-sync. It's seeded once above and only changes when the user
	// edits it or saves (after which local already equals server).
	$effect(() => {
		siteName = data.settings.siteName;
		ownerName = data.settings.ownerName;
		aboutText = data.settings.aboutText;
		themeId = data.settings.themeId;
		landingLayout = data.settings.landingLayout;
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
		a.download = `${BACKUP_FILENAME_BASE}-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	const confirmConfig = {
		deleteAll: {
			title: m.admin_settings_delete_all_title,
			message: m.admin_settings_delete_all_message,
			confirmLabel: m.admin_settings_delete_all_confirm
		},
		clearCache: {
			title: m.admin_settings_clear_cache_title,
			message: m.admin_settings_clear_cache_message,
			confirmLabel: m.admin_settings_clear_cache_confirm
		},
		resetTags: {
			title: m.admin_settings_reset_tags_title,
			message: m.admin_settings_reset_tags_message,
			confirmLabel: m.admin_settings_reset_tags_confirm
		}
	};
</script>

<div class="settings-tabs" data-active-tab={activeTab}>
	<div class="settings-header">
		<div class="page-header">
			<h1>{m.admin_nav_settings()}</h1>
		</div>
		<nav class="settings-tabnav">
			<button type="button" class:active={activeTab === 'site'} onclick={() => (activeTab = 'site')}>{m.admin_settings_tab_site()}</button>
			<button type="button" class:active={activeTab === 'connections'} onclick={() => (activeTab = 'connections')}>{m.admin_settings_tab_connections()}</button>
			<button type="button" class:active={activeTab === 'storage'} onclick={() => (activeTab = 'storage')}>{m.admin_settings_tab_storage()}</button>
			<button type="button" class:active={activeTab === 'account'} onclick={() => (activeTab = 'account')}>{m.admin_settings_tab_account()}</button>
		</nav>
	</div>

	<div class="settings-panels">
<form method="POST" action="?/saveSite" class="contents" use:enhance={() => {
	savingSite = true;
	return async ({ result, update }) => {
		// reset: false — keep the bound inputs; the $effect above rebinds them
		// from the reloaded data, so saved values never visually revert.
		await update({ reset: false });
		savingSite = false;
		if (result.type === 'success') toast.success(m.admin_settings_saved());
	};
}}>
		<section data-tab="site">
			<h2>{m.admin_settings_site_info()}</h2>
			<label>
				<span>{m.admin_settings_site_name()}</span>
				<input type="text" class="input" bind:value={siteName} name="siteName" />
			</label>
			<label>
				<span>{m.admin_settings_owner_name()}</span>
				<input type="text" class="input" bind:value={ownerName} name="ownerName" placeholder={m.admin_settings_owner_placeholder()} />
			</label>
			<label>
				<span>{m.admin_settings_about_text()}</span>
				<textarea class="input" rows="4" name="aboutText" bind:value={aboutText}></textarea>
			</label>
			<label>
				<span>{m.admin_setup_primary_character()}</span>
				<input type="text" class="input" bind:value={primaryCharacter} name="primaryCharacter" placeholder={m.admin_fursuit_tag_placeholder()} />
			</label>
		</section>

		<section data-tab="site">
			<h2>{m.admin_setup_appearance()}</h2>
			<label>
				<span>{m.admin_setup_theme()}</span>
				<select class="input" name="themeId" bind:value={themeId}>
					{#each THEMES as t}
						<option value={t.id}>{t.label}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>{m.admin_setup_landing_layout()}</span>
				<select class="input" name="landingLayout" bind:value={landingLayout}>
					{#each LANDING_LAYOUTS as l}
						<option value={l.id}>{l.label}</option>
					{/each}
				</select>
			</label>
		</section>

		<section data-tab="site">
			<h2>{m.admin_settings_social_links()}</h2>
			<div class="social-grid">
				<label>
					<span>Twitter / X</span>
					<input type="text" class="input" bind:value={twitterUrl} name="twitter" placeholder="https://twitter.com/yourname" />
				</label>
				<label>
					<span>Bluesky</span>
					<input type="text" class="input" bind:value={blueskyUrl} name="bluesky" placeholder="https://bsky.app/profile/yourname.bsky.social" />
				</label>
				<label>
					<span>Telegram</span>
					<input type="text" class="input" bind:value={telegramUrl} name="telegram" placeholder="https://t.me/yourname" />
				</label>
				<label>
					<span>FurAffinity</span>
					<input type="text" class="input" bind:value={furAffinityUrl} name="furaffinity" placeholder="https://www.furaffinity.net/user/yourname" />
				</label>
				<label>
					<span>FurTrack</span>
					<input type="text" class="input" bind:value={furtrackUrl} name="furtrack" placeholder="https://www.furtrack.com/user/yourname" />
				</label>
			</div>
		</section>

		<div class="tab-actions" data-tab="site">
			<button type="submit" class="btn btn-primary" disabled={savingSite}>
				{savingSite ? m.admin_saving() : m.admin_settings_save_site()}
			</button>
		</div>
</form>

<form method="POST" action="?/saveConnections" class="contents" use:enhance={() => {
	savingConnections = true;
	return async ({ result, update }) => {
		await update({ reset: false });
		savingConnections = false;
		if (result.type === 'success') toast.success(m.admin_settings_saved());
	};
}}>
		<section data-tab="connections">
			<h2>Telegram</h2>
			<label class="checkbox-row">
				<input type="checkbox" name="autoResyncEnabled" bind:checked={autoResyncEnabled} />
				<span class="checkbox-text">
					<span class="checkbox-title">{m.admin_settings_auto_resync()}</span>
					<span class="checkbox-desc">{m.admin_settings_auto_resync_desc()}</span>
				</span>
			</label>
		</section>

		<section data-tab="connections">
			<h2>{m.admin_settings_registry()}</h2>
			{#if data.registryEnabled}
				<p class="reg-status connected">{m.admin_settings_registry_connected()}</p>
				<label class="checkbox-row">
					<input type="checkbox" name="registryOverridesLocal" bind:checked={registryOverridesLocal} />
					<span class="checkbox-text">
						<span class="checkbox-title">{m.admin_settings_registry_overrides()}</span>
						<span class="checkbox-desc">{m.admin_settings_registry_overrides_desc()}</span>
					</span>
				</label>
			{:else}
				<p class="reg-status">{m.admin_settings_registry_not_connected()}</p>
			{/if}
			<a href="/api/registry/export-artists" class="btn btn-secondary" download>
				{m.admin_settings_registry_download()}
			</a>
		</section>

		<div class="tab-actions" data-tab="connections">
			<button type="submit" class="btn btn-primary" disabled={savingConnections}>
				{savingConnections ? m.admin_saving() : m.admin_settings_save_connections()}
			</button>
		</div>
</form>

		<!-- Read-only usage/stats — not part of any save form. -->
		<section data-tab="storage">
			<h2>{m.admin_settings_tab_storage()}</h2>
			{#if activeUsage}
				{@const pct = Math.min(100, (activeUsage.used / activeUsage.limit) * 100)}
				<div class="storage-bar-wrap">
					<div class="storage-bar-header">
						<span>{m.admin_settings_usage({ label: activeUsage.label, used: formatSize(activeUsage.used), limit: formatSize(activeUsage.limit) })}</span>
						<span class="storage-pct">{pct.toFixed(1)}%</span>
					</div>
					<div class="storage-bar">
						<div class="storage-bar-fill" style="width: {pct}%" class:warning={pct > 80} class:danger={pct > 95}></div>
					</div>
				</div>
			{/if}
			{#if utLeftover > 0}
				<p class="ut-leftover">
					{m.admin_settings_ut_leftover_pre({ size: formatSize(utLeftover) })}<a href="/admin/storage/migrate">{m.admin_settings_ut_leftover_link()}</a>{m.admin_settings_ut_leftover_post()}
				</p>
			{/if}
			<div class="storage-info">
				<div class="storage-stat">
					<span class="stat-label">{m.admin_settings_stat_tracked()}</span>
					<span class="stat-value">{formatSize(data.totalSize)}</span>
				</div>
				<div class="storage-stat">
					<span class="stat-label">{m.admin_tab_images()}</span>
					<span class="stat-value">{data.imageCount}</span>
				</div>
				{#if data.utUsage}
					<div class="storage-stat">
						<span class="stat-label">{m.admin_settings_stat_ut_files()}</span>
						<span class="stat-value">{data.utUsage.filesUploaded}</span>
					</div>
				{/if}
				<div class="storage-stat">
					<span class="stat-label">{m.admin_settings_stat_provider()}</span>
					<span class="stat-value provider">{data.settings.storageProvider === 'r2' ? 'Cloudflare R2' : 'UploadThing'}</span>
				</div>
			</div>
		</section>

<form method="POST" action="?/saveStorage" class="contents" use:enhance={() => {
	savingStorage = true;
	return async ({ update }) => {
		await update({ reset: false });
		savingStorage = false;
	};
}}>
	<section data-tab="storage">
		<h2>{m.admin_settings_provider_heading()}</h2>
		<p class="section-desc">
			{m.admin_settings_provider_desc_pre()}<code>IMAGES</code>{m.admin_settings_provider_desc_mid1()}<code>UPLOADTHING_TOKEN</code>{m.admin_settings_provider_desc_mid2()}<em>{m.admin_settings_provider_desc_em()}</em>{m.admin_settings_provider_desc_post()}
		</p>
		<div class="provider-options">
			<label class="provider-card" class:selected={storageProvider === 'r2'}>
				<input type="radio" name="storageProvider" value="r2" bind:group={storageProvider} />
				<span class="provider-name">Cloudflare R2 <span class="provider-badge">{m.admin_settings_recommended()}</span></span>
				<span class="provider-desc">{m.admin_settings_r2_desc()}</span>
				{#if data.storageStatus.r2}
					<span class="provider-status ok">● {m.admin_settings_r2_connected()}</span>
				{:else}
					<span class="provider-status bad">● {m.admin_settings_r2_not_configured()}</span>
				{/if}
			</label>
			<label class="provider-card" class:selected={storageProvider === 'uploadthing'}>
				<input type="radio" name="storageProvider" value="uploadthing" bind:group={storageProvider} />
				<span class="provider-name">UploadThing</span>
				<span class="provider-desc">{m.admin_settings_ut_desc()}</span>
				{#if data.storageStatus.uploadthingVerified}
					<span class="provider-status ok">● {m.admin_settings_ut_verified()}</span>
				{:else if data.storageStatus.uploadthing}
					<span class="provider-status warn">● {m.admin_settings_ut_unverified()}</span>
				{:else}
					<span class="provider-status bad">● {m.admin_settings_ut_not_set()}</span>
				{/if}
			</label>
		</div>
		{#if storageProvider === 'r2'}
			<label>
				<span>{m.admin_settings_r2_domain()}</span>
				<input type="text" class="input" name="r2PublicUrl" bind:value={r2PublicUrl} placeholder="https://cdn.example.com" />
			</label>
			{#if !r2PublicUrl?.trim()}
				<p class="hint">{m.admin_settings_r2_no_url_hint()}</p>
			{/if}
		{:else}
			<input type="hidden" name="r2PublicUrl" value={r2PublicUrl} />
		{/if}
		<div class="storage-actions">
			<button type="submit" class="btn btn-primary" disabled={savingStorage}>
				{savingStorage ? m.admin_saving() : m.admin_settings_save_storage()}
			</button>
			<a href="/admin/storage/migrate" class="btn btn-outline">{m.admin_settings_migrate_link()} →</a>
		</div>
	</section>
</form>

<form method="POST" action="?/changePassword" class="contents" use:enhance={() => {
	changingPassword = true;
	return async ({ result, update }) => {
		await update({ reset: result.type === 'success' });
		changingPassword = false;
		if (result.type === 'success') toast.success(m.admin_settings_password_changed());
		else if (result.type === 'failure') toast.error((result.data?.error as string) ?? m.admin_settings_password_failed());
	};
}}>
	<section class="security-section" data-tab="account">
		<h2>{m.admin_settings_security()}</h2>
		<label>
			<span>{m.admin_settings_current_password()}</span>
			<input type="password" name="currentPassword" class="input" required autocomplete="current-password" />
		</label>
		<label>
			<span>{m.admin_settings_new_password()}</span>
			<input type="password" name="newPassword" class="input" required minlength="8" autocomplete="new-password" />
		</label>
		<label>
			<span>{m.admin_settings_confirm_new_password()}</span>
			<input type="password" name="confirmPassword" class="input" required minlength="8" autocomplete="new-password" />
		</label>
		<button type="submit" class="btn btn-secondary" disabled={changingPassword}>
			{changingPassword ? m.admin_settings_changing() : m.admin_settings_change_password()}
		</button>
	</section>
</form>

{#if data.registryEnabled}
	<form method="POST" action="?/syncNow" class="contents" use:enhance={() => {
		syncing = true;
		return async ({ result, update }) => {
			await update();
			syncing = false;
			if (result.type === 'success') toast.success((result.data?.syncMessage as string) ?? m.admin_settings_sync_complete());
			else if (result.type === 'failure') toast.error((result.data?.error as string) ?? m.admin_settings_sync_failed());
		};
	}}>
		<section data-tab="connections">
			<h2>{m.admin_settings_registry_sync()}</h2>
			<p class="reg-status">{m.admin_settings_registry_sync_desc()}</p>
			<button type="submit" class="btn btn-secondary" disabled={syncing}>
				{#if syncing}<Loader2 size={16} class="spin" /> {m.admin_settings_syncing()}{:else}<RefreshCw size={16} /> {m.admin_settings_sync_now()}{/if}
			</button>
		</section>
	</form>
{/if}

{#if data.registryHasSecret}
	<div class="contents">
		<section data-tab="connections">
			<h2>{m.admin_settings_registry_connection()}</h2>
			<p class="reg-status connected">{m.admin_settings_registry_secret_pre()}<code>REGISTRY_API_KEY</code>{m.admin_settings_registry_secret_post()}</p>
		</section>
	</div>
{:else if data.registryEnabled}
	<form method="POST" action="?/disconnectRegistry" class="contents" use:enhance={() => {
		disconnecting = true;
		return async ({ result }) => {
			disconnecting = false;
			if (result.type === 'success') { toast.success(m.admin_settings_registry_disconnected()); await invalidateAll(); }
			else toast.error(m.admin_settings_registry_disconnect_failed());
		};
	}}>
		<section data-tab="connections">
			<h2>{m.admin_settings_registry_connection()}</h2>
			<p class="reg-status">{m.admin_settings_registry_forkkey_desc()}</p>
			<p class="section-desc">
				{m.admin_settings_registry_disconnect_desc()}
			</p>
			<button type="submit" class="btn btn-secondary" disabled={disconnecting || syncing}>
				{disconnecting ? m.admin_settings_disconnecting() : m.admin_settings_registry_disconnect()}
			</button>
		</section>
	</form>
{:else}
	<form method="POST" action="?/connectRegistry" class="contents" use:enhance={() => {
		connectingRegistry = true;
		return async ({ result }) => {
			connectingRegistry = false;
			if (result.type === 'success') { toast.success(m.admin_settings_registry_connected_toast()); await invalidateAll(); }
			else if (result.type === 'failure') toast.error((result.data?.error as string) ?? m.admin_settings_registry_connect_failed());
		};
	}}>
		<section data-tab="connections">
			<h2>{m.admin_settings_registry_connect_heading()}</h2>
			<p class="section-desc">
				{m.admin_settings_registry_connect_desc()}
			</p>
			<label>
				<span>{m.admin_settings_invite_token()}</span>
				<input type="text" name="signupToken" class="input" placeholder={m.admin_settings_invite_token_placeholder()} required />
			</label>
			<details class="reg-advanced">
				<summary>{m.admin_settings_registry_advanced()}</summary>
				<label>
					<span>{m.admin_settings_registry_url()}</span>
					<input type="url" name="registryUrl" class="input" placeholder={m.admin_settings_registry_url_placeholder()} />
				</label>
				<p class="hint">{m.admin_settings_registry_url_hint()}</p>
			</details>
			<button type="submit" class="btn btn-primary" disabled={connectingRegistry}>
				{connectingRegistry ? m.admin_settings_connecting() : m.admin_settings_connect_registry()}
			</button>
			<p class="hint">
				{m.admin_settings_forkkey_hint()}
			</p>
		</section>
	</form>
{/if}

<section class="danger-zone" data-tab="account">
	<h2>{m.admin_settings_danger_zone()}</h2>
	<div class="danger-divider"></div>

	{#if form?.message}
		<p class="success">{form.message}</p>
	{/if}
	{#if form?.error && !form.success}
		<p class="error">{form.error}</p>
	{/if}

	<div class="export-card">
		<div class="danger-text">
			<p class="danger-title">{m.admin_settings_export_title()}</p>
			<p class="danger-desc">{m.admin_settings_export_desc()}</p>
		</div>
		<form method="POST" action="?/export" bind:this={exportForm} use:enhance={() => {
			runningAction = 'export';
			return async ({ result }) => {
				runningAction = null;
				if (result.type === 'success' && result.data?.export) {
					downloadExport(result.data.export as string);
				}
			};
		}}>
			<button type="submit" class="btn btn-outline" disabled={runningAction === 'export'}>
				{runningAction === 'export' ? m.admin_settings_exporting() : m.admin_settings_export()}
			</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">{m.admin_settings_clear_all_title()}</p>
			<p class="danger-desc">{m.admin_settings_clear_all_desc()}</p>
		</div>
		<form method="POST" action="?/deleteAll" bind:this={deleteAllForm} use:enhance={() => {
			return async ({ update }) => {
				await update();
				runningAction = null;
			};
		}}>
			<button type="button" class="btn btn-destructive" disabled={runningAction === 'deleteAll'} onclick={() => (confirmingAction = 'deleteAll')}>
				{runningAction === 'deleteAll' ? m.admin_migrate_deleting() : m.admin_settings_delete_all()}
			</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">{m.admin_settings_clear_cache_card_title()}</p>
			<p class="danger-desc">{m.admin_settings_clear_cache_card_desc()}</p>
		</div>
		<form method="POST" action="?/clearCache" bind:this={clearCacheForm} use:enhance={() => {
			return async ({ update }) => {
				await update();
				runningAction = null;
			};
		}}>
			<button type="button" class="btn btn-destructive" disabled={runningAction === 'clearCache'} onclick={() => (confirmingAction = 'clearCache')}>
				{runningAction === 'clearCache' ? m.admin_settings_clearing() : m.admin_settings_clear_cache_confirm()}
			</button>
		</form>
	</div>

	<div class="danger-card">
		<div class="danger-text">
			<p class="danger-title">{m.admin_settings_reset_tags_card_title()}</p>
			<p class="danger-desc">{m.admin_settings_reset_tags_card_desc()}</p>
		</div>
		<form method="POST" action="?/resetTags" bind:this={resetTagsForm} use:enhance={() => {
			return async ({ update }) => {
				await update();
				runningAction = null;
			};
		}}>
			<button type="button" class="btn btn-destructive" disabled={runningAction === 'resetTags'} onclick={() => (confirmingAction = 'resetTags')}>
				{runningAction === 'resetTags' ? m.admin_settings_resetting() : m.admin_settings_reset_tags_confirm()}
			</button>
		</form>
	</div>
</section>
	</div>
</div>

{#if confirmingAction}
	<ConfirmDialog
		title={confirmConfig[confirmingAction].title()}
		message={confirmConfig[confirmingAction].message()}
		confirmLabel={confirmConfig[confirmingAction].confirmLabel()}
		onconfirm={() => {
			runningAction = confirmingAction;
			if (confirmingAction === 'deleteAll') deleteAllForm.requestSubmit();
			else if (confirmingAction === 'clearCache') clearCacheForm.requestSubmit();
			else if (confirmingAction === 'resetTags') resetTagsForm.requestSubmit();
			confirmingAction = null;
		}}
		oncancel={() => (confirmingAction = null)}
	/>
{/if}

<style>
	.contents {
		display: contents;
	}

	.settings-header {
		max-width: 700px;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.settings-tabnav {
		display: flex;
		border-bottom: 1px solid var(--border);
		margin-bottom: 28px;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
	}
	.settings-tabnav::-webkit-scrollbar {
		display: none;
	}
	.settings-tabnav button {
		position: relative;
		flex: none;
		background: none;
		border: none;
		cursor: pointer;
		padding: 10px 4px;
		margin-right: 14px;
		font-family: var(--font-primary);
		font-size: 14px;
		font-weight: 500;
		color: var(--muted-foreground);
		white-space: nowrap;
	}
	.settings-tabnav button:hover {
		color: var(--foreground);
	}
	.settings-tabnav button.active {
		color: var(--foreground);
	}
	.settings-tabnav button.active::after {
		content: '';
		position: absolute;
		left: 0;
		right: 14px;
		bottom: -1px;
		height: 2px;
		background: var(--primary);
		border-radius: 2px;
	}

	.settings-panels {
		display: flex;
		flex-direction: column;
		gap: 40px;
		max-width: 700px;
	}

	/* Tabbed grouping: hide only the sections that don't belong to the active
	   tab, so visible sections keep their own display (e.g. flex .danger-zone). */
	.settings-tabs[data-active-tab='site'] [data-tab]:not([data-tab~='site']),
	.settings-tabs[data-active-tab='connections'] [data-tab]:not([data-tab~='connections']),
	.settings-tabs[data-active-tab='storage'] [data-tab]:not([data-tab~='storage']),
	.settings-tabs[data-active-tab='account'] [data-tab]:not([data-tab~='account']) {
		display: none;
	}

	h1 {
		font-size: 24px;
	}

	.success {
		color: #4ade80;
		font-size: 14px;
		margin-bottom: 16px;
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

	/* Same rhythm between the last password field and its submit button. */
	.security-section > .btn {
		margin-top: 20px;
	}

	/* Per-tab save row (site / connections). */
	.tab-actions {
		display: flex;
		justify-content: flex-end;
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

	.reg-status {
		font-size: 13px;
		color: var(--muted-foreground);
		margin: 0 0 12px;
		line-height: 1.5;
	}
	.reg-status.connected {
		color: var(--primary);
	}
	.reg-status code {
		font-family: var(--font-primary);
		font-size: 0.9em;
		background: var(--secondary);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
	}
	.reg-advanced {
		margin: 4px 0 8px;
	}
	.reg-advanced summary {
		font-size: 13px;
		color: var(--muted-foreground);
		cursor: pointer;
		margin-bottom: 10px;
	}
	.hint {
		font-size: 12px;
		color: var(--muted-foreground);
		margin: 8px 0 0;
		line-height: 1.5;
	}
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
