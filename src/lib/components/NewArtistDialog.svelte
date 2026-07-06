<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Loader2 } from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte';
	import * as m from '$lib/paraglide/messages';
	import { shouldSearch, resultToPrefill, type RegResult } from '$lib/registry-search';
	import TwitterIcon from '$lib/components/icons/TwitterIcon.svelte';
	import BlueskyIcon from '$lib/components/icons/BlueskyIcon.svelte';
	import TelegramIcon from '$lib/components/icons/TelegramIcon.svelte';
	import FurAffinityIcon from '$lib/components/icons/FurAffinityIcon.svelte';
	import DeviantArtIcon from '$lib/components/icons/DeviantArtIcon.svelte';
	import PatreonIcon from '$lib/components/icons/PatreonIcon.svelte';
	import InstagramIcon from '$lib/components/icons/InstagramIcon.svelte';

	interface Props {
		oncreated: (artist: { id: number; name: string }) => void;
		oncancel: () => void;
		/** Dialog heading — e.g. "New Manager" when the created artist will manage a pack. */
		title?: string;
		/** Called after a successful "Import all" (bulk catalog import) so the
		 * caller can refresh its artist list. Optional — a toast is shown anyway. */
		onimportedall?: () => void;
		/** Whether the shared registry is connected — passed from page load so the
		 *  registry search UI is decided BEFORE the modal renders (no flash-then-hide). */
		registryEnabled?: boolean;
	}
	let { oncreated, oncancel, title = m.admin_new_artist_title(), onimportedall, registryEnabled = false }: Props = $props();

	function initials(n: string): string {
		return n.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
	}

	// Mirrors the Edit Artist modal on /admin/artists, but creates via the
	// /api/artists endpoint (AJAX) so the caller gets the new id back immediately
	// and can use it in dropdowns without a page reload.
	let name = $state('');
	let twitter = $state('');
	let bluesky = $state('');
	let telegram = $state('');
	let furaffinity = $state('');
	let deviantart = $state('');
	let patreon = $state('');
	let instagram = $state('');
	let saving = $state(false);
	let errorMsg = $state('');

	// Optional pull from the shared registry: the NAME field IS the search — typing
	// debounce-searches the registry and offers matches as a combobox dropdown;
	// picking one prefills + links, otherwise the typed text is just the new name.
	let registryResults = $state<RegResult[]>([]);
	let registrySearching = $state(false);
	let pulled = $state<{ globalId: string; version: number; avatarUrl: string | null } | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	// Combobox UI state: whether the dropdown is showing, the keyboard-active
	// option index (-1 = none), and whether a search has completed for the current
	// query (drives the "no matches" live announcement without flashing mid-type).
	let resultsOpen = $state(false);
	let activeIndex = $state(-1);
	let hasSearched = $state(false);
	const listboxId = 'new-artist-registry-listbox';

	// Polite announcement of result counts for screen-reader users. Silent while
	// typing/searching; speaks once a search settles.
	let resultsAnnouncement = $derived.by(() => {
		if (!registryEnabled || !shouldSearch(name) || registrySearching) return '';
		if (registryResults.length) return m.admin_new_artist_registry_results_count({ count: registryResults.length });
		if (hasSearched) return m.admin_new_artist_registry_no_matches();
		return '';
	});

	// Catalog import plan for the panel footer + "Import all" confirmation: how
	// many artists the registry holds, how many an import would create, and how
	// many it skips (already linked / handle-matched). null = not loaded (footer
	// hidden) — the dialog works fine without it.
	let importPlan = $state<{ total: number; toCreate: number; skipped: number } | null>(null);
	let showImportAll = $state(false);
	// "Keep imported artists updated from the registry" — wired to the site-wide
	// registryOverridesLocal setting (the existing sync-update mechanism).
	// Default checked per the approved design.
	let keepUpdated = $state(true);
	let importingAll = $state(false);

	// registryEnabled arrives as a prop (resolved in the admin layout load), so the
	// search box's presence is decided before render. When on, fetch the catalog
	// import plan for the footer + "Import all" flow.
	onMount(async () => {
		if (!registryEnabled) return;
		try {
			const res = await fetch('/api/registry/import');
			const data = res.ok ? await res.json() : null;
			if (data?.enabled) {
				importPlan = { total: data.total, toCreate: data.toCreate, skipped: data.skipped };
			}
		} catch {
			/* footer just stays hidden */
		}
	});

	/** "@handle" for a result row, derived from its first social URL. */
	function resultHandle(r: RegResult): string {
		for (const v of Object.values(r.socials ?? {})) {
			if (typeof v !== 'string' || !v) continue;
			const seg = v.replace(/\/+$/, '').split('/').pop() ?? '';
			const handle = seg.replace(/^@+/, '');
			if (handle) return '@' + handle;
		}
		return '';
	}

	async function runImportAll() {
		if (importingAll || !importPlan) return;
		importingAll = true;
		try {
			const res = await fetch('/api/registry/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ keepUpdated })
			});
			const data = res.ok ? ((await res.json()) as { enabled?: boolean; created?: number }) : null;
			if (!data?.enabled) {
				toast.error(m.admin_import_failed());
				return;
			}
			toast.success(m.admin_registry_imported_toast({ count: data.created ?? 0 }));
			showImportAll = false;
			onimportedall?.();
		} catch {
			toast.error(m.admin_new_artist_network_error());
		} finally {
			importingAll = false;
		}
	}

	// Typing in the name field (registry on) re-searches. Editing after a pick
	// unlinks — the identity no longer matches what's typed, so we drop back to
	// plain-create until they pick again.
	function onNameInput() {
		if (!registryEnabled) return;
		if (pulled) pulled = null;
		clearTimeout(searchTimer);
		activeIndex = -1;
		hasSearched = false;
		if (!shouldSearch(name)) {
			registryResults = [];
			resultsOpen = false;
			return;
		}
		searchTimer = setTimeout(searchRegistry, 250);
	}
	async function searchRegistry() {
		if (!shouldSearch(name)) return;
		registrySearching = true;
		try {
			const res = await fetch('/api/registry/search?q=' + encodeURIComponent(name.trim()));
			if (res.ok) {
				const data = await res.json();
				registryResults = data.artists ?? [];
				resultsOpen = registryResults.length > 0;
			}
		} catch {
			/* ignore — manual entry still works */
		} finally {
			registrySearching = false;
			hasSearched = true;
		}
	}
	function applyResult(r: RegResult) {
		const p = resultToPrefill(r);
		name = p.name;
		twitter = p.twitter;
		bluesky = p.bluesky;
		telegram = p.telegram;
		furaffinity = p.furaffinity;
		deviantart = p.deviantart;
		patreon = p.patreon;
		instagram = p.instagram;
		pulled = p.pulled;
		registryResults = [];
		resultsOpen = false;
		activeIndex = -1;
	}
	/** Drop the registry link and return to plain-create, keeping the typed name. */
	function unpick() {
		pulled = null;
		registryResults = [];
		resultsOpen = false;
		activeIndex = -1;
	}
	// Full keyboard support for the combobox; falls through to create() on Enter
	// when there's nothing to pick (and behaves as a plain field when registry off).
	function onNameKeydown(e: KeyboardEvent) {
		if (!registryEnabled) {
			if (e.key === 'Enter') create();
			return;
		}
		if (e.key === 'ArrowDown') {
			if (!registryResults.length) return;
			e.preventDefault();
			resultsOpen = true;
			activeIndex = activeIndex < 0 ? 0 : Math.min(activeIndex + 1, registryResults.length - 1);
		} else if (e.key === 'ArrowUp') {
			if (!resultsOpen) return;
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (e.key === 'Enter') {
			if (resultsOpen && activeIndex >= 0) {
				e.preventDefault();
				applyResult(registryResults[activeIndex]);
			} else {
				create();
			}
		} else if (e.key === 'Escape') {
			// Close the dropdown first; only let a second Escape reach the modal.
			if (resultsOpen) {
				e.stopPropagation();
				resultsOpen = false;
				activeIndex = -1;
			}
		}
	}

	async function create() {
		if (!name.trim() || saving) return;
		saving = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/artists', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					twitter,
					bluesky,
					telegram,
					furaffinity,
					deviantart,
					patreon,
					instagram,
					globalId: pulled?.globalId,
					registryVersion: pulled?.version,
					avatarUrl: pulled?.avatarUrl
				})
			});
			if (!res.ok) {
				errorMsg = (await res.text()) || m.admin_new_artist_create_failed();
				toast.error(errorMsg);
				return;
			}
			const result = (await res.json()) as { id: number; name: string; status?: string };
			if (result.status === 'linked')
				toast.success(m.admin_new_artist_linked({ name: result.name }));
			else if (result.status === 'reused')
				toast.success(m.admin_new_artist_reused({ name: result.name }));
			oncreated(result);
		} catch {
			errorMsg = m.admin_new_artist_network_error();
			toast.error(errorMsg);
		} finally {
			saving = false;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={oncancel} onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal" role="dialog" aria-modal="true" aria-label={title} onclick={(e) => e.stopPropagation()}>
		<div class="modal-header">
			<h2>{title}</h2>
			<button class="icon-btn" onclick={oncancel} aria-label={m.admin_close()}><X size={18} /></button>
		</div>

		{#if errorMsg}<div class="err">{errorMsg}</div>{/if}

		<div class="modal-form">
			<div class="name-block">
				<label class="field-label" for="new-artist-name">{m.admin_field_artist_name()}</label>
				<div class="name-field">
					<!-- svelte-ignore a11y_autofocus -->
					<input
						id="new-artist-name"
						type="text"
						class="input"
						bind:value={name}
						required
						autofocus
						placeholder={m.admin_upload_artist_name_placeholder()}
						oninput={onNameInput}
						onkeydown={onNameKeydown}
						role={registryEnabled ? 'combobox' : undefined}
						aria-autocomplete={registryEnabled ? 'list' : undefined}
						aria-expanded={registryEnabled ? resultsOpen : undefined}
						aria-controls={registryEnabled ? listboxId : undefined}
						aria-describedby={registryEnabled ? 'new-artist-name-hint' : undefined}
						aria-activedescendant={registryEnabled && resultsOpen && activeIndex >= 0 ? `new-artist-opt-${activeIndex}` : undefined}
					/>
					{#if registrySearching}<span class="name-spin"><Loader2 size={14} class="spin" /></span>{/if}
					{#if registryEnabled && resultsOpen && registryResults.length}
						<ul class="reg-results" role="listbox" id={listboxId} aria-label={m.admin_new_artist_registry_results_label()}>
							{#each registryResults as r, i}
								{@const handle = resultHandle(r)}
								<!-- Selection is keyboard-driven from the combobox input (Down/Up/Enter),
								     so options carry no key handlers of their own. onmousedown +
								     preventDefault picks without stealing focus from the input. -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<li
									role="option"
									id={`new-artist-opt-${i}`}
									class:active={i === activeIndex}
									aria-selected={i === activeIndex}
									onmousedown={(e) => { e.preventDefault(); applyResult(r); }}
								>
									<span class="reg-avatar">
										<span class="reg-initials" aria-hidden="true">{initials(r.name)}</span>
										<!-- Overlays the monogram; if the registry has no avatar (or the
										     URL fails to load) the initials show through instead of an
										     empty circle. -->
										{#if r.avatarUrl}<img src={r.avatarUrl} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />{/if}
									</span>
									<span class="reg-id">
										<span class="reg-name">{r.name}</span>
										{#if handle}<span class="reg-handle">{handle}</span>{/if}
									</span>
									<span class="reg-import-pill">{m.admin_registry_import_pill()}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{#if registryEnabled}
					<p class="reg-hint" id="new-artist-name-hint">{m.admin_new_artist_registry_search_hint()}</p>
				{/if}
				{#if pulled}
					<div class="linked-row">
						<small class="linked">✓ {m.admin_new_artist_registry_linked()}</small>
						<button type="button" class="unlink" onclick={unpick}>{m.admin_new_artist_unlink()}</button>
					</div>
				{/if}
				{#if registryEnabled && importPlan}
					<div class="reg-footer">
						<span>{m.admin_registry_footer_count({ count: importPlan.total })}</span>
						<span aria-hidden="true">·</span>
						<button type="button" class="reg-import-all" onclick={() => (showImportAll = true)}>{m.admin_registry_import_all()}</button>
					</div>
				{/if}
				<div class="sr-only" aria-live="polite">{resultsAnnouncement}</div>
			</div>

			<div class="social-section">
				<h3>{m.admin_artists_col_social()}</h3>
				<div class="social-grid">
					<label class="social-field"><TwitterIcon size={14} /><input type="text" class="input" bind:value={twitter} placeholder="@handle" /></label>
					<label class="social-field"><BlueskyIcon size={14} /><input type="text" class="input" bind:value={bluesky} placeholder="lunarpaws.bsky.social" /></label>
					<label class="social-field"><TelegramIcon size={14} /><input type="text" class="input" bind:value={telegram} placeholder="t.me/lunarpaws" /></label>
					<label class="social-field"><FurAffinityIcon size={14} /><input type="text" class="input" bind:value={furaffinity} placeholder="furaffinity.net/user/lunarpaws" /></label>
					<label class="social-field"><DeviantArtIcon size={14} /><input type="text" class="input" bind:value={deviantart} placeholder="deviantart.com/…" /></label>
					<label class="social-field"><PatreonIcon size={14} /><input type="text" class="input" bind:value={patreon} placeholder="patreon.com/lunarpaws" /></label>
					<label class="social-field"><InstagramIcon size={14} /><input type="text" class="input" bind:value={instagram} placeholder="instagram.com/…" /></label>
				</div>
			</div>

			<div class="modal-actions">
				<button type="button" class="btn btn-secondary" onclick={oncancel}>{m.admin_cancel()}</button>
				<button type="button" class="btn btn-primary" onclick={create} disabled={!name.trim() || saving}>
					{#if saving}
						<Loader2 size={16} class="spin" /> {pulled ? m.admin_registry_importing() : m.admin_new_artist_creating()}
					{:else}
						{pulled ? m.admin_registry_import_artist() : m.admin_new_artist_create()}
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>

{#if showImportAll && importPlan}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-backdrop confirm-layer" onclick={() => { if (!importingAll) showImportAll = false; }} onkeydown={(e) => { if (e.key === 'Escape' && !importingAll) showImportAll = false; }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-label={m.admin_registry_import_all_title()} onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>{m.admin_registry_import_all_title()}</h2>
				<button class="icon-btn" onclick={() => (showImportAll = false)} disabled={importingAll} aria-label={m.admin_close()}><X size={18} /></button>
			</div>
			<div class="confirm-body">
				<p>{m.admin_registry_import_all_message({ count: importPlan.toCreate, skipped: importPlan.skipped })}</p>
				<label class="keep-updated">
					<input type="checkbox" bind:checked={keepUpdated} disabled={importingAll} />
					<span>{m.admin_registry_keep_updated()}</span>
				</label>
				<p class="reassure">{m.admin_registry_editable_note()}</p>
			</div>
			<div class="modal-actions">
				<button type="button" class="btn btn-secondary" onclick={() => (showImportAll = false)} disabled={importingAll}>{m.admin_cancel()}</button>
				<button type="button" class="btn btn-primary" onclick={runImportAll} disabled={importingAll || importPlan.toCreate === 0}>
					{#if importingAll}
						<Loader2 size={16} class="spin" /> {m.admin_registry_importing()}
					{:else}
						{m.admin_registry_import_n({ count: importPlan.toCreate })}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100;
		display: flex; align-items: center; justify-content: center; padding: 24px;
	}
	.modal {
		width: 100%; max-width: 520px; background: var(--card); border: 1px solid var(--border);
		border-radius: var(--radius-m); padding: 22px; max-height: 90vh; overflow-y: auto;
	}
	.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
	.modal-header h2 { font-size: 18px; margin: 0; font-family: var(--font-primary); }
	.icon-btn { background: none; border: none; color: var(--muted-foreground); cursor: pointer; display: inline-flex; }
	.err { background: rgba(248,113,113,0.12); color: #f87171; padding: 8px 12px; border-radius: var(--radius-s); font-size: 13px; margin-bottom: 14px; }
	.modal-form { display: flex; flex-direction: column; gap: 16px; }
	label { display: flex; flex-direction: column; gap: 6px; }
	label > span { font-size: 12px; color: var(--muted-foreground); }
	.social-section h3 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: var(--muted-foreground); }
	.social-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	.social-field { flex-direction: row; align-items: center; gap: 8px; color: var(--muted-foreground); }
	.social-field .input { flex: 1; }
	.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
	.name-block { display: flex; flex-direction: column; gap: 6px; }
	.field-label { font-size: 12px; color: var(--muted-foreground); }
	.name-field { position: relative; display: flex; align-items: center; }
	.name-field .input { flex: 1; }
	.name-spin { position: absolute; right: 10px; color: var(--muted-foreground); pointer-events: none; }
	.reg-hint { margin: 0; font-size: 11px; color: var(--muted-foreground); }
	.reg-results {
		list-style: none; margin: 4px 0 0; padding: 4px; position: absolute; top: 100%; left: 0; right: 0;
		z-index: 10; display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto;
		background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-s); box-shadow: 0 8px 24px rgba(0,0,0,0.28);
	}
	.reg-results li { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 1px solid transparent; border-radius: var(--radius-xs); padding: 6px 10px; cursor: pointer; color: var(--foreground); font-size: 14px; }
	.reg-results li:hover, .reg-results li.active { border-color: var(--primary); background: var(--secondary); }
	.reg-avatar { position: relative; flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; overflow: hidden; background: var(--secondary); }
	.reg-initials { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-primary); font-size: 9px; font-weight: 600; color: var(--muted-foreground); }
	.reg-results img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
	.linked-row { display: flex; align-items: center; gap: 8px; }
	.linked { color: var(--primary); font-size: 12px; }
	.unlink { background: none; border: none; padding: 0; cursor: pointer; color: var(--muted-foreground); font-size: 12px; font-family: inherit; text-decoration: underline; }
	.unlink:hover { color: var(--foreground); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
	.reg-id { display: flex; flex-direction: column; min-width: 0; }
	.reg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.reg-handle { font-size: 11px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.reg-import-pill {
		margin-left: auto; flex-shrink: 0; padding: 1px 8px; font-size: 11px;
		color: var(--primary); border: 1px solid var(--primary); border-radius: var(--radius-pill);
	}
	.reg-footer { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
	.reg-import-all {
		background: none; border: none; padding: 0; cursor: pointer;
		color: var(--primary); font-size: 12px; font-family: inherit;
	}
	.reg-import-all:hover { text-decoration: underline; }
	.confirm-layer { z-index: 110; }
	.confirm-modal { max-width: 440px; }
	.confirm-body { display: flex; flex-direction: column; gap: 12px; font-size: 13px; margin-bottom: 16px; }
	.confirm-body p { margin: 0; line-height: 1.5; }
	.keep-updated { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
	.keep-updated span { font-size: 13px; color: var(--foreground); }
	.keep-updated input { margin: 0; flex-shrink: 0; }
	.reassure { color: var(--muted-foreground); font-size: 12px; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
