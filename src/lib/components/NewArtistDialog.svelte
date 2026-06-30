<script lang="ts">
	import { X, Loader2 } from 'lucide-svelte';
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
	}
	let { oncreated, oncancel }: Props = $props();

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

	async function create() {
		if (!name.trim() || saving) return;
		saving = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/artists', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, twitter, bluesky, telegram, furaffinity, deviantart, patreon, instagram })
			});
			if (!res.ok) {
				errorMsg = (await res.text()) || 'Could not create artist.';
				toast.error(errorMsg);
				return;
			}
			oncreated((await res.json()) as { id: number; name: string });
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
	<div class="modal" role="dialog" aria-modal="true" aria-label="New artist" onclick={(e) => e.stopPropagation()}>
		<div class="modal-header">
			<h2>New Artist</h2>
			<button class="icon-btn" onclick={oncancel} aria-label="Close"><X size={18} /></button>
		</div>

		{#if errorMsg}<div class="err">{errorMsg}</div>{/if}

		<div class="modal-form">
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
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
