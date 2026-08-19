<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/stores';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import SetupDialog from '$lib/components/SetupDialog.svelte';
	import CopyCommand from '$lib/components/CopyCommand.svelte';
	import CloudflareSetupDialog from '$lib/components/CloudflareSetupDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { BACKUP_FILENAME_BASE, R2_FREE_TIER_BYTES } from '$lib/config';
	import { normalizeHex } from '$lib/color-hex';
	import { MAX_SONA_COLORS, mergeSuggestions, paletteHas } from '$lib/palette-merge';
	import { RefreshCw, Loader2, Mail, AlertTriangle, Check, X, Pipette } from 'lucide-svelte';
	import { THEMES } from '$lib/themes';
	import { LANDING_LAYOUTS } from '$lib/landing';
	import { resendSetupProgress } from '$lib/resend-setup';
	import { resolveTabId, visibleTabIds, type TabId } from './tabs';
	import { showUtFileStat } from './ut-stat';
	import { breakdownRows, sharePct, usageWarning } from './storage-breakdown-view';
	import { baseLocale, locales } from '$lib/paraglide/runtime';
	import { earlyAccessLabel, isFeatureEnabled } from '$lib/early-access';
	import * as m from '$lib/paraglide/messages';

	// Endonyms for the email-language options — a language name reads the same
	// regardless of the admin's UI locale, so it's a small in-component map (same
	// pattern as LanguageToggle), not a translated message key.
	const localeLabels: Record<string, string> = { en: 'English', ja: '日本語' };

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
	let instagramUrl = $state(data.settings.instagramUrl);
	let furtrackUrl = $state(data.settings.furtrackUrl);
	let autoResyncEnabled = $state(data.settings.autoResyncEnabled);
	let contactEmail = $state(data.settings.contactEmail);
	let siteUrl = $state(data.settings.siteUrl);
	// Empty setting shows the base locale (the effective default at send time).
	let emailLanguage = $state(data.settings.emailLanguage || baseLocale);
	// When no R2 public URL is set, suggest cdn.<site-host> as the field placeholder —
	// derived from Site URL but still fully editable (never hard-computed into the value).
	let cdnPlaceholder = $derived.by(() => {
		const raw = siteUrl?.trim();
		if (!raw) return 'https://cdn.example.com';
		try {
			return `https://cdn.${new URL(raw).host}`;
		} catch {
			return 'https://cdn.example.com';
		}
	});
	let privacyPolicy = $state(data.settings.privacyPolicy);
	let aiPageEnabled = $state(data.settings.aiPageEnabled);
	let aiPageText = $state(data.settings.aiPageText);
	let rssFeedEnabled = $state(data.settings.rssFeedEnabled);
	let rssNsfwEnabled = $state(data.settings.rssNsfwEnabled);
	let regeneratingFeedKey = $state(false);
	// The replacement Regenerate just minted, straight from the action. It wins
	// over the loaded key until the next load, because Regenerate deliberately
	// does NOT rerun the load: the $effect below resyncs every Site-tab field
	// from `data`, so a reload here would silently revert unsaved edits.
	let regeneratedKey = $state<string | null>(null);
	// The private address is derived, never bound: the key is minted server-side
	// and this page only ever displays what was stored.
	const feedKeyUrl = $derived.by(() => {
		const key = regeneratedKey ?? data.settings.rssNsfwKey;
		return key ? `${$page.url.origin}/feed.xml?key=${key}` : '';
	});
	// Gated on the STORED setting, not the checkbox: the key is minted when the
	// save lands, so there is nothing to show until the page reloads with one.
	// One derived drives both the {#if} and feedKeyPending below — written twice,
	// the two could drift and leave aria-describedby pointing at an id that was
	// never rendered.
	const feedKeyVisible = $derived(Boolean(data.settings.rssNsfwEnabled && feedKeyUrl));
	// True exactly while the "Save to create the address" line is on screen (the
	// {:else if rssNsfwEnabled} arm below). It joins the checkbox's
	// aria-describedby so the line is announced with the control that produced
	// it — otherwise a screen-reader user who ticks the box and tabs to Save
	// never meets it.
	const feedKeyPending = $derived(rssNsfwEnabled && !feedKeyVisible);
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
	let savingSupporterKey = $state(false);
	let removingSupporterKey = $state(false);

	// Localized "in early access right now" list, joined for the status line. Empty
	// until a pilot feature is registered, in which case the "nothing" line shows.
	// Each flag renders its localized display label (earlyAccessLabel reads the
	// registry entry's statically referenced message), never the raw flag slug.
	const earlyActiveText = $derived(
		data.earlyAccess
			.map((e) => m.admin_settings_supporter_early_item({ feature: earlyAccessLabel(e.flag), date: e.gaDate }))
			.join(m.admin_settings_supporter_early_join())
	);
	// Con card gate. The GA date comes from the load's already-formatted
	// early-access list, so the locked hint names the day the card opens to
	// everyone rather than a raw registry date; the list drops the flag on its
	// GA date, at which point this branch is unreachable anyway.
	const conCardEnabled = $derived(
		isFeatureEnabled('con-card', {
			supporterKeyValid: data.supporterKey?.state === 'valid',
			now: new Date()
		})
	);
	const conCardGaDate = $derived(data.earlyAccess.find((e) => e.flag === 'con-card')?.gaDate ?? '');

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

	// Tabs: ?tab= deep-links resolve REACTIVELY (the admin-wide key-expiry
	// notice, SONA-114, links to ?tab=account), so a same-route navigation to a
	// ?tab= URL still switches tabs. Clicking a tab button takes manual control
	// and shallow-drops the stale param (replaceState is not a navigation, so
	// afterNavigate below won't clear the manual pick); any real navigation
	// hands control back to the URL.
	let manualTab = $state<TabId | null>(null);
	const activeTab = $derived(
		manualTab ?? resolveTabId($page.url.searchParams.get('tab'), data.observabilityEnabled)
	);
	afterNavigate(() => {
		manualTab = null;
	});
	function selectTab(tab: TabId) {
		manualTab = tab;
		if ($page.url.searchParams.has('tab')) {
			const url = new URL($page.url);
			url.searchParams.delete('tab');
			replaceState(url, {});
		}
	}

	// The tablist renders from SETTINGS_TAB_IDS rather than a hand-written row of
	// buttons (SONA-119), so an added tab can't be missed here. Record<TabId, …>
	// makes a tab with no label a type error rather than a blank button.
	const TAB_LABELS: Record<TabId, () => string> = {
		site: m.admin_settings_tab_site,
		connections: m.admin_settings_tab_connections,
		storage: m.admin_settings_tab_storage,
		account: m.admin_settings_tab_account,
		observability: m.admin_settings_tab_observability
	};
	const tabs = $derived(visibleTabIds(data.observabilityEnabled));
	// activeTab can name a tab that isn't offered — a manual pick survives a data
	// reload that turns the observability gate off. Clamping keeps exactly one tab
	// tabbable (roving tabindex) and keeps the panel's label pointing at a real id.
	const selectedTab = $derived(tabs.includes(activeTab) ? activeTab : tabs[0]);
	const tabButtonId = (tab: TabId) => `settings-tab-${tab}`;
	let tabButtons = $state<(HTMLButtonElement | undefined)[]>([]);

	// role="tab" comes with a keyboard contract: one tab stop for the whole
	// tablist (roving tabindex, below) and arrows to move within it. Selection
	// follows focus — every panel is already rendered, so activating on arrow
	// costs nothing.
	function onTabKeydown(e: KeyboardEvent) {
		// Modifier chords belong to the browser: Cmd/Alt+Left and Right are Back
		// and Forward, Ctrl/Cmd+Home and End jump the document.
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		const from = tabs.indexOf(selectedTab);
		let next: number;
		if (e.key === 'ArrowRight') next = (from + 1) % tabs.length;
		else if (e.key === 'ArrowLeft') next = (from - 1 + tabs.length) % tabs.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tabs.length - 1;
		else return;
		e.preventDefault();
		selectTab(tabs[next]);
		tabButtons[next]?.focus();
	}

	// Usage bar reflects the ACTIVE provider. On R2 the bucket listing (SONA-192)
	// is the truth when available — it counts files D1 never tracked; the
	// DB-tracked total is the fallback when the list failed. UT keeps its own
	// usage API numbers.
	const activeUsage = $derived(
		data.settings.storageProvider === 'r2'
			? {
					label: 'Cloudflare R2',
					used: data.breakdown?.totalBytes ?? data.totalSize,
					limit: R2_FREE_TIER_BYTES
				}
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
		instagramUrl = data.settings.instagramUrl;
		furtrackUrl = data.settings.furtrackUrl;
		autoResyncEnabled = data.settings.autoResyncEnabled;
		storageProvider = data.settings.storageProvider;
		r2PublicUrl = data.settings.r2PublicUrl;
		contactEmail = data.settings.contactEmail;
		siteUrl = data.settings.siteUrl;
		emailLanguage = data.settings.emailLanguage || baseLocale;
		privacyPolicy = data.settings.privacyPolicy;
		aiPageEnabled = data.settings.aiPageEnabled;
		aiPageText = data.settings.aiPageText;
		rssFeedEnabled = data.settings.rssFeedEnabled;
		rssNsfwEnabled = data.settings.rssNsfwEnabled;
		// A completed load outranks the key Regenerate minted: in a second tab the
		// stored key may have moved on again, and holding the local one would keep
		// showing (and copying) a dead address. Regenerate deliberately does not
		// reload, so this does not undo it.
		regeneratedKey = null;
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

<div class="settings-tabs" data-active-tab={selectedTab}>
	<div class="settings-header">
		<div class="page-header">
			<h1>{m.admin_nav_settings()}</h1>
		</div>
		<div class="settings-tabnav" role="tablist" aria-label={m.admin_nav_settings()}>
			{#each tabs as tab, i (tab)}
				<button
					type="button"
					role="tab"
					id={tabButtonId(tab)}
					aria-selected={selectedTab === tab}
					aria-controls="settings-panels"
					tabindex={selectedTab === tab ? 0 : -1}
					bind:this={tabButtons[i]}
					class:active={selectedTab === tab}
					onclick={() => selectTab(tab)}
					onkeydown={onTabKeydown}>{TAB_LABELS[tab]()}</button
				>
			{/each}
		</div>
	</div>

	<!-- One panel for all tabs: the sections live in a single flow and the active
	     tab hides the rest via CSS, so the panel is relabelled by whichever tab
	     is selected rather than swapped out. -->
	<div class="settings-panels" id="settings-panels" role="tabpanel" aria-labelledby={tabButtonId(selectedTab)}>
<!-- Declared before the site form so the Regenerate button inside that form can
     point at it by id. A `form` attribute associates the button with THIS form,
     which is what keeps it from becoming the site form's default submit button
     — otherwise Enter in any Site-tab text field would regenerate the feed key
     instead of saving. Nested forms are not an option; this is what the
     attribute exists for. -->
<form id="regenerate-feed-key" class="contents" method="POST" action="?/regenerateFeedKey" use:enhance={() => {
	regeneratingFeedKey = true;
	return async ({ result }) => {
		regeneratingFeedKey = false;
		if (result.type === 'success') {
			// No reload on purpose — enhance's update helper is deliberately not
			// destructured here. Rerunning the load fires the resync $effect, which
			// reassigns every Site-tab field from the server, so an owner who typed
			// a new site name and then hit Regenerate would watch it revert. The
			// action hands back the key it minted instead.
			const key = result.data?.feedKey;
			if (typeof key === 'string') {
				regeneratedKey = key;
				toast.success(m.admin_settings_rss_regenerated());
			} else {
				// The action always returns the key, so this is unreachable today. If
				// it ever stops, fall back to a reload rather than announce success:
				// the address on screen has to be the one the server stored, and a
				// stale address that claims to be new is the worst of both.
				await applyAction(result);
			}
		} else {
			// Skipping the update helper also skips the applyAction it would run, so
			// every other result has to be handed over by hand: a failed D1 write
			// comes back as `error` and an expired session as a `redirect` to the
			// login page. Drop this and both vanish — the owner rotating a leaked
			// key sees a button that does nothing while the old key stays live.
			await applyAction(result);
		}
	};
}}></form>

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
			<label>
				<span>{m.admin_settings_site_url()}</span>
				<input type="url" class="input" bind:value={siteUrl} name="siteUrl" placeholder="https://example.com" />
			</label>
			<p class="hint">{m.admin_settings_site_url_hint()}</p>
			<label>
				<span>{m.admin_settings_email_language()}</span>
				<select class="input" name="emailLanguage" bind:value={emailLanguage}>
					{#each locales as loc}
						<option value={loc}>{localeLabels[loc] ?? loc}</option>
					{/each}
				</select>
			</label>
			<p class="hint">{m.admin_settings_email_language_hint()}</p>
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
			<div class="checkbox-row">
				<!-- An unchecked checkbox posts nothing; this marker is how the action
				     tells "toggle off" from "form without the toggle" (#60). -->
				<input type="hidden" name="aiPageEnabledPresent" value="1" />
				<input
					type="checkbox"
					id="aiPageEnabled"
					name="aiPageEnabled"
					aria-describedby="aiPageEnabled-desc"
					bind:checked={aiPageEnabled}
				/>
				<span class="checkbox-text">
					<label class="checkbox-title" for="aiPageEnabled">{m.admin_settings_ai_page_label()}</label>
					<span class="checkbox-desc" id="aiPageEnabled-desc">{m.admin_settings_ai_page_hint()}</span>
				</span>
			</div>
			<label>
				<span>{m.admin_settings_ai_text_label()}</span>
				<textarea class="input" rows="4" name="aiPageText" bind:value={aiPageText} placeholder={m.admin_settings_legal_placeholder()}></textarea>
			</label>
		</section>

		<section data-tab="site">
			<h2>{m.admin_settings_rss_heading()}</h2>
			<div class="checkbox-row">
				<!-- Same absent-means-unmanaged marker as the /ai toggle above (#60). -->
				<input type="hidden" name="rssFeedEnabledPresent" value="1" />
				<input
					type="checkbox"
					id="rssFeedEnabled"
					name="rssFeedEnabled"
					aria-describedby="rssFeedEnabled-desc"
					bind:checked={rssFeedEnabled}
				/>
				<span class="checkbox-text">
					<label class="checkbox-title" for="rssFeedEnabled">{m.admin_settings_rss_enabled_label()}</label>
					<!-- The hint describes what the site DOES, so it has to change tense
					     with the toggle: left in the present it would describe a feed an
					     owner who turned it off is not serving. -->
					<span class="checkbox-desc" id="rssFeedEnabled-desc"
						>{rssFeedEnabled
							? m.admin_settings_rss_enabled_hint()
							: m.admin_settings_rss_enabled_hint_off()}</span
					>
				</span>
			</div>
			<!-- The NSFW row is meaningless with no feed to serve, so it disappears
			     with the master toggle rather than sitting there disabled. Its
			     Present marker goes with it: an absent marker means "this form did
			     not manage the toggle", which is exactly the truth here. -->
			{#if rssFeedEnabled}
				<div class="checkbox-row">
					<input type="hidden" name="rssNsfwEnabledPresent" value="1" />
					<input
						type="checkbox"
						id="rssNsfwEnabled"
						name="rssNsfwEnabled"
						aria-describedby={feedKeyPending
							? 'rssNsfwEnabled-desc rssNsfwEnabled-pending'
							: 'rssNsfwEnabled-desc'}
						bind:checked={rssNsfwEnabled}
					/>
					<span class="checkbox-text">
						<label class="checkbox-title" for="rssNsfwEnabled">{m.admin_settings_rss_nsfw_label()}</label>
						<span class="checkbox-desc" id="rssNsfwEnabled-desc">{m.admin_settings_rss_nsfw_hint()}</span>
					</span>
				</div>
				{#if feedKeyVisible}
					<!-- The label is a plain span, not a <label>: there is no form control
					     to point `for` at. role="group" + aria-labelledby is what ties it
					     to the address and its controls, so a screen reader announces
					     what this block of text IS. -->
					<div class="feed-key" role="group" aria-labelledby="feed-key-label">
						<span class="feed-key-label" id="feed-key-label">{m.admin_settings_rss_key_label()}</span>
						<CopyCommand text={feedKeyUrl} label={m.admin_settings_rss_copy()} />
						<p class="hint">{m.admin_settings_rss_key_hint()}</p>
						<button
							type="submit"
							form="regenerate-feed-key"
							class="btn btn-secondary"
							disabled={regeneratingFeedKey}
						>
							{regeneratingFeedKey ? m.admin_settings_rss_regenerating() : m.admin_settings_rss_regenerate()}
						</button>
					</div>
				{:else if rssNsfwEnabled}
					<!-- Ticked but not yet saved. Without this the section looks inert:
					     the address block only appears once the save mints a key, so an
					     owner gets no sign that anything is about to happen. -->
					<p class="feed-key-pending" id="rssNsfwEnabled-pending">{m.admin_settings_rss_key_pending()}</p>
				{/if}
			{/if}
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
					<span>Instagram</span>
					<input type="text" class="input" bind:value={instagramUrl} name="instagram" placeholder="https://www.instagram.com/yourname" />
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
			<div class="checkbox-row">
				<input
					type="checkbox"
					id="autoResyncEnabled"
					name="autoResyncEnabled"
					aria-describedby="autoResyncEnabled-desc"
					bind:checked={autoResyncEnabled}
				/>
				<span class="checkbox-text">
					<label class="checkbox-title" for="autoResyncEnabled">{m.admin_settings_auto_resync()}</label>
					<span class="checkbox-desc" id="autoResyncEnabled-desc">{m.admin_settings_auto_resync_desc()}</span>
				</span>
			</div>
		</section>

		<section data-tab="connections">
			<h2>{m.admin_settings_registry()}</h2>
			{#if data.registryEnabled}
				<p class="reg-status connected">{m.admin_settings_registry_connected()}</p>
				<div class="checkbox-row">
					<input
						type="checkbox"
						id="registryOverridesLocal"
						name="registryOverridesLocal"
						aria-describedby="registryOverridesLocal-desc"
						bind:checked={registryOverridesLocal}
					/>
					<span class="checkbox-text">
						<label class="checkbox-title" for="registryOverridesLocal">{m.admin_settings_registry_overrides()}</label>
						<span class="checkbox-desc" id="registryOverridesLocal-desc">{m.admin_settings_registry_overrides_desc()}</span>
					</span>
				</div>
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
				{@const warn = usageWarning(pct)}
				<div class="storage-bar-wrap">
					<div class="storage-bar-header">
						<span>{m.admin_settings_usage({ label: activeUsage.label, used: formatSize(activeUsage.used), limit: formatSize(activeUsage.limit) })}</span>
						<!-- The header percentage carries the >80% / >95% signal in every
					     branch (the fallback branch's bar fill colors agree with it).
					     The worded suffix keeps the state readable without color
					     (WCAG 1.4.1). -->
					<span class="storage-pct" class:warning={warn === 'near'} class:danger={warn === 'full'}>{pct.toFixed(1)}%{#if warn === 'full'}{` · ${m.admin_settings_usage_full()}`}{:else if warn === 'near'}{` · ${m.admin_settings_usage_near()}`}{/if}</span>
					</div>
					{#if data.breakdown}
						<!-- Redundant visual summary of the table below, so it's hidden from
						     the accessibility tree (six values; progressbar can't express it).
						     Segment order is locked to the table's row order. -->
						<div class="storage-bar" aria-hidden="true">
							{#each breakdownRows as row (row.kind)}
								{#if data.breakdown.kinds[row.kind].bytes > 0}
									<div
										class="storage-seg seg-{row.kind}"
										style="width: {(data.breakdown.kinds[row.kind].bytes / activeUsage.limit) * 100}%"
									></div>
								{/if}
							{/each}
						</div>
					{:else}
						<div class="storage-bar">
							<div class="storage-bar-fill" style="width: {pct}%" class:warning={pct > 80} class:danger={pct > 95}></div>
						</div>
					{/if}
				</div>
			{/if}
			{#if data.breakdown}
				<table class="breakdown">
					<caption class="sr-only">{m.admin_settings_breakdown_caption()}</caption>
					<thead>
						<tr>
							<th scope="col" class="col-type">{m.admin_settings_breakdown_type()}</th>
							<th scope="col"><span class="sr-only">{m.admin_settings_breakdown_files()}</span></th>
							<th scope="col" class="col-size">{m.admin_settings_breakdown_size()}</th>
							<!-- ≤520px the full header is sr-only and the short "Share" shows
							     instead (aria-hidden — the accessible name stays the full
							     phrase at every width). -->
							<th scope="col" class="col-share"><span class="share-full">{m.admin_settings_breakdown_share()}</span><span class="share-short" aria-hidden="true">{m.admin_settings_breakdown_share_short()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each breakdownRows as row (row.kind)}
							{@const usage = data.breakdown.kinds[row.kind]}
							<!-- Zero-byte rows stay (the fixed row set is the legend) but are
							     dimmed, with an outline swatch. -->
							<tr class:zero={usage.bytes === 0}>
								<th scope="row" class="col-type"><span class="swatch seg-{row.kind}" aria-hidden="true"></span>{row.label()}</th>
								<td class="col-files">{m.admin_settings_breakdown_file_count({ count: usage.count })}</td>
								<td class="col-size">{formatSize(usage.bytes)}</td>
								<td class="col-share">{sharePct(usage.bytes, data.breakdown.totalBytes)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else if data.settings.storageProvider === 'uploadthing'}
				<p class="breakdown-r2-note">{m.admin_settings_breakdown_r2_only()}</p>
			{:else if data.breakdownTooLarge}
				<!-- R2, bucket past the listing page cap: not an outage — a partial
				     breakdown would misstate every share, so say why instead. -->
				<p class="breakdown-r2-note">{m.admin_settings_breakdown_too_large()}</p>
			{:else}
				<!-- R2 with no breakdown: the bucket listing failed or timed out, so
				     the bar above fell back to the D1 sum — say so. -->
				<p class="breakdown-r2-note">{m.admin_settings_breakdown_unavailable()}</p>
			{/if}
			{#if utLeftover > 0}
				<p class="ut-leftover">
					{m.admin_settings_ut_leftover_pre({ size: formatSize(utLeftover) })}<a href="/admin/storage/migrate">{m.admin_settings_ut_leftover_link()}</a>{m.admin_settings_ut_leftover_post()}
				</p>
			{/if}
			<dl class="storage-info">
				<div class="storage-stat">
					<!-- Deliberately the D1 sum, labelled "In database" to name its
					     source; the bar header above already shows the bucket total, so
					     the DB-vs-bucket delta stays visible. -->
					<dt class="stat-label">{m.admin_settings_stat_tracked()}</dt>
					<dd class="stat-value">{formatSize(data.totalSize)}</dd>
				</div>
				{#if data.breakdown}
					<div class="storage-stat">
						<dt class="stat-label">{m.admin_settings_stat_bucket_files()}</dt>
						<dd class="stat-value">{data.breakdown.totalCount}</dd>
					</div>
				{:else}
					<div class="storage-stat">
						<dt class="stat-label">{m.admin_tab_images()}</dt>
						<dd class="stat-value">{data.imageCount}</dd>
					</div>
				{/if}
				<!-- Hidden on R2 (stale UT count); see showUtFileStat in ./ut-stat. -->
				{#if showUtFileStat(data)}
					<div class="storage-stat">
						<dt class="stat-label">{m.admin_settings_stat_ut_files()}</dt>
						<dd class="stat-value">{data.utUsage.filesUploaded}</dd>
					</div>
				{/if}
				<div class="storage-stat">
					<dt class="stat-label">{m.admin_settings_stat_provider()}</dt>
					<dd class="stat-value provider">{data.settings.storageProvider === 'r2' ? 'Cloudflare R2' : 'UploadThing'}</dd>
				</div>
			</dl>
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
				<input type="text" class="input" name="r2PublicUrl" bind:value={r2PublicUrl} placeholder={cdnPlaceholder} />
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
			<span>{m.admin_settings_recovery_email_label()}</span>
			<input type="email" name="adminEmail" class="input" bind:value={adminEmail} autocomplete="email" placeholder="you@example.com" aria-describedby="recovery-email-hint" />
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
		<p class="field-hint" id="recovery-email-hint">
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
					<div class="text">{m.admin_setup_secret_ci_pre()}</div>
					<CopyCommand text="gh secret set RESEND_API_KEY" />
					<div class="text">{m.admin_setup_secret_ci_post_a()}<strong>{m.admin_setup_secret_ci_ui_path()}</strong>{m.admin_setup_secret_ci_post_b()}</div>
					<div class="text">{m.admin_resend_setup_s2_cli()}</div>
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

<!-- Supporter key (SONA-105): unlocks early-access features. The mock's EMPTY /
     VALID / EXPIRED / INVALID states are one dynamic section driven by
     data.supporterKey (verified server-side in load). -->
<section class="security-section supporter-explainer" data-tab="account">
	<div class="key-eyebrow">{m.admin_settings_supporter_early_eyebrow()}</div>
	<p class="explainer-body">{m.admin_settings_supporter_explainer()}</p>
</section>

{#if data.supporterKey?.state === 'valid'}
	<section class="security-section" data-tab="account">
		<h2>{m.admin_settings_supporter_heading()}</h2>
		<div class="key-eyebrow">
			{m.admin_settings_supporter_valid_until({ date: data.supporterKey.validUntil })}
			{#if data.supporterKey.expiringSoon}
				· <span class="days-left">{data.supporterKey.daysRemaining <= 1
					? m.admin_settings_supporter_expires_today()
					: m.admin_settings_supporter_days_left({ days: data.supporterKey.daysRemaining })}</span>
			{/if}
		</div>
		{#if data.supporterKey.expiringSoon}
			<!-- Action only — the eyebrow above already carries the countdown, so the
			     nudge doesn't repeat it. -->
			<p class="nudge-line">{m.admin_settings_supporter_expiring_pre()}<a class="link-inline" href="https://sona.fast/supporter-key" target="_blank" rel="noopener noreferrer">sona.fast/supporter-key<span class="sr-only">{' '}{m.link_opens_new_tab()}</span></a>{m.admin_settings_supporter_expiring_post()}</p>
		{/if}
		{#if data.earlyAccess.length}
			<p class="status-line">{m.admin_settings_supporter_early_active({ features: earlyActiveText })}</p>
		{:else}
			<p class="status-line">{m.admin_settings_supporter_early_none()}</p>
		{/if}
		<div class="key-record">{data.supporterKey.keyRecord}</div>
		<form method="POST" action="?/removeSupporterKey" use:enhance={() => {
			removingSupporterKey = true;
			return async ({ result, update }) => {
				await update({ reset: false });
				removingSupporterKey = false;
				if (result.type === 'success') toast.success(m.admin_settings_supporter_removed());
			};
		}}>
			<div class="key-actions">
				<button type="submit" class="link" disabled={removingSupporterKey}>{m.admin_settings_supporter_remove()}</button>
			</div>
		</form>
	</section>
{:else}
	<form method="POST" action="?/saveSupporterKey" class="contents" use:enhance={() => {
		savingSupporterKey = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			savingSupporterKey = false;
			if (result.type === 'success') toast.success(m.admin_settings_supporter_saved());
		};
	}}>
		<section class="security-section" data-tab="account">
			<h2>{m.admin_settings_supporter_heading()}</h2>
			{#if data.supporterKey?.state === 'expired'}
				<div class="key-eyebrow">{m.admin_settings_supporter_expired_eyebrow({ date: data.supporterKey.validUntil })}</div>
				<p class="lapsed-line">{m.admin_settings_supporter_lapsed_pre()}<a class="link-inline" href="https://sona.fast/supporter-key" target="_blank" rel="noopener">sona.fast/supporter-key</a>{m.admin_settings_supporter_lapsed_post()}</p>
			{/if}
			<label>
				<span>{m.admin_settings_supporter_key_label()}</span>
				<input
					type="text"
					class="input"
					id="supporter-key"
					name="supporterKey"
					placeholder={data.supporterKey?.state === 'expired' ? m.admin_settings_supporter_placeholder_new() : m.admin_settings_supporter_placeholder()}
					aria-invalid={form?.supporterKeyError ? 'true' : undefined}
					aria-describedby={form?.supporterKeyError ? 'supporter-key-error' : undefined}
				/>
			</label>
			{#if form?.supporterKeyError}
				<p class="field-error" id="supporter-key-error" role="alert">
					{#if form.supporterKeyError === 'expired'}
						{m.admin_settings_supporter_error_expired({ date: form.supporterKeyExpiredDate ?? '' })}
					{:else}
						{m.admin_settings_supporter_error_invalid()}
					{/if}
				</p>
			{/if}
			<div class="save-row">
				<button type="submit" class="btn btn-primary" disabled={savingSupporterKey}>
					{savingSupporterKey ? m.admin_saving() : m.admin_settings_supporter_save()}
				</button>
			</div>
			{#if !data.supporterKey}
				<p class="hint">{m.admin_settings_supporter_hint_pre()}<a class="link-inline" href="https://sona.fast/supporter-key" target="_blank" rel="noopener">sona.fast/supporter-key</a>{m.admin_settings_supporter_hint_post()}</p>
			{/if}
		</section>
	</form>
{/if}

<!-- Con card (SONA-115): a printable card carrying the fork's /connect QR.
     Early-access until its GA date, like any other pilot feature. -->
<section class="security-section" data-tab="account">
	<h2>{m.admin_settings_con_card_heading()}</h2>
	<p class="explainer-body">{m.admin_settings_con_card_subtitle()}</p>
	{#if conCardEnabled}
		<!-- Lazy chunk, like the ref-sheet picker: the card builds two full SVGs and
		     rasterizes through a canvas, and every other tab of this page would
		     otherwise carry that. -->
		{#await import('$lib/components/ConCard.svelte') then { default: ConCard }}
			<ConCard
				name={data.conCard.name}
				species={data.conCard.species}
				colors={data.conCard.colors}
				handles={data.conCard.handles}
				artCredit={data.conCard.artCredit}
				avatarSrc={data.conCard.avatarSrc}
				connectUrl={data.conCard.connectUrl}
				displayDomain={data.conCard.displayDomain}
			/>
		{/await}
	{:else}
		<!-- The key field is on this same tab, so the hint can point straight at it
		     rather than leaving the operator to find it. -->
		<p class="hint">{m.admin_settings_con_card_locked({ date: conCardGaDate })} <a class="link-inline" href="#supporter-key">{m.admin_settings_con_card_locked_link()}</a></p>
	{/if}
</section>

{#if data.registryEnabled}
	<form method="POST" action="?/syncNow" class="contents" use:enhance={() => {
		syncing = true;
		return async ({ result, update }) => {
			await update();
			syncing = false;
			if (result.type === 'success') toast.success((result.data?.syncMessage as string) ?? m.admin_settings_sync_complete());
			else if (result.type === 'failure')
				// A registry refusal comes back as a reason, not a message: the wording is
				// localized here and only the registry's own text is interpolated.
				toast.error(
					result.data?.syncRefusedReason
						? m.admin_settings_sync_refused({ reason: result.data.syncRefusedReason as string })
						: ((result.data?.error as string) ?? m.admin_settings_sync_failed())
				);
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
			{m.admin_settings_obs_hint_unset_a()}<code>Zone Analytics: Read</code>{m.admin_settings_obs_hint_unset_b()}<code>pages.dev</code>{m.admin_settings_obs_hint_unset_c()}
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
	/* The strip scrolls (overflow-x: auto), which clips an outset ring top and
	   bottom — inset it so arrowing through the roving tabindex stays visible. */
	.settings-tabnav button:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
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
	   separates whole sections, not the fields inside one). A .checkbox-row is a
	   field too, even though it is a <div> rather than a <label> (SONA-183). */
	section > :is(label, .checkbox-row) + :is(label, .checkbox-row) {
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

	/* The hint must stay OUTSIDE the label, reaching the input through
	   aria-describedby, or it joins the checkbox's accessible name (SONA-183). That
	   makes the row a <div>, so its layout and type styles are stated here rather
	   than inherited from the base label rules. */
	.checkbox-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.checkbox-row input {
		margin-top: 2px;
		cursor: pointer;
	}

	.checkbox-text {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 14px;
		font-weight: 500;
	}

	/* Only the title is clickable, so it carries the pointer target: min-height
	   plus padding put a 24px floor under it without depending on the resolved
	   font's line box, and the equal negative margin cancels the padding so every
	   rendered position is unchanged — the 4px .checkbox-text gap absorbs it. */
	.checkbox-title {
		display: block;
		min-height: 24px;
		padding-block: 4px;
		margin-block: -4px;
		cursor: pointer;
	}

	.checkbox-desc {
		font-size: 13px;
		font-weight: 400;
		color: var(--muted-foreground);
	}

	/* The private feed address: a field-shaped block rather than a .checkbox-row,
	   since nothing in it is toggled. align-items: start keeps the Regenerate
	   button its own width instead of stretching across the column. */
	.feed-key {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		margin-top: 20px;
	}

	/* Stands in for .feed-key-label, in the slot .feed-key will occupy: same
	   offset from the hint above and same weight, so the section does not jump
	   or change voice when the save replaces this line with the real address.
	   Not a .hint — that class's `margin` shorthand is declared later at equal
	   specificity and would win over any margin-top set here. */
	.feed-key-pending {
		margin: 20px 0 0;
		font-size: 14px;
		font-weight: 500;
	}

	.feed-key-label {
		font-size: 14px;
		font-weight: 500;
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

	/* wrap + column-gap: at narrow widths the percentage drops to its own line
	   instead of abutting the usage text; margin-left:auto keeps it right-
	   aligned on that wrapped line (it's the last flex child, so at full width
	   space-between already places it right and the margin is a no-op). */
	.storage-bar-header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		column-gap: 24px;
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 6px;
	}

	.storage-pct {
		font-family: var(--font-primary);
		font-weight: 600;
		color: var(--foreground);
		margin-left: auto;
	}

	.storage-bar {
		display: flex;
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

	/* The colored + worded percentage renders in BOTH branches; the fallback
	   bar's warning/danger fill above mirrors the same >80% / >95% thresholds,
	   so text and fill always agree. As TEXT the amber needs 4.5:1, which
	   #f0b33a only clears on the dark themes (10.08:1 on the #111111
	   --background the text sits on) — light gets a dark amber (#7a4f00:
	   6.40:1 on #F2F3F0). --destructive clears 4.5:1
	   as text in every theme. */
	.storage-pct.warning {
		color: #f0b33a;
	}

	:global([data-theme='light']) .storage-pct.warning {
		color: #7a4f00;
	}

	.storage-pct.danger {
		color: var(--destructive);
	}

	/* Outranks the light warning override above, so >95% escalates to red on
	   light themes even if both classes ever apply together again. */
	:global([data-theme='light']) .storage-pct.danger {
		color: var(--destructive);
	}

	/* ── Per-type breakdown (SONA-192) ─────────────────────────────────────
	   The segmented bar is aria-hidden (the table carries the data); segment
	   order is locked to row order. Separators use the page background so
	   adjacent segments stay distinguishable (WCAG 1.4.11) in every theme.
	   Colors are validated ≥3:1 against the track in the default palettes:
	   the dark set on #2E2E2E, the light set on #E7E8E5 and white. Both
	   vrImage teals sit outside the orange family so they can't be read as a
	   shade of artwork (light #0F766E: 4.45:1 on #E7E8E5, 5.47:1 on #FFFFFF;
	   dark #2DD4BF: 7.30:1 on #2E2E2E). Fursuit violet: dark #C4B5FD 7.36:1
	   on #2E2E2E, light #6D28D9 5.78:1 on #E7E8E5, 7.10:1 on #FFFFFF. Dark
	   other #9AA5B1: 5.43:1 on #2E2E2E, clearly apart from the empty track. */
	.storage-seg {
		height: 100%;
	}

	.storage-seg + .storage-seg {
		border-left: 2px solid var(--background);
	}

	.seg-artwork {
		background: #ff8400;
	}
	.seg-vrVideo {
		background: #4fa3ff;
	}
	.seg-vrModel {
		background: #4ade80;
	}
	.seg-sticker {
		background: #e879f9;
	}
	.seg-vrImage {
		background: #2dd4bf;
	}
	.seg-fursuit {
		background: #c4b5fd;
	}
	.seg-other {
		background: #9aa5b1;
	}

	:global([data-theme='light']) .seg-artwork {
		background: #c2410c;
	}
	:global([data-theme='light']) .seg-vrVideo {
		background: #2563eb;
	}
	:global([data-theme='light']) .seg-vrModel {
		background: #15803d;
	}
	:global([data-theme='light']) .seg-sticker {
		background: #a21caf;
	}
	:global([data-theme='light']) .seg-vrImage {
		background: #0f766e;
	}
	:global([data-theme='light']) .seg-fursuit {
		background: #6d28d9;
	}
	:global([data-theme='light']) .seg-other {
		background: #57606a;
	}

	.breakdown {
		width: 100%;
		border-collapse: collapse;
		font-size: 13.5px;
	}

	/* thead-scoped: the type cells in tbody are row headers (th scope="row")
	   and keep the body-cell styling below instead. */
	.breakdown thead th {
		padding: 8px 2px 2px;
		border-top: 1px solid var(--border);
		font-size: 12px;
		font-weight: 400;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		text-align: left;
		vertical-align: bottom;
		white-space: nowrap;
	}

	.breakdown th.col-size,
	.breakdown th.col-share,
	.breakdown td.col-size,
	.breakdown td.col-share {
		text-align: right;
	}

	.breakdown th.col-share {
		padding-left: 12px;
	}

	.breakdown td,
	.breakdown tbody th {
		padding: 8px 2px;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}

	.breakdown tr:last-child td,
	.breakdown tr:last-child th {
		border-bottom: none;
	}

	.breakdown tbody th.col-type {
		font-weight: 500;
		text-align: left;
		padding-right: 10px;
		white-space: nowrap;
	}

	/* The files column absorbs the free width so type + count hug the left edge
	   and size + share hug the right, like the usage bar above. */
	.breakdown td.col-files {
		width: 99%;
		color: var(--muted-foreground);
		font-size: 13px;
		white-space: nowrap;
		padding-right: 10px;
		font-variant-numeric: tabular-nums;
	}

	.breakdown td.col-size {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 13px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.breakdown td.col-share {
		color: var(--muted-foreground);
		font-size: 13px;
		min-width: 56px;
		white-space: nowrap;
		padding-left: 12px;
		font-variant-numeric: tabular-nums;
	}

	/* Desktop shows the full "Share of used" header; the short twin only
	   exists ≤520px (aria-hidden, with the full phrase kept sr-only there, so
	   the accessible name never changes). */
	.breakdown thead th .share-short {
		display: none;
	}

	/* 320px reflow (WCAG 1.4.10): let the type labels and headers wrap
	   instead of scrolling, and hand the flexible width to the label column
	   (width: 99%, same trick as the base col-files rule) so it takes the
	   slack on mobile. File counts, size, and share keep their base nowrap —
	   measured at a 320px viewport / 288px container with worst-case values
	   ("VR showcase videos" / "Avatars & other files", "20000 files" — the
	   message renders raw counts, no separator, and the 20-page listing cap
	   bounds it — "1023.9 GB", "100%", en and ja), the table still fits, and
	   a mid-value line break would misread as two values. Every base rule
	   above precedes this block so the overrides here actually win. */
	@media (max-width: 520px) {
		.breakdown thead th {
			white-space: normal;
		}

		.breakdown thead th .share-full {
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

		.breakdown thead th .share-short {
			display: inline;
		}

		.breakdown tbody th.col-type {
			white-space: normal;
			width: 99%;
		}

		.breakdown td.col-files {
			width: auto;
			padding-right: 6px;
		}

		.breakdown td.col-share {
			min-width: 0;
			padding-left: 6px;
		}
	}

	.swatch {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 3px;
		margin-right: 10px;
		vertical-align: 1px;
	}

	/* Zero-byte kinds: muted row, outline swatch — present as a legend entry
	   without competing with the rows that hold actual bytes. */
	.breakdown tr.zero td,
	.breakdown tr.zero th {
		color: var(--muted-foreground);
		font-weight: 400;
	}

	.breakdown tr.zero .swatch {
		background: transparent;
		border: 1px solid var(--muted-foreground);
	}

	.breakdown-r2-note {
		font-size: 13px;
		color: var(--muted-foreground);
		margin: 12px 0;
	}

	.storage-info {
		display: flex;
		gap: 32px;
		margin: 0;
		padding: 16px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
	}

	.storage-info dd {
		margin: 0;
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

	/* Both cards are space-between rows, so the button is free to shrink until
	   its label wraps ("Clear Cache" breaking over two lines, and the localized
	   "Exporting…" is longer still). Keep it on one line and let the description
	   text take the squeeze instead. */
	.export-card .btn,
	.danger-card .btn {
		white-space: nowrap;
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

	/* ── Supporter key (SONA-105) ─────────────────────────────── */
	/* Theme-native section eyebrow (matches the observability dashboard's
	   convention) — the mock's marketing-brand "//" slash device is deliberately
	   NOT used here: fork admin surfaces follow the fork's theme, not sona.fast
	   chrome. */
	.key-eyebrow {
		font-family: var(--font-primary);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--muted-foreground);
		margin-bottom: 14px;
	}
	.explainer-body {
		font-size: 14px;
		color: var(--muted-foreground);
		line-height: 1.6;
		max-width: 62ch;
	}
	.status-line {
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.55;
		margin-bottom: 14px;
		max-width: 62ch;
	}
	/* nudge-line (expiring soon, SONA-114) shares the lapsed-line voice: same
	   weight so "act on this" reads consistently across the two states. */
	.lapsed-line,
	.nudge-line {
		font-size: 14px;
		color: var(--foreground);
		line-height: 1.55;
		margin-bottom: 16px;
		max-width: 62ch;
	}
	/* Countdown on the eyebrow — warn, not destructive (the key still works)
	   and not attention (that tracks --primary, which would make the warning
	   read as brand accent in the default dark theme). --status-warn is
	   family-stable amber in all themes and AA on the card. */
	.days-left {
		color: var(--status-warn);
	}
	/* Stored key on a raised, higher-contrast panel (var(--secondary) stands in
	   for the mock's --raised, which isn't a shared token). */
	.key-record {
		background: var(--secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 12px 16px;
		font-family: var(--font-primary);
		font-size: 13px;
		color: var(--foreground);
		word-break: break-all;
		line-height: 1.5;
	}
	.key-actions {
		margin-top: 14px;
	}
	.save-row {
		margin-top: 20px;
	}
	/* Remove-key: a text button that reads as a link. */
	.link {
		color: var(--muted-foreground);
		font-size: 13px;
		font-family: var(--font-secondary);
		text-decoration: underline;
		text-underline-offset: 2px;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}
	.link:hover {
		color: var(--foreground);
	}
	.link-inline {
		color: var(--foreground);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.link:focus-visible,
	.link-inline:focus-visible {
		outline: 2px solid var(--foreground);
		outline-offset: 2px;
	}
	/* Screen-reader-only "(opens in a new tab)" on the external nudge link. */
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
	/* Destructive on text only — matches the app's form errors. */
	.field-error {
		color: var(--destructive);
		font-size: 13px;
		margin-top: 8px;
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
	.item .text a { color: var(--link); text-decoration: none; }
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
	/* #7A4E00, one step darker than the shared #8A5A00: the checklist sits on
	   var(--background), and terracotta light's #EADED6 puts #8A5A00 at 4.49:1 —
	   a hair under AA. #7A4E00 clears 5.46:1 there and 6.46:1 on default light. */
	:global([data-theme='light']) .item .text a { color: #7A4E00; }
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
