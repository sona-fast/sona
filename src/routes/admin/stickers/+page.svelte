<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { Smile, Plus, ExternalLink, Pencil, Trash2, Send, Search, Loader2, RefreshCw, AlertTriangle } from 'lucide-svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import SetupDialog from '$lib/components/SetupDialog.svelte';
	import CopyCommand from '$lib/components/CopyCommand.svelte';
	import { toast } from '$lib/toast.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	let showSetup = $state(false);

	// Falls back to the site name, then a generic label, when no persona name is set.
	const ownerName = $derived(data.ownerName || data.siteName || m.admin_stickers_site_owner());

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
		if (pack.shape === 'single' && pack.soleArtist) return m.stickers_by_artist({ artist: pack.soleArtist.name });
		return m.stickers_managed_by_owner({ ownerName, n: pack.artists.length });
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
		<h1>{m.admin_nav_stickers()}</h1>
		<p class="subtitle">{m.admin_stickers_subtitle({ count: data.packs.length })}</p>
	</div>
	<div class="header-actions">
		<a href="/admin/stickers/manual" class="btn btn-outline"><Plus size={16} /> {m.admin_stickers_add_manual()}</a>
		{#if data.telegramEnabled}
			<a href="/admin/stickers/import" class="btn btn-primary"><Send size={16} /> {m.admin_stickers_import_telegram()}</a>
		{:else}
			<span class="btn btn-primary disabled" title={m.admin_stickers_import_disabled_title()}><Send size={16} /> {m.admin_stickers_import_telegram()}</span>
		{/if}
	</div>
</div>

{#if !data.telegramEnabled}
	<div class="banner warn">
		<AlertTriangle size={18} />
		<span class="banner-msg">{m.admin_stickers_disabled_pre()}<code>TELEGRAM_BOT_TOKEN</code>{m.admin_stickers_disabled_post()}</span>
		<button type="button" class="hint-link" onclick={() => (showSetup = true)}>{m.admin_setup_help_link()}</button>
	</div>
{/if}

{#if showSetup}
	<SetupDialog title={m.admin_stickers_setup_title()} sub={m.admin_stickers_setup_sub()} onclose={() => (showSetup = false)}>
		{#snippet icon()}<Send size={15} />{/snippet}
		<p class="lede">{m.admin_stickers_setup_lede()}</p>
		<ol class="steps">
			<li>
				<span class="step-num">1</span>
				<div class="step-body">
					<div class="step-title">{m.admin_stickers_setup_step1_title()}</div>
					<div class="step-text">{m.admin_stickers_setup_step1_a()}<code>@BotFather</code>{m.admin_stickers_setup_step1_b()}<code>/newbot</code>{m.admin_stickers_setup_step1_c()}<code>123456789:AA…</code>{m.admin_stickers_setup_step1_d()}</div>
				</div>
			</li>
			<li>
				<span class="step-num">2</span>
				<div class="step-body">
					<div class="step-title">{m.admin_stickers_setup_step2_title()}</div>
					<div class="step-text">{m.admin_stickers_setup_step2_a()}<code>&lt;your-project&gt;</code>{m.admin_stickers_setup_step2_b()}</div>
					<CopyCommand text="npx wrangler pages secret put TELEGRAM_BOT_TOKEN --project-name <your-project>" />
				</div>
			</li>
			<li>
				<span class="step-num">3</span>
				<div class="step-body">
					<div class="step-title">{m.admin_stickers_setup_step3_title()}</div>
					<div class="step-text">{m.admin_stickers_setup_step3_a()}<code>main</code>{m.admin_stickers_setup_step3_b()}<code>npx wrangler pages deploy</code>{m.admin_stickers_setup_step3_c()}<strong>{m.admin_stickers_import_telegram()}</strong>{m.admin_stickers_setup_step3_d()}<code>t.me/addstickers/…</code>{m.admin_stickers_setup_step3_e()}</div>
				</div>
			</li>
		</ol>
		<div class="unlocks"><strong>{m.admin_stickers_setup_unlocks_label()}</strong>{m.admin_stickers_setup_unlocks_a()}<strong>{m.admin_stickers_import_telegram()}</strong>{m.admin_stickers_setup_unlocks_b()}<code>/admin/stickers/import</code>{m.admin_stickers_setup_unlocks_c()}</div>
	</SetupDialog>
{/if}

{#if data.packs.length === 0}
	<div class="empty">
		<Smile size={36} />
		<p>{m.admin_stickers_empty()}</p>
	</div>
{:else}
	<div class="toolbar">
		<div class="search-wrapper">
			<Search size={16} class="search-icon" />
			<input type="search" class="input search" placeholder={m.admin_stickers_search_placeholder()} bind:value={search} />
		</div>
		<select class="input source-select" bind:value={sourceFilter} aria-label={m.admin_stickers_filter_source()}>
			<option value="all">{m.admin_stickers_all_sources()}</option>
			<option value="telegram">Telegram</option>
			<option value="self-hosted">{m.stickers_source_self_hosted()}</option>
		</select>
	</div>

	<div class="table-wrapper">
		<table class="data-table">
			<thead>
				<tr>
					<th>{m.admin_stickers_col_pack()}</th>
					<th class="col-credit">{m.admin_stickers_col_credit()}</th>
					<th class="col-source">{m.admin_stickers_col_source()}</th>
					<th class="col-count">{m.admin_nav_stickers()}</th>
					<th class="col-status">{m.admin_stickers_col_published()}</th>
					<th class="col-actions">{m.admin_col_actions()}</th>
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
							<span class="source-chip {pack.source}">{pack.source === 'telegram' ? m.stickers_source_telegram() : m.stickers_source_self_hosted()}</span>
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
										if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? m.admin_stickers_update_failed());
										else if (result.type === 'error') toast.error(m.admin_something_wrong());
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
									title={pack.published ? m.admin_images_public_click_hide() : m.admin_images_private_click_publish()}
									aria-label={pack.published ? m.admin_images_make_private() : m.admin_images_make_public()}
								>
									<span class="switch-knob"></span>
								</button>
							</form>
						</td>
						<td class="col-actions" data-label="Actions">
							{#if pack.telegramUrl}
								<a href={pack.telegramUrl} target="_blank" rel="noopener" class="icon-btn" aria-label={m.admin_stickers_open_telegram()}>
									<ExternalLink size={15} />
								</a>
							{/if}
							{#if pack.source === 'telegram' && pack.telegramUrl}
								<button
									type="button"
									class="icon-btn"
									aria-label={m.admin_stickers_resync()}
									title={m.admin_stickers_resync()}
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
							<a href="/admin/stickers/{pack.id}/edit" class="icon-btn" aria-label={m.admin_stickers_edit_aria()}>
								<Pencil size={15} />
							</a>
							<button
								type="button"
								class="icon-btn danger"
								aria-label={m.admin_stickers_delete_aria()}
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
						<td colspan="6" class="no-match">{m.admin_stickers_no_match()}</td>
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
			if (result.type === 'failure') toast.error((result.data as { error?: string })?.error ?? m.admin_stickers_delete_failed());
			else if (result.type === 'error') toast.error(m.admin_something_wrong());
			else toast.success(m.admin_stickers_deleted());
		};
	}}
>
	<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
</form>

{#if deleteTarget}
	<ConfirmDialog
		title={m.admin_stickers_delete_title()}
		message={m.admin_stickers_delete_message({ name: deleteTarget.name })}
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
	.banner :global(svg) { flex-shrink: 0; }
	.banner-msg { flex: 1; min-width: 0; }
	.hint-link {
		flex-shrink: 0; background: none; border: none; padding: 0; cursor: pointer;
		color: #f5a623; font-weight: 600; text-decoration: underline;
		font: inherit; white-space: nowrap;
	}
	code { background: var(--secondary); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

	/* Setup modal body (rendered inside SetupDialog). */
	.lede { font-size: 13px; color: var(--muted-foreground); line-height: 1.6; margin-bottom: 18px; }
	.steps { list-style: none; display: flex; flex-direction: column; gap: 18px; padding: 0; margin: 0; }
	.steps li { display: flex; gap: 14px; }
	.step-num {
		flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
		background: var(--secondary); color: var(--foreground);
		font: 600 13px var(--font-primary); display: flex; align-items: center; justify-content: center;
	}
	.step-body { flex: 1; min-width: 0; }
	.step-title { font-size: 13.5px; font-weight: 600; margin-bottom: 4px; color: var(--foreground); }
	.step-text { font-size: 12.5px; color: var(--muted-foreground); line-height: 1.6; }
	.step-text code { background: var(--secondary); }
	.unlocks {
		margin-top: 18px; padding: 12px 14px; border-left: 2px solid var(--primary);
		background: rgba(255,132,0,0.06); font-size: 12.5px; color: var(--muted-foreground);
		line-height: 1.6; border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
	}
	.unlocks strong { color: var(--foreground); font-weight: 600; }
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
