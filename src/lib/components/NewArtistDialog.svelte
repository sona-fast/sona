<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Loader2, Search } from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte';
	import * as m from '$lib/paraglide/messages';
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

	// Optional pull from the shared registry: search → pick → prefill + link.
	type RegResult = {
		globalId: string;
		name: string;
		avatarUrl: string | null;
		version: number;
		socials: Record<string, string>;
	};
	let registryQuery = $state('');
	let registryResults = $state<RegResult[]>([]);
	let registrySearching = $state(false);
	let pulled = $state<{ globalId: string; version: number; avatarUrl: string | null } | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

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

	function onRegistryInput() {
		clearTimeout(searchTimer);
		if (registryQuery.trim().length < 2) {
			registryResults = [];
			return;
		}
		searchTimer = setTimeout(searchRegistry, 250);
	}
	async function searchRegistry() {
		registrySearching = true;
		try {
			const res = await fetch('/api/registry/search?q=' + encodeURIComponent(registryQuery.trim()));
			if (res.ok) {
				const data = await res.json();
				registryResults = data.artists ?? [];
			}
		} catch {
			/* ignore — manual entry still works */
		} finally {
			registrySearching = false;
		}
	}
	function applyResult(r: RegResult) {
		name = r.name;
		twitter = r.socials.twitterUrl ?? '';
		bluesky = r.socials.blueskyUrl ?? '';
		telegram = r.socials.telegramUrl ?? '';
		furaffinity = r.socials.furAffinityUrl ?? '';
		deviantart = r.socials.deviantArtUrl ?? '';
		patreon = r.socials.patreonUrl ?? '';
		instagram = r.socials.instagramUrl ?? '';
		pulled = { globalId: r.globalId, version: r.version, avatarUrl: r.avatarUrl };
		registryResults = [];
		registryQuery = r.name;
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
			{#if registryEnabled}
				<div class="registry-search">
					<span class="reg-label">{m.admin_new_artist_registry_label()} <em>{m.admin_new_artist_registry_hint()}</em></span>
					<div class="reg-input">
						<Search size={14} />
						<input
							type="text"
							class="input"
							bind:value={registryQuery}
							oninput={onRegistryInput}
							placeholder={m.admin_new_artist_registry_placeholder()}
						/>
						{#if registrySearching}<Loader2 size={14} class="spin" />{/if}
					</div>
					{#if registryResults.length}
						<ul class="reg-results">
							{#each registryResults as r}
								{@const handle = resultHandle(r)}
								<li>
									<button type="button" onclick={() => applyResult(r)}>
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
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					{#if pulled}<small class="linked">✓ {m.admin_new_artist_registry_linked()}</small>{/if}
					{#if importPlan}
						<div class="reg-footer">
							<span>{m.admin_registry_footer_count({ count: importPlan.total })}</span>
							<span aria-hidden="true">·</span>
							<button type="button" class="reg-import-all" onclick={() => (showImportAll = true)}>{m.admin_registry_import_all()}</button>
						</div>
					{/if}
				</div>
			{/if}

			<label>
				<span>{m.admin_field_artist_name()}</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input type="text" class="input" bind:value={name} required autofocus placeholder={m.admin_upload_artist_name_placeholder()} onkeydown={(e) => { if (e.key === 'Enter') create(); }} />
			</label>

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
	.registry-search { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--secondary); border-radius: var(--radius-s); }
	.reg-label { font-size: 12px; color: var(--muted-foreground); }
	.reg-label em { opacity: 0.7; font-style: italic; }
	.reg-input { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); }
	.reg-input .input { flex: 1; }
	.reg-results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
	.reg-results button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 6px 10px; cursor: pointer; color: var(--foreground); font-size: 14px; }
	.reg-results button:hover { border-color: var(--primary); }
	.reg-avatar { position: relative; flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; overflow: hidden; background: var(--secondary); }
	.reg-initials { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-primary); font-size: 9px; font-weight: 600; color: var(--muted-foreground); }
	.reg-results img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
	.linked { color: var(--primary); font-size: 12px; }
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
