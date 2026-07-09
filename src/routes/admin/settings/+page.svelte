<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import SetupDialog from '$lib/components/SetupDialog.svelte';
	import CopyCommand from '$lib/components/CopyCommand.svelte';
	import CloudflareSetupDialog from '$lib/components/CloudflareSetupDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { BACKUP_FILENAME_BASE } from '$lib/config';
	import { normalizeHex } from '$lib/color-hex';
	import { MAX_SONA_COLORS, mergeSuggestions, paletteHas } from '$lib/palette-merge';
	import { RefreshCw, Loader2, Mail, AlertTriangle, Check, X, Pipette } from 'lucide-svelte';
	import { THEMES } from '$lib/themes';
	import { LANDING_LAYOUTS } from '$lib/landing';
	import { resendSetupProgress } from '$lib/resend-setup';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	let siteName = $state(data.settings.siteName);
	let ownerName = $state(data.settings.ownerName);
	let aboutText = $state(data.settings.aboutText);
	let themeId = $state(data.settings.themeId);
	let landingLayout = $state(data.settings.landingLayout);
	let galleryDefaultSort = $state(data.settings.galleryDefaultSort);
	let splashSubtitle = $state(data.settings.splashSubtitle);
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
	let contactEmail = $state(data.settings.contactEmail);
	let privacyPolicy = $state(data.settings.privacyPolicy);
	let termsOfService = $state(data.settings.termsOfService);

	// Sona / character profile — feeds the /art page of the threePath landing.
	type SonaColor = { name: string; hex: string };
	function parseColors(raw: string): SonaColor[] {
		try {
			const a = JSON.parse(raw);
			return Array.isArray(a) ? a.filter((c) => c && typeof c.hex === 'string') : [];
		} catch {
			return [];
		}
	}
	let sonaSpecies = $state(data.settings.sonaSpecies);
	let sonaBuild = $state(data.settings.sonaBuild);
	let sonaKeyFeatures = $state(data.settings.sonaKeyFeatures);
	let sonaDos = $state(data.settings.sonaDos);
	let sonaDonts = $state(data.settings.sonaDonts);
	let colors = $state<SonaColor[]>(parseColors(data.settings.sonaColors));
	let newColorName = $state('');
	let newColorHex = $state('#888888');
	let showRefPicker = $state(false);

	// The cap (MAX_SONA_COLORS) is also enforced server-side on save.
	const paletteFull = $derived(colors.length >= MAX_SONA_COLORS);
	// Transient "already in your palette" cue for a duplicate Add color (mirrors
	// the picker's dedupe cue); the server dedupes on save as the backstop.
	let addDupHint = $state(false);
	let addDupTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(addDupTimer));
	function addColor() {
		if (paletteFull) return;
		const hex = newColorHex.trim();
		if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) return;
		if (paletteHas(colors.map((c) => c.hex), hex)) {
			addDupHint = true;
			clearTimeout(addDupTimer);
			addDupTimer = setTimeout(() => (addDupHint = false), 2500);
			return;
		}
		colors = [...colors, { name: newColorName.trim() || 'Color', hex }];
		newColorName = '';
		newColorHex = '#888888';
	}
	function removeColor(i: number) {
		colors = colors.filter((_, idx) => idx !== i);
	}
	// Hex text inputs normalize on change (#RGB / RGB / RRGGBB → #RRGGBB); an
	// invalid entry reverts to the current value instead of corrupting state.
	function setColorHex(i: number, input: HTMLInputElement) {
		const hex = normalizeHex(input.value);
		if (hex) colors = colors.map((c, idx) => (idx === i ? { ...c, hex } : c));
		input.value = hex ?? colors[i].hex;
	}
	function setNewColorHex(input: HTMLInputElement) {
		const hex = normalizeHex(input.value);
		if (hex) newColorHex = hex;
		input.value = hex ?? newColorHex;
	}
	// The ref-sheet picker commits into either an existing swatch or the
	// pending "new color" slot (named + added via the Add color button). A
	// "new" pick of a hex already in the palette is dropped — same dedupe as
	// Add all (the picker shows the "already in your palette" cue); explicit
	// overwrites of an existing slot stay unrestricted.
	function applyPickedColor(slot: number | 'new', hex: string) {
		if (slot === 'new') {
			if (paletteHas(colors.map((c) => c.hex), hex)) return;
			newColorHex = hex;
		} else colors = colors.map((c, i) => (i === slot ? { ...c, hex } : c));
	}
	// "Add all" in the picker: append every suggestion not already in the
	// palette (case-insensitive, deduped) with the same default name the
	// Add color button gives an unnamed color — up to the palette cap.
	function addAllSuggestions(hexes: string[]) {
		const toAdd = mergeSuggestions(colors.map((c) => c.hex), hexes, MAX_SONA_COLORS - colors.length);
		colors = [...colors, ...toAdd.map((hex) => ({ name: 'Color', hex }))];
	}

	let storageProvider = $state(data.settings.storageProvider);
	let r2PublicUrl = $state(data.settings.r2PublicUrl);
	let savingStorage = $state(false);
	let changingPassword = $state(false);
	let adminEmail = $state(data.adminEmail);
	let savingRecoveryEmail = $state(false);
	let showResendSetup = $state(false);
	let showCfSetup = $state(false);

	// Readiness reflects the SAVED recovery email (data.adminEmail, kept fresh by
	// the post-save load re-run), never the live input: an unsaved keystroke must
	// not flip the status to "active" while the DB is still empty (recovery would
	// look armed but be dead at lockout). A minimal shape check keeps a stray
	// non-address string from counting as "set".
	const emailSet = $derived(/\S+@\S+/.test(data.adminEmail));
	const resendProgress = $derived(
		resendSetupProgress({ resendKeySet: data.resendKeySet, adminEmailSet: emailSet })
	);
	// Progress-ring geometry: full circumference is 2·π·18 ≈ 113.1; the filled arc
	// is the done fraction, so the dash gap is the remainder.
	const RESEND_RING_C = 113.1;
	const resendRingOffset = $derived(RESEND_RING_C * (1 - resendProgress.done / resendProgress.total));

	let activeTab = $state<'site' | 'connections' | 'storage' | 'account' | 'observability'>('site');

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
		galleryDefaultSort = data.settings.galleryDefaultSort;
		splashSubtitle = data.settings.splashSubtitle;
		primaryCharacter = data.settings.primaryCharacter;
		twitterUrl = data.settings.twitterUrl;
		blueskyUrl = data.settings.blueskyUrl;
		telegramUrl = data.settings.telegramUrl;
		furAffinityUrl = data.settings.furAffinityUrl;
		furtrackUrl = data.settings.furtrackUrl;
		autoResyncEnabled = data.settings.autoResyncEnabled;
		storageProvider = data.settings.storageProvider;
		r2PublicUrl = data.settings.r2PublicUrl;
		contactEmail = data.settings.contactEmail;
		privacyPolicy = data.settings.privacyPolicy;
		termsOfService = data.settings.termsOfService;
		adminEmail = data.adminEmail;
		sonaSpecies = data.settings.sonaSpecies;
		sonaBuild = data.settings.sonaBuild;
		sonaKeyFeatures = data.settings.sonaKeyFeatures;
		sonaDos = data.settings.sonaDos;
		sonaDonts = data.settings.sonaDonts;
		colors = parseColors(data.settings.sonaColors);
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
			{#if data.observabilityEnabled}
				<button type="button" class:active={activeTab === 'observability'} onclick={() => (activeTab = 'observability')}>{m.admin_settings_tab_observability()}</button>
			{/if}
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
			<label id="primary-character" tabindex="-1">
				<span>{m.admin_setup_primary_character()}</span>
				<input type="text" class="input" bind:value={primaryCharacter} name="primaryCharacter" placeholder={m.admin_fursuit_tag_placeholder()} />
			</label>
			<label>
				<span>{m.admin_settings_contact_email()}</span>
				<input type="text" class="input" bind:value={contactEmail} name="contactEmail" placeholder="hello@example.com" />
			</label>
			{#if !contactEmail?.trim()}
				<p class="hint">{m.admin_settings_contact_email_nudge()}</p>
			{/if}
		</section>

		<section data-tab="site">
			<h2>{m.admin_settings_legal_heading()}</h2>
			<p class="section-desc">{m.admin_settings_legal_hint()}</p>
			<label>
				<span>{m.admin_settings_privacy_label()}</span>
				<textarea class="input" rows="4" name="privacyPolicy" bind:value={privacyPolicy} placeholder={m.admin_settings_legal_placeholder()}></textarea>
			</label>
			<label>
				<span>{m.admin_settings_terms_label()}</span>
				<textarea class="input" rows="4" name="termsOfService" bind:value={termsOfService} placeholder={m.admin_settings_legal_placeholder()}></textarea>
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
			<label>
				<span>{m.admin_settings_gallery_default_sort()}</span>
				<select class="input" name="galleryDefaultSort" bind:value={galleryDefaultSort}>
					<option value="newest">{m.gallery_sort_newest()}</option>
					<option value="oldest">{m.gallery_sort_oldest()}</option>
					<option value="commissioned-newest">{m.gallery_sort_commissioned_newest()}</option>
					<option value="commissioned-oldest">{m.gallery_sort_commissioned_oldest()}</option>
				</select>
			</label>
			<label>
				<span>{m.admin_settings_splash_subtitle()}</span>
				<input type="text" class="input" bind:value={splashSubtitle} name="splashSubtitle" placeholder={m.admin_settings_splash_subtitle_placeholder()} />
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

		<!-- Sona / reference profile shown on the /art page (threePath landing). -->
		<section data-tab="site">
			<h2>{m.admin_settings_sona_heading()}</h2>
			<p class="section-desc">
				{m.admin_settings_sona_desc_pre()}<a href="/art">/art</a>{m.admin_settings_sona_desc_mid1()}<code>reference</code>{m.admin_settings_sona_desc_mid2()}<a href="/admin/images">{m.admin_tab_images()}</a>{m.admin_settings_sona_desc_post()}
			</p>
			<div class="social-grid">
				<label>
					<span>{m.admin_settings_sona_species()}</span>
					<input type="text" class="input" bind:value={sonaSpecies} name="sonaSpecies" placeholder={m.admin_settings_sona_species_placeholder()} />
				</label>
				<label>
					<span>{m.admin_settings_sona_build()}</span>
					<input type="text" class="input" bind:value={sonaBuild} name="sonaBuild" placeholder={m.admin_settings_sona_build_placeholder()} />
				</label>
			</div>
			<label>
				<span>{m.admin_settings_sona_key_features()}</span>
				<input type="text" class="input" bind:value={sonaKeyFeatures} name="sonaKeyFeatures" placeholder={m.admin_settings_sona_key_features_placeholder()} />
			</label>
			<div class="social-grid">
				<label>
					<span>{m.admin_settings_sona_dos()} <small>{m.admin_settings_sona_per_line()}</small></span>
					<textarea class="input" rows="4" name="sonaDos" bind:value={sonaDos}></textarea>
				</label>
				<label>
					<span>{m.admin_settings_sona_donts()} <small>{m.admin_settings_sona_per_line()}</small></span>
					<textarea class="input" rows="4" name="sonaDonts" bind:value={sonaDonts}></textarea>
				</label>
			</div>

			<div class="palette">
				<span class="palette-label">{m.admin_settings_sona_palette()}</span>
				<div class="swatch-list">
					{#each colors as color, i}
						<div class="swatch-chip">
							<span class="swatch-dot" style="background:{color.hex}"></span>
							<span class="swatch-name">{color.name}</span>
							<input
								type="text"
								class="input hex-input"
								value={color.hex}
								placeholder="#RRGGBB"
								aria-label={m.admin_settings_sona_hex_label({ name: color.name })}
								onchange={(e) => setColorHex(i, e.currentTarget)}
							/>
							<button type="button" class="swatch-remove" aria-label={m.admin_settings_sona_remove_color()} onclick={() => removeColor(i)}>×</button>
						</div>
					{/each}
				</div>
				<div class="add-color">
					<input type="color" class="color-input" bind:value={newColorHex} aria-label={m.admin_settings_sona_pick_color()} />
					<input
						type="text"
						class="input hex-input"
						value={newColorHex}
						placeholder="#RRGGBB"
						aria-label={m.admin_settings_sona_new_hex_label()}
						onchange={(e) => setNewColorHex(e.currentTarget)}
					/>
					<input type="text" class="input" bind:value={newColorName} aria-label={m.admin_settings_sona_color_name_placeholder()} placeholder={m.admin_settings_sona_color_name_placeholder()} />
					<button type="button" class="btn btn-secondary" disabled={paletteFull} onclick={addColor}>{m.admin_settings_sona_add_color()}</button>
				</div>
				{#if paletteFull}
					<p class="hint" role="status">{m.admin_settings_sona_palette_full({ max: MAX_SONA_COLORS })}</p>
				{:else if addDupHint}
					<p class="hint" role="status">{m.admin_ref_picker_already_in_palette()}</p>
				{/if}
				{#if data.refImageSrc}
					<div>
						<button type="button" class="btn btn-secondary" onclick={() => (showRefPicker = true)}>
							<Pipette size={16} /> {m.admin_settings_sona_pick_from_ref()}
						</button>
					</div>
				{:else}
					<p class="hint">{m.admin_settings_sona_no_ref_hint()}</p>
				{/if}
				<input type="hidden" name="sonaColors" value={JSON.stringify(colors)} />
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
			<a href="/api/registry/export-artists" class="btn btn-secondary reg-download" download>
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

<form method="POST" action="?/saveSecurityEmail" class="contents" use:enhance={() => {
	savingRecoveryEmail = true;
	return async ({ result, update }) => {
		await update({ reset: false });
		savingRecoveryEmail = false;
		if (result.type === 'success') toast.success(m.admin_settings_recovery_email_saved());
		else if (result.type === 'failure' && result.data?.error) toast.error(result.data.error as string);
	};
}}>
	<section class="security-section" data-tab="account">
		<h2>{m.admin_settings_recovery_email()}</h2>
		<label>
			<span>{m.admin_settings_recovery_email()}</span>
			<input type="email" name="adminEmail" class="input" bind:value={adminEmail} autocomplete="email" placeholder="you@example.com" />
		</label>
		<div class="reset-status" aria-live="polite">
			{#if resendProgress.ready}
				<span class="status-tag active"><Check size={13} /> {m.admin_resend_status_active()}</span>
				<button type="button" class="hint-link muted" onclick={() => (showResendSetup = true)}>{m.admin_resend_setup_link_active()}</button>
			{:else}
				<span class="status-tag unset"><span class="dot"></span> {m.admin_resend_status_unset()}</span>
				<button type="button" class="hint-link" onclick={() => (showResendSetup = true)}>{m.admin_resend_setup_link_unset()}</button>
			{/if}
		</div>
		<p class="field-hint">
			{#if resendProgress.ready}
				{m.admin_resend_hint_active_a()}<code>{m.admin_login_forgot_password()}</code>{m.admin_resend_hint_active_b()}<code>RESEND_FROM</code>{m.admin_resend_hint_active_c()}
			{:else}
				{m.admin_resend_hint_unset_a()}<code>RESEND_API_KEY</code>{m.admin_resend_hint_unset_b()}
			{/if}
		</p>
		<button type="submit" class="btn btn-secondary" disabled={savingRecoveryEmail}>
			{savingRecoveryEmail ? m.admin_saving() : m.admin_settings_save_recovery_email()}
		</button>
	</section>
</form>

{#if showResendSetup}
	<SetupDialog title={m.admin_resend_setup_title()} sub={m.admin_resend_setup_sub()} onclose={() => (showResendSetup = false)}>
		{#snippet icon()}<Mail size={15} />{/snippet}

		<div class="status-strip">
			<div class="status-ring" class:ready={resendProgress.ready}>
				<svg width="42" height="42" viewBox="0 0 42 42" aria-hidden="true">
					<circle cx="21" cy="21" r="18" fill="none" stroke="var(--secondary)" stroke-width="4" />
					<circle cx="21" cy="21" r="18" fill="none" class="ring-fill" stroke-width="4" stroke-linecap="round" stroke-dasharray={RESEND_RING_C} stroke-dashoffset={resendRingOffset} transform="rotate(-90 21 21)" />
				</svg>
				<span class="frac">{resendProgress.done}/{resendProgress.total}</span>
			</div>
			<div class="status-copy" aria-live="polite">
				<div class="st-title">{resendProgress.ready ? m.admin_resend_setup_ready_title() : m.admin_resend_setup_pending_title()}</div>
				<div class="st-sub">{resendProgress.ready ? m.admin_resend_setup_ready_sub() : m.admin_resend_setup_pending_sub()}</div>
			</div>
		</div>

		<p class="lede">{m.admin_resend_setup_lede()}</p>

		<div class="checklist">
			<!-- Step 1: account — no direct config, but a set API key implies an
			     account exists, so mark it done by inference in that case. -->
			<div class="item" class:done={data.resendKeySet}>
				<span class="mark" class:done={data.resendKeySet} class:info={!data.resendKeySet}>
					{#if data.resendKeySet}<Check size={18} />{:else}<span class="dot"></span>{/if}
				</span>
				<div class="body">
					<div class="title">{m.admin_resend_setup_s1_title()}</div>
					<div class="text">{m.admin_resend_setup_s1_text_a()}<a href="https://resend.com" target="_blank" rel="noopener">resend.com</a>{m.admin_resend_setup_s1_text_b()}</div>
				</div>
				{#if data.resendKeySet}
					<span class="chip set">{m.admin_resend_setup_chip_done()} <Check size={11} /></span>
				{/if}
			</div>

			<!-- Step 2: RESEND_API_KEY secret (required). -->
			<div class="item" class:done={data.resendKeySet} class:pending={!data.resendKeySet}>
				<span class="mark" class:done={data.resendKeySet} class:pending={!data.resendKeySet}>
					{#if data.resendKeySet}<Check size={18} />{:else}<span class="ring-dot"></span>{/if}
				</span>
				<div class="body">
					<div class="title">{m.admin_resend_setup_s2_title()}</div>
					<div class="text">{m.admin_resend_setup_s2_text_a()}<strong>{m.admin_resend_setup_s2_create()}</strong>{m.admin_resend_setup_s2_text_b()}<code>re_</code>{m.admin_resend_setup_s2_text_c()}</div>
					<CopyCommand text="npx wrangler pages secret put RESEND_API_KEY --project-name <your-project>" />
					<div class="text note">{m.admin_resend_setup_s2_note()}</div>
				</div>
				<span class="chip" class:set={data.resendKeySet} class:unset={!data.resendKeySet}>
					{data.resendKeySet ? m.admin_resend_setup_chip_set() : m.admin_resend_setup_chip_unset()}
					{#if data.resendKeySet}<Check size={11} />{:else}<X size={11} />{/if}
				</span>
			</div>

			<!-- Step 3: recovery email (required) — the SAVED value from the field above. -->
			<div class="item" class:done={emailSet} class:pending={!emailSet}>
				<span class="mark" class:done={emailSet} class:pending={!emailSet}>
					{#if emailSet}<Check size={18} />{:else}<span class="ring-dot"></span>{/if}
				</span>
				<div class="body">
					<div class="title">{m.admin_resend_setup_s3_title()}</div>
					<div class="text">{m.admin_resend_setup_s3_text()}</div>
				</div>
				<span class="chip" class:set={emailSet} class:unset={!emailSet}>
					{emailSet ? m.admin_resend_setup_chip_set() : m.admin_resend_setup_chip_unset()}
					{#if emailSet}<Check size={11} />{:else}<X size={11} />{/if}
				</span>
			</div>

			<!-- Step 4: RESEND_FROM (optional). -->
			<div class="item">
				<span class="mark optional"><span class="ring-dot dashed"></span></span>
				<div class="body">
					<div class="title">{m.admin_resend_setup_s4_title()} <span class="opt">{m.admin_resend_setup_s4_opt()}</span></div>
					<div class="text">{m.admin_resend_setup_s4_text_a()}<code>RESEND_FROM</code>{m.admin_resend_setup_s4_text_b()}</div>
					<CopyCommand text={"npx wrangler pages secret put RESEND_FROM --project-name <your-project>\n# value:  Your Site <you@yourdomain.com>"} />
				</div>
				<span class="chip" class:set={data.resendFromSet} class:optional={!data.resendFromSet}>
					{data.resendFromSet ? m.admin_resend_setup_chip_set() : m.admin_resend_setup_chip_optional()}
					{#if data.resendFromSet}<Check size={11} />{/if}
				</span>
			</div>
		</div>

		<div class="resend-callout">
			<AlertTriangle size={18} />
			<span><strong>{m.admin_resend_setup_callout_strong()}</strong>{m.admin_resend_setup_callout_a()}<code>onboarding@resend.dev</code>{m.admin_resend_setup_callout_b()}<code>RESEND_FROM</code>{m.admin_resend_setup_callout_c()}</span>
		</div>

		<div class="unlocks"><strong>{m.admin_resend_setup_unlocks_label()}</strong> <strong>{m.admin_login_forgot_password()}</strong>{m.admin_resend_setup_unlocks_a()}</div>
	</SetupDialog>
{/if}

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
			else if (result.type === 'failure') toast.error(result.data?.alreadyConnected ? m.admin_settings_registry_already_connected() : ((result.data?.error as string) ?? m.admin_settings_registry_connect_failed()));
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

<!-- Observability → Cloudflare edge analytics (issue #6). Secret-gated, same
     pattern as the Resend entry above: presence-only status + connect help +
     disconnect-via-secret note. The token lives in Pages secrets, not the DB, so
     there is nothing to submit here. -->
<section class="security-section" data-tab="observability" hidden={!data.observabilityEnabled}>
	<h2>{m.admin_settings_obs_heading()}</h2>
	<p class="section-desc">
		{data.cfAnalyticsConnected ? m.admin_settings_obs_lede_set() : m.admin_settings_obs_lede_unset()}
	</p>
	<div class="reset-status" aria-live="polite">
		{#if data.cfAnalyticsConnected}
			<span class="status-tag active"><Check size={13} /> {m.admin_settings_obs_status_set()}</span>
			<a class="hint-link muted" href="/admin/observability">{m.admin_settings_obs_link_set()}</a>
		{:else}
			<span class="status-tag unset"><span class="dot"></span> {m.admin_settings_obs_status_unset()}</span>
			<button type="button" class="hint-link" onclick={() => (showCfSetup = true)}>{m.admin_settings_obs_link_unset()}</button>
		{/if}
	</div>
	<p class="field-hint">
		{#if data.cfAnalyticsConnected}
			{m.admin_settings_obs_hint_set_a()}<code>wrangler pages secret delete CLOUDFLARE_ANALYTICS_TOKEN</code>{m.admin_settings_obs_hint_set_b()}
		{:else}
			{m.admin_settings_obs_hint_unset_a()}<code>Account Analytics: Read</code>{m.admin_settings_obs_hint_unset_b()}<code>pages.dev</code>{m.admin_settings_obs_hint_unset_c()}
		{/if}
	</p>
</section>
	</div>
</div>

{#if showCfSetup}
	<CloudflareSetupDialog onclose={() => (showCfSetup = false)} />
{/if}

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

{#if showRefPicker && data.refImageSrc}
	<!-- Lazy chunk: the picker (canvas + extraction code) only loads on first
	     open, so the settings page doesn't carry it. -->
	{#await import('$lib/components/RefSheetPicker.svelte') then { default: RefSheetPicker }}
		<RefSheetPicker
			src={data.refImageSrc.src}
			crossorigin={data.refImageSrc.crossorigin}
			slots={colors}
			onpick={applyPickedColor}
			onaddall={addAllSuggestions}
			onclose={() => (showRefPicker = false)}
		/>
	{/await}
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
	.settings-tabs[data-active-tab='account'] [data-tab]:not([data-tab~='account']),
	.settings-tabs[data-active-tab='observability'] [data-tab]:not([data-tab~='observability']) {
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

	.reg-download { height: auto; min-height: 40px; }
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

	/* Sona-profile palette editor. */
	.palette {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 20px;
	}

	.palette-label {
		font-size: 14px;
		font-weight: 500;
	}

	.swatch-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.swatch-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
	}

	.swatch-dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--foreground) 20%, transparent);
	}

	.swatch-name {
		font-size: 13px;
	}

	/* Hex text inputs — compact, monospace-ish via the primary font. */
	.hex-input {
		width: 92px;
		max-width: 92px;
		height: 28px;
		padding: 2px 8px;
		font-family: var(--font-primary);
		font-size: 12px;
	}

	.add-color .hex-input {
		height: 40px;
	}

	.swatch-remove {
		background: none;
		border: none;
		color: var(--muted-foreground);
		cursor: pointer;
		font-size: 16px;
		line-height: 1;
		padding: 0 2px;
	}

	.swatch-remove:hover {
		color: var(--destructive);
	}

	.add-color {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.add-color .input {
		max-width: 240px;
	}

	.color-input {
		width: 40px;
		height: 40px;
		padding: 2px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--background);
		cursor: pointer;
		flex-shrink: 0;
	}

	/* Resend password-reset setup guide (rendered inside SetupDialog). */
	.hint-link {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: #f5a623;
		font-weight: 600;
		text-decoration: underline;
		font: inherit;
		font-size: 12.5px;
		white-space: nowrap;
	}
	/* Configured-state trigger is muted (owner decision) — amber is reserved for
	   the unconfigured call-to-action. */
	.hint-link.muted { color: var(--muted-foreground); }
	.hint-link.muted:hover { color: var(--foreground); }
	/* Entry point under the recovery-email field: inline status tag + trigger. */
	.reset-status {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px 14px;
		margin-top: 10px;
	}
	.status-tag {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font: 600 12px var(--font-primary);
	}
	.status-tag .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.status-tag.unset { color: #f5a623; }
	.status-tag.unset .dot { background: #f5a623; }
	.status-tag.active { color: #4ade80; }
	.field-hint {
		font-size: 11px;
		color: var(--muted-foreground);
		margin-top: 8px;
		line-height: 1.55;
		max-width: 60ch;
	}
	.field-hint code {
		font-family: var(--font-primary);
		font-size: 0.92em;
		background: var(--secondary);
		padding: 1px 4px;
		border-radius: var(--radius-xs);
	}
	.status-strip {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 16px;
		margin-bottom: 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--background);
	}
	.status-ring {
		flex: none;
		position: relative;
		width: 42px;
		height: 42px;
	}
	.status-ring .ring-fill { stroke: #f5a623; }
	.status-ring.ready .ring-fill { stroke: #4ade80; }
	.status-ring .frac {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font: 600 11px var(--font-primary);
		color: var(--foreground);
	}
	.status-copy { min-width: 0; }
	.status-copy .st-title { font-size: 13px; font-weight: 600; }
	.status-copy .st-sub {
		font-size: 12px;
		color: var(--muted-foreground);
		margin-top: 2px;
		line-height: 1.5;
	}
	.lede {
		font-size: 12.5px;
		color: var(--muted-foreground);
		line-height: 1.6;
		margin: 0 0 16px;
	}
	.checklist { display: flex; flex-direction: column; gap: 10px; }
	.item {
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		background: var(--background);
		padding: 13px 15px;
		display: grid;
		grid-template-columns: 22px 1fr auto;
		gap: 12px;
		align-items: start;
	}
	.item.done { border-color: rgba(74, 222, 128, 0.28); }
	.item.pending { border-color: rgba(245, 166, 35, 0.3); }
	.mark { margin-top: 1px; display: flex; }
	.mark.done { color: #4ade80; }
	.mark.pending { color: #f5a623; }
	.mark.optional,
	.mark.info { color: var(--muted-foreground); }
	.mark .dot {
		width: 8px;
		height: 8px;
		margin: 6px;
		border-radius: 50%;
		background: var(--muted-foreground);
	}
	.mark .ring-dot {
		width: 16px;
		height: 16px;
		margin: 1px;
		border-radius: 50%;
		border: 2px solid currentColor;
	}
	.mark .ring-dot.dashed { border-style: dashed; }
	.item .body { min-width: 0; }
	.item .title {
		font-size: 13.5px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.item .title .opt {
		font-weight: 500;
		color: var(--muted-foreground);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.item .text {
		font-size: 12.5px;
		color: var(--muted-foreground);
		line-height: 1.55;
		margin-top: 3px;
	}
	.item .text a { color: var(--primary); text-decoration: none; }
	.item .text a:hover { text-decoration: underline; }
	.item .text code { background: var(--secondary); }
	.item .text.note { font-size: 11.5px; margin-top: 8px; opacity: 0.9; }
	.chip {
		flex: none;
		align-self: center;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font: 600 11px var(--font-primary);
		padding: 4px 9px;
		border-radius: var(--radius-pill);
		white-space: nowrap;
	}
	.chip.set { background: rgba(74, 222, 128, 0.13); color: #4ade80; }
	.chip.unset { background: rgba(245, 166, 35, 0.13); color: #f5a623; }
	.chip.optional { background: var(--secondary); color: var(--muted-foreground); }
	.resend-callout {
		display: flex;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--radius-s);
		background: rgba(245, 166, 35, 0.1);
		color: #f5a623;
		font-size: 12.5px;
		line-height: 1.55;
		margin: 18px 0 0;
	}
	.resend-callout :global(svg) { flex-shrink: 0; margin-top: 1px; }
	.resend-callout strong { color: #f7b74d; }
	.resend-callout code { background: rgba(245, 166, 35, 0.14); color: #f7b74d; }
	.unlocks {
		margin-top: 16px;
		padding: 12px 14px;
		border-left: 2px solid var(--primary);
		background: rgba(255, 132, 0, 0.06);
		font-size: 12.5px;
		color: var(--muted-foreground);
		line-height: 1.6;
		border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
	}
	.unlocks strong { color: var(--foreground); font-weight: 600; }

	/* Light theme: the amber/green used above sit at ~1.5–2:1 on the light
	   surfaces and fail WCAG. Darken to amber #8A5A00 (~5.9:1 on white) and green
	   #15803D (~5:1) for text; both clear 3:1 for the ring/dot graphics too. */
	:global([data-theme='light']) .hint-link { color: #8A5A00; }
	/* The muted (configured-state) trigger must stay muted in light theme too —
	   amber is reserved for the unconfigured CTA. */
	:global([data-theme='light']) .hint-link.muted { color: var(--muted-foreground); }
	/* Links inside checklist rows (e.g. resend.com in step 1) — same AA fix. */
	:global([data-theme='light']) .item .text a { color: #8A5A00; }
	:global([data-theme='light']) .status-tag.unset,
	:global([data-theme='light']) .status-tag.unset .dot { color: #8A5A00; }
	:global([data-theme='light']) .status-tag.unset .dot { background: #8A5A00; }
	:global([data-theme='light']) .status-tag.active,
	:global([data-theme='light']) .mark.done { color: #15803D; }
	:global([data-theme='light']) .mark.pending { color: #8A5A00; }
	:global([data-theme='light']) .status-ring .ring-fill { stroke: #8A5A00; }
	:global([data-theme='light']) .status-ring.ready .ring-fill { stroke: #15803D; }
	:global([data-theme='light']) .chip.set { color: #15803D; }
	:global([data-theme='light']) .chip.unset { color: #8A5A00; }
	:global([data-theme='light']) .resend-callout,
	:global([data-theme='light']) .resend-callout strong,
	:global([data-theme='light']) .resend-callout code { color: #8A5A00; }

	/* Narrow screens: the 22px/1fr/auto grid starves the body (CopyCommand wraps
	   one word per line). Below 480px drop to two columns and move the chip below
	   the body, leaving the body + command full-width. */
	@media (max-width: 480px) {
		.item { grid-template-columns: 22px 1fr; }
		.item .body { grid-column: 2; }
		.item .chip { grid-column: 2; justify-self: start; align-self: start; margin-top: 8px; }
	}
</style>
