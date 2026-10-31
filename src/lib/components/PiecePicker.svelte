<script lang="ts">
	// Link a piece (SONA-236): picks a gallery piece for a ledger entry. It opens
	// on the entry artist's pieces, newest first, and can search titles or every
	// piece. Picking only chooses: the page that opened it does the link.
	import { onMount } from 'svelte';
	import { Link2, Loader2, Search } from 'lucide-svelte';
	import { focusTrap } from '$lib/focus-trap';
	import PieceChoices from './PieceChoices.svelte';
	import type { PickerList, PickerPiece, PickerScope } from '$lib/server/commission-link';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		entryId: number;
		/** Linking moves an entry that isn't Delivered yet to Delivered. */
		marksDelivered?: boolean;
		onpick: (piece: PickerPiece) => void;
		oncancel: () => void;
	}

	let { entryId, marksDelivered = false, onpick, oncancel }: Props = $props();

	let query = $state('');
	let scope = $state<PickerScope>('artist');
	let list = $state<PickerList | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let picked = $state<number | null>(null);
	let searchInput = $state<HTMLInputElement>();
	// Which request is current: an answer to any earlier one is stale.
	let seq = 0;

	async function load() {
		const mine = ++seq;
		loading = true;
		failed = false;
		const params = new URLSearchParams({ entry: String(entryId), scope });
		if (query.trim()) params.set('q', query.trim());
		try {
			const res = await fetch(`/api/admin/commission-pieces?${params}`);
			if (!res.ok) throw new Error(String(res.status));
			const next = (await res.json()) as PickerList;
			if (mine !== seq) return;
			list = next;
			// A pick the new list doesn't offer can't be linked from here.
			if (!next.pieces.some((p) => p.id === picked && !p.taken)) picked = null;
		} catch {
			if (mine !== seq) return;
			failed = true;
		}
		loading = false;
	}

	function setScope(next: PickerScope) {
		scope = next;
		void load();
	}

	onMount(() => {
		void load();
		searchInput?.focus();
	});

	const pickedPiece = $derived(list?.pieces.find((p) => p.id === picked && !p.taken) ?? null);

	// One line that says what the list shows when it shows nothing, or that
	// it's loading. A status region, so a search's outcome is read out.
	const statusText = $derived.by(() => {
		if (loading) return m.admin_commissions_pick_loading();
		if (failed || !list) return '';
		if (list.pieces.length > 0) return list.more ? m.admin_commissions_pick_more({ count: list.pieces.length }) : '';
		if (list.query) return m.admin_commissions_pick_no_match({ query: list.query });
		return list.scope === 'artist'
			? m.admin_commissions_pick_none_by_artist({ artist: list.artistName })
			: m.admin_commissions_pick_none();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -- backdrop click-to-dismiss duplicates the Esc/Cancel paths -->
<div class="backdrop" onclick={oncancel}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="piece-picker-title"
		aria-describedby="piece-picker-intro"
		tabindex="-1"
		use:focusTrap={oncancel}
		onclick={(e) => e.stopPropagation()}
	>
		<h2 id="piece-picker-title">{m.admin_commissions_link_piece()}</h2>
		<p id="piece-picker-intro" class="intro">
			{m.admin_commissions_pick_intro()}
			{#if marksDelivered}{m.admin_commissions_pick_marks_delivered()}{/if}
		</p>

		<form
			class="search"
			role="search"
			onsubmit={(e) => {
				e.preventDefault();
				// Search looks through every piece: a piece can sit under another
				// artist's name, and nothing here says the list is one artist's.
				setScope('all');
			}}
		>
			<label for="piece-picker-q" class="sr-only">{m.admin_commissions_pick_search()}</label>
			<span class="search-field">
				<input
					id="piece-picker-q"
					class="input"
					type="search"
					placeholder={m.admin_commissions_pick_search()}
					autocomplete="off"
					bind:value={query}
					bind:this={searchInput}
				/>
			</span>
			<button type="submit" class="btn btn-secondary">
				<Search size={16} aria-hidden="true" />
				{m.admin_commissions_pick_search_button()}
			</button>
		</form>

		<div class="results">
			{#if list && list.pieces.length > 0}
				<PieceChoices {list} bind:picked idPrefix="piece-picker" />
			{/if}
			<p class="status" role="status">
				{#if loading}<Loader2 size={14} class="spin" aria-hidden="true" />{/if}{statusText}
			</p>
			{#if failed}
				<div class="failed" role="alert">
					<span>{m.admin_commissions_pick_load_failed()}</span>
					<button type="button" class="btn-compact" onclick={load}>{m.admin_commissions_pick_retry()}</button>
				</div>
			{/if}
			{#if list && !loading}
				<!-- Offered whatever the list holds: an older piece can sit under
				     another artist name. -->
				{#if list.scope === 'artist'}
					<button type="button" class="btn-compact" onclick={() => setScope('all')}>
						{m.admin_commissions_pick_search_all()}
					</button>
				{:else if list.scope === 'all'}
					<button type="button" class="btn-compact" onclick={() => setScope('artist')}>
						{m.admin_commissions_pick_artist_only({ artist: list.artistName })}
					</button>
				{/if}
			{/if}
		</div>

		<div class="dialog-actions">
			<button type="button" class="btn btn-secondary" onclick={oncancel}>{m.admin_cancel()}</button>
			<button
				type="button"
				class="btn btn-primary"
				disabled={!pickedPiece}
				onclick={() => pickedPiece && onpick(pickedPiece)}
			>
				<Link2 size={16} aria-hidden="true" />
				{m.admin_commissions_pick_confirm()}
			</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
		display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px;
	}
	.dialog {
		background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-m);
		padding: 24px; width: 100%; max-width: 640px; max-height: calc(100dvh - 32px);
		display: flex; flex-direction: column; gap: 12px;
	}
	h2 { font-size: 18px; margin: 0; }
	.intro { font-size: 14px; color: var(--muted-foreground); line-height: 1.5; margin: 0; }
	.search { display: flex; gap: 8px; }
	.search-field { flex: 1; min-width: 0; }
	/* The list scrolls inside the dialog, so the actions stay in view. */
	.results {
		flex: 1; min-height: 8rem; overflow-y: auto; display: flex; flex-direction: column;
		align-items: flex-start; gap: 10px; padding: 2px 4px 4px 2px;
	}
	.results > :global(fieldset) { align-self: stretch; }
	.status { font-size: 13px; color: var(--muted-foreground); margin: 0; display: inline-flex; align-items: center; gap: 6px; }
	.failed { display: flex; align-items: center; gap: 10px; font-size: 13px; }
	.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
</style>
