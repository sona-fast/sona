<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { Smile, Plus, ExternalLink, Pencil, Trash2, Send, Search, Loader2, RefreshCw } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props();

	// Falls back to the site name, then a generic label, when no persona name is set.
	const ownerName = $derived(data.ownerName || data.siteName || 'the site owner');

	let deleteTarget = $state<{ id: number; name: string } | null>(null);
	let deleteForm: HTMLFormElement;
	// Per-row pending state, keyed by pack id, so one row's spinner doesn't block others.
	let togglingIds = $state<Set<number>>(new Set());
	let deletingId = $state<number | null>(null);
	let resyncingId = $state<number | null>(null);

	async function resync(pack: (typeof data.packs)[number]) {
		if (resyncingId !== null || !pack.telegramUrl) return;
		resyncingId = pack.id;
		await goto('/admin/stickers/import?pack=' + encodeURIComponent(pack.telegramUrl) + '&check=1');
	}

	let search = $state('');
	let sourceFilter = $state<'all' | 'telegram' | 'self-hosted'>('all');

	function creditText(pack: (typeof data.packs)[number]): string {
		if (pack.shape === 'single' && pack.soleArtist) return `by ${pack.soleArtist.name}`;
		return `managed by ${ownerName} · ${pack.artists.length} artist${pack.artists.length === 1 ? '' : 's'}`;
	}
	function creditInitial(pack: (typeof data.packs)[number]): string {
		const name = pack.shape === 'single' && pack.soleArtist ? pack.soleArtist.name : ownerName;
		return name.charAt(0).toUpperCase();
	}
	function creditAvatarUrl(pack: (typeof data.packs)[number]): string {
		if (pack.shape === 'single' && pack.soleArtist) return pack.soleArtist.avatarUrl ?? '';
		return data.adminAvatarUrl ?? '';
	}
	function creditAvatarAlt(pack: (typeof data.packs)[number]): string {
		return pack.shape === 'single' && pack.soleArtist ? pack.soleArtist.name : ownerName;
	}

	const filtered = $derived(
		data.packs.filter((p) => {
			if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
			if (!search.trim()) return true;
			const q = search.toLowerCase();
			return (
				p.name.toLowerCase().includes(q) ||
				p.slug.toLowerCase().includes(q) ||
				creditText(p).toLowerCase().includes(q)
			);
		})
	);
</script>

<div class="page-header">
	<div>
		<h1>Stickers</h1>
		<p class="subtitle">Sticker packs for Telegram &amp; self-hosted — {data.packs.length} pack{data.packs.length === 1 ? '' : 's'}</p>
	</div>
	<div class="header-actions">
		<a href="/admin/stickers/manual" class="btn btn-outline"><Plus size={16} /> Add pack manually</a>
		{#if data.telegramEnabled}
			<a href="/admin/stickers/import" class="btn btn-primary"><Send size={16} /> Import from Telegram</a>
		{:else}
			<span class="btn btn-primary disabled" title="Set TELEGRAM_BOT_TOKEN to enable Telegram import"><Send size={16} /> Import from Telegram</span>
		{/if}
	</div>
</div>

{#if !data.telegramEnabled}
	<div class="banner warn">Telegram import is disabled. Set <code>TELEGRAM_BOT_TOKEN</code> to enable it. Manual packs still work.</div>
{/if}

{#if data.packs.length === 0}
	<div class="empty">
		<Smile size={36} />
		<p>No sticker packs yet. Import one from Telegram or add a pack manually.</p>
	</div>
{:else}
	<div class="toolbar">
		<div class="search-wrapper">
			<Search size={16} class="search-icon" />
			<input type="search" class="input search" placeholder="Search packs, artists…" bind:value={search} />
		</div>
		<select class="input source-select" bind:value={sourceFilter} aria-label="Filter by source">
			<option value="all">All sources</option>
			<option value="telegram">Telegram</option>
			<option value="self-hosted">Self-hosted</option>
		</select>
	</div>

	<div class="table-wrapper">
		<table class="data-table">
			<thead>
				<tr>
					<th>Pack</th>
					<th class="col-credit">Credit</th>
					<th class="col-source">Source</th>
					<th class="col-count">Stickers</th>
					<th class="col-status">Published</th>
					<th class="col-actions">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each filtered as pack}
					<tr>
						<td data-label="Pack">
							<div class="pack-cell">
								<span class="pack-name">{pack.name}</span>
								<span class="pack-slug">/stickers/{pack.slug}</span>
							</div>
						</td>
						<td class="col-credit" data-label="Credit">
							<div class="credit">
								{#if creditAvatarUrl(pack)}
									<!-- Avatars can be off-zone (e.g. a Bluesky CDN URL), which
									     Cloudflare Image Transformations refuse (403). They're tiny,
									     so serve the original directly instead of via cdnImage(). -->
									<img src={creditAvatarUrl(pack)} class="credit-avatar-img" alt={creditAvatarAlt(pack)} />
								{:else}
									<span class="credit-avatar">{creditInitial(pack)}</span>
								{/if}
								<span class="credit-text">{creditText(pack)}</span>
							</div>
						</td>
						<td class="col-source" data-label="Source">
							<span class="source-chip {pack.source}">{pack.source === 'telegram' ? 'Telegram' : 'Self-hosted'}</span>
						</td>
						<td class="col-count" data-label="Stickers">{pack.stickerCount}</td>
						<td class="col-status" data-label="Published">
							<form
								method="POST"
								action="?/togglePublished"
								class="inline-form"
								use:enhance={() => {
									const id = pack.id;
									togglingIds = new Set(togglingIds).add(id);
									return async ({ update, result }) => {
										await update({ reset: false });
										togglingIds = new Set([...togglingIds].filter((x) => x !== id));
										if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Could not update pack');
										else if (result.type === 'error') toast.error('Something went wrong');
									};
								}}
							>
								<input type="hidden" name="id" value={pack.id} />
								<button
									type="submit"
									class="switch"
									class:on={pack.published}
									disabled={togglingIds.has(pack.id)}
									role="switch"
									aria-checked={pack.published}
									aria-busy={togglingIds.has(pack.id)}
									title={pack.published ? 'Public — click to hide' : 'Private — click to publish'}
									aria-label={pack.published ? 'Make private' : 'Make public'}
								>
									<span class="switch-knob"></span>
								</button>
							</form>
						</td>
						<td class="col-actions" data-label="Actions">
							{#if pack.telegramUrl}
								<a href={pack.telegramUrl} target="_blank" rel="noopener" class="icon-btn" aria-label="Open on Telegram">
									<ExternalLink size={15} />
								</a>
							{/if}
							{#if pack.source === 'telegram' && pack.telegramUrl}
								<button
									type="button"
									class="icon-btn"
									aria-label="Re-sync from Telegram (import new stickers)"
									title="Re-sync from Telegram (import new stickers)"
									disabled={resyncingId !== null}
									aria-busy={resyncingId === pack.id}
									onclick={() => resync(pack)}
								>
									{#if resyncingId === pack.id}
										<Loader2 size={15} class="spin" />
									{:else}
										<RefreshCw size={15} />
									{/if}
								</button>
							{/if}
							<a href="/admin/stickers/{pack.id}/edit" class="icon-btn" aria-label="Edit pack">
								<Pencil size={15} />
							</a>
							<button
								type="button"
								class="icon-btn danger"
								aria-label="Delete pack"
								disabled={deletingId === pack.id}
								onclick={() => (deleteTarget = { id: pack.id, name: pack.name })}
							>
								{#if deletingId === pack.id}
									<Loader2 size={15} class="spin" />
								{:else}
									<Trash2 size={15} />
								{/if}
							</button>
						</td>
					</tr>
				{/each}
				{#if filtered.length === 0}
					<tr>
						<td colspan="6" class="no-match">No packs match your filters.</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
{/if}

<form
	method="POST"
	action="?/delete"
	bind:this={deleteForm}
	style="display:none"
	use:enhance={() => {
		return async ({ update, result }) => {
			await update({ reset: false });
			deletingId = null;
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? 'Could not delete pack');
			else if (result.type === 'error') toast.error('Something went wrong');
			else toast.success('Pack deleted');
		};
	}}
>
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete sticker pack"
		message={`Delete "${deleteTarget.name}"? All stickers, emoji rows, and stored files will be removed. This can't be undone.`}
		onconfirm={() => { deletingId = deleteTarget?.id ?? null; deleteForm.requestSubmit(); deleteTarget = null; }}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 24px;
		flex-wrap: wrap;
	}
	h1 { font-size: 22px; margin: 0 0 4px; }
	.subtitle { font-size: 13px; color: var(--muted-foreground); margin: 0; }
	.header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
	.btn.disabled { opacity: 0.45; pointer-events: none; cursor: not-allowed; }
	.banner {
		display: flex; align-items: center; gap: 8px; padding: 12px 16px;
		border-radius: var(--radius-s); font-size: 13px; margin-bottom: 16px;
	}
	.banner.warn { background: rgba(245,166,35,0.1); color: #f5a623; }
	code { background: var(--secondary); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
	.empty {
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		padding: 48px; color: var(--muted-foreground); text-align: center;
	}
	.toolbar { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
	.search-wrapper { position: relative; flex: 1; min-width: 220px; }
	.search-wrapper :global(.search-icon) {
		position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
		color: var(--muted-foreground); pointer-events: none;
	}
	.search { padding-left: 38px; width: 100%; }
	.source-select { width: 160px; }
	.table-wrapper { border: 1px solid var(--border); border-radius: var(--radius-s); overflow: hidden; }
	.col-credit { width: 230px; }
	.col-source { width: 120px; }
	.col-count { width: 92px; }
	.col-status { width: 100px; }
	.col-actions { width: 96px; }
	.pack-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.pack-name { font-weight: 500; }
	.pack-slug { font: 11px var(--font-primary); color: var(--muted-foreground); }
	.col-count { font: 13px var(--font-primary); color: var(--foreground); }
	.credit { display: flex; align-items: center; gap: 6px; font-size: 12px; }
	.credit-avatar {
		display: inline-flex; align-items: center; justify-content: center;
		width: 20px; height: 20px; flex-shrink: 0; border-radius: 50%;
		background: var(--secondary); color: var(--muted-foreground);
		font: 600 10px var(--font-secondary);
	}
	.credit-avatar-img {
		width: 20px; height: 20px; flex-shrink: 0; border-radius: 50%;
		object-fit: cover; background: var(--secondary);
	}
	.credit-text { color: var(--muted-foreground); }
	.source-chip {
		display: inline-block; padding: 2px 8px; border-radius: var(--radius-pill);
		font-size: 11px; font-weight: 500;
	}
	.source-chip.telegram { background: rgba(0, 136, 204, 0.15); color: #0088cc; }
	.source-chip.self-hosted { background: var(--secondary); color: var(--muted-foreground); }
	.switch {
		display: inline-flex; align-items: center; padding: 0; border: none; cursor: pointer;
		width: 36px; height: 20px; border-radius: var(--radius-pill);
		background: var(--secondary); transition: background 0.15s;
	}
	.switch.on { background: var(--primary); }
	.switch:disabled { opacity: 0.55; cursor: progress; }
	.switch-knob {
		width: 14px; height: 14px; border-radius: 50%; background: #fff;
		margin-left: 3px; transition: transform 0.15s;
	}
	.switch.on .switch-knob { transform: translateX(16px); }
	.icon-btn {
		background: none; border: none; color: var(--muted-foreground); cursor: pointer;
		padding: 4px; border-radius: var(--radius-xs); display: inline-flex; transition: color 0.15s;
	}
	.icon-btn:hover { color: var(--foreground); }
	.icon-btn.danger:hover { color: var(--destructive); }
	.inline-form { display: inline; }
	/* Keep the cell a real table-cell (NOT display:flex) so the row border spans the
	   full width and the column stays vertically aligned; lay the icons out inline. */
	.col-actions { white-space: nowrap; }
	.data-table td { vertical-align: middle; }
	.col-actions .icon-btn { vertical-align: middle; }
	.col-actions .icon-btn + .icon-btn { margin-left: 4px; }
	.no-match { text-align: center; color: var(--muted-foreground); font-size: 13px; padding: 24px; }
	.icon-btn:disabled { opacity: 0.55; cursor: progress; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Mobile: collapse the table into stacked cards so Published + Actions stay
	   on-screen without horizontal scrolling. Desktop layout above is untouched. */
	@media (max-width: 640px) {
		.table-wrapper { border: none; border-radius: 0; }
		.data-table { display: block; }
		.data-table thead { display: none; }
		.data-table tbody { display: flex; flex-direction: column; gap: 12px; }
		.data-table tr {
			display: block;
			border: 1px solid var(--border);
			border-radius: var(--radius-s);
			background: var(--card, var(--secondary));
			padding: 12px 14px;
		}
		.data-table td {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			width: auto !important;
			padding: 6px 0;
			border: none;
			white-space: normal;
		}
		.data-table td + td { border-top: 1px solid var(--border); }
		/* Label each value with its column header. */
		.data-table td::before {
			content: attr(data-label);
			font: 600 11px var(--font-secondary);
			color: var(--muted-foreground);
			text-transform: uppercase;
			letter-spacing: 0.04em;
			flex-shrink: 0;
		}
		/* Pack name is the card title: full-width, no label. */
		.data-table td[data-label='Pack'] { display: block; padding-top: 0; }
		.data-table td[data-label='Pack']::before { display: none; }
		.pack-cell { gap: 2px; }
		.pack-name { font-size: 15px; }
		.credit { justify-content: flex-end; text-align: right; }
		.col-actions { flex-wrap: wrap; justify-content: flex-end; }
		.col-actions .icon-btn { padding: 8px; }
		/* "No packs match" row spans the card naturally. */
		.no-match { display: block !important; text-align: center; }
		.no-match::before { display: none; }
	}
</style>
