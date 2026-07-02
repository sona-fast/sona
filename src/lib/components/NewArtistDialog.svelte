<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Loader2, Search } from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte';
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
	}
	let { oncreated, oncancel, title = 'New Artist' }: Props = $props();

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
	let registryEnabled = $state<boolean | null>(null);
	let registryQuery = $state('');
	let registryResults = $state<RegResult[]>([]);
	let registrySearching = $state(false);
	let pulled = $state<{ globalId: string; version: number; avatarUrl: string | null } | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(async () => {
		try {
			const res = await fetch('/api/registry/search?q=');
			if (res.ok) registryEnabled = (await res.json()).enabled ?? false;
		} catch {
			registryEnabled = false;
		}
	});

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
				registryEnabled = data.enabled ?? registryEnabled;
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
				errorMsg = (await res.text()) || 'Could not create artist.';
				toast.error(errorMsg);
				return;
			}
			const result = (await res.json()) as { id: number; name: string; status?: string };
			if (result.status === 'linked')
				toast.success(`Linked to your existing artist "${result.name}"`);
			else if (result.status === 'reused')
				toast.success(`Using your existing registry-linked artist "${result.name}"`);
			oncreated(result);
		} catch {
			errorMsg = 'Network error creating artist.';
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
			<button class="icon-btn" onclick={oncancel} aria-label="Close"><X size={18} /></button>
		</div>

		{#if errorMsg}<div class="err">{errorMsg}</div>{/if}

		<div class="modal-form">
			{#if registryEnabled !== false}
				<div class="registry-search">
					<span class="reg-label">Search shared registry <em>(optional — pull an existing artist)</em></span>
					<div class="reg-input">
						<Search size={14} />
						<input
							type="text"
							class="input"
							bind:value={registryQuery}
							oninput={onRegistryInput}
							placeholder="Find an artist already in the registry…"
						/>
						{#if registrySearching}<Loader2 size={14} class="spin" />{/if}
					</div>
					{#if registryResults.length}
						<ul class="reg-results">
							{#each registryResults as r}
								<li>
									<button type="button" onclick={() => applyResult(r)}>
										{#if r.avatarUrl}<img src={r.avatarUrl} alt="" />{/if}
										<span>{r.name}</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					{#if pulled}<small class="linked">✓ Linked to the shared registry</small>{/if}
				</div>
			{/if}

			<label>
				<span>Artist Name</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input type="text" class="input" bind:value={name} required autofocus placeholder="Artist name…" onkeydown={(e) => { if (e.key === 'Enter') create(); }} />
			</label>

			<div class="social-section">
				<h3>Social Links</h3>
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
				<button type="button" class="btn btn-secondary" onclick={oncancel}>Cancel</button>
				<button type="button" class="btn btn-primary" onclick={create} disabled={!name.trim() || saving}>
					{#if saving}<Loader2 size={16} class="spin" /> Creating…{:else}Create Artist{/if}
				</button>
			</div>
		</div>
	</div>
</div>

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
	.reg-results img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
	.linked { color: var(--primary); font-size: 12px; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
