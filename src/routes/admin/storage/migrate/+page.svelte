<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowRight, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form } = $props();

	type Phase = 'confirm' | 'running' | 'done' | 'error';
	type Progress = {
		total: number;
		done: number;
		migrated: number;
		failed: number;
		remaining: number;
		failures: { imageId: number; error: string }[];
		recent: { slug: string; status: 'migrated' | 'failed' }[];
	};

	const allDone = data.total > 0 && data.alreadyOnTarget === data.total;

	let phase = $state<Phase>(allDone ? 'done' : 'confirm');
	let progress = $state<Progress>({
		total: data.total,
		done: data.alreadyOnTarget,
		migrated: 0,
		failed: 0,
		remaining: data.total - data.alreadyOnTarget,
		failures: [],
		recent: []
	});
	let recentActivity = $state<{ slug: string; status: 'migrated' | 'failed' }[]>([]);
	let errorMsg = $state('');
	let cleaning = $state(false);

	const pct = $derived(progress.total ? Math.round((progress.done / progress.total) * 100) : 100);
	const succeeded = $derived(phase === 'done' && progress.remaining === 0 && progress.failed === 0);

	function formatSize(bytes: number): string {
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	async function runMigration() {
		phase = 'running';
		errorMsg = '';
		try {
			// Loop batches until nothing is left, or a batch makes no progress
			// (persistent failures) so we don't spin forever.
			while (true) {
				const res = await fetch('/api/storage/migrate', { method: 'POST' });
				if (!res.ok) throw new Error(m.admin_migrate_request_failed({ status: res.status }));
				progress = await res.json();
				recentActivity = [...progress.recent, ...recentActivity].slice(0, 20);
				if (progress.remaining <= 0) break;
				if (progress.migrated === 0) break; // stuck on failures
			}
			phase = 'done';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : m.admin_migrate_failed();
			phase = 'error';
		}
	}
</script>

<div class="migrate-page">
	<div class="page-header">
		<h1>{m.admin_migrate_title()}</h1>
	</div>

	<div class="route">
		<span class="provider-pill">{data.sourceLabel}</span>
		<ArrowRight size={16} />
		<span class="provider-pill target">{data.targetLabel}</span>
	</div>

	{#if phase === 'confirm'}
		<section class="card">
			<div class="stats">
				<div><span class="stat-num">{progress.total - progress.done}</span><span class="stat-lbl">{m.admin_migrate_stat_to_migrate()}</span></div>
				<div><span class="stat-num">{formatSize(data.totalSize)}</span><span class="stat-lbl">{m.admin_migrate_stat_total_size()}</span></div>
				{#if progress.done > 0}<div><span class="stat-num">{progress.done}</span><span class="stat-lbl">{m.admin_migrate_stat_done()}</span></div>{/if}
			</div>
			<ul class="checklist">
				<li>{m.admin_migrate_check_copy({ target: data.targetLabel, source: data.sourceLabel })}</li>
				<li>{m.admin_migrate_check_online()}</li>
				<li>{m.admin_migrate_check_switch()}</li>
				<li>{m.admin_migrate_check_originals()}</li>
				<li>{m.admin_migrate_check_resume()}</li>
			</ul>
			<div class="actions">
				<a href="/admin/settings" class="btn btn-outline">{m.admin_cancel()}</a>
				<button class="btn btn-primary" onclick={runMigration}>{m.admin_migrate_start()}</button>
			</div>
		</section>
	{:else if phase === 'running'}
		<section class="card">
			<div class="progress-head">
				<span><Loader2 size={16} class="spin" /> {m.admin_migrate_copying({ done: progress.done, total: progress.total })}</span>
				<span>{pct}%</span>
			</div>
			<div class="bar"><div class="bar-fill" style="width: {pct}%"></div></div>
			<p class="muted">{m.admin_migrate_keep_open()}</p>
			{#if recentActivity.length > 0}
				<div class="activity">
					<span class="activity-head">{m.admin_migrate_recent()}</span>
					{#each recentActivity as item}
						<div class="activity-row">
							<span class="activity-slug">{item.slug}</span>
							<span class="activity-status {item.status}">{item.status === 'migrated' ? m.admin_migrate_copied() : m.admin_import_stat_failed()}</span>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{:else if phase === 'done'}
		{#if succeeded}
			<div class="banner ok"><CheckCircle2 size={18} /> {m.admin_migrate_all_done({ total: progress.total, target: data.targetLabel })}</div>
		{:else}
			<div class="banner warn"><AlertTriangle size={18} /> {m.admin_migrate_partial({ done: progress.done, total: progress.total, failed: progress.failed || progress.remaining, source: data.sourceLabel })}</div>
		{/if}

		{#if progress.failures.length > 0}
			<section class="card">
				<h2>{m.admin_migrate_failures()}</h2>
				<ul class="failures">
					{#each progress.failures as f}<li>{m.admin_migrate_failure_item({ id: f.imageId, error: f.error })}</li>{/each}
				</ul>
				<button class="btn btn-outline" onclick={runMigration}>{m.admin_migrate_retry_remaining()}</button>
			</section>
		{/if}

		{#if data.source === 'uploadthing' && data.sourceLeftover !== 0}
			<section class="card danger">
				<h2>{m.admin_migrate_cleanup_heading()}</h2>
				<p class="muted">
					{data.sourceLeftover > 0 ? m.admin_migrate_cleanup_desc_count({ target: data.targetLabel, count: data.sourceLeftover, source: data.sourceLabel }) : m.admin_migrate_cleanup_desc({ target: data.targetLabel, source: data.sourceLabel })}
				</p>
				<form
					method="POST"
					action="?/cleanup"
					use:enhance={() => {
						cleaning = true;
						return async ({ update }) => {
							await update();
							cleaning = false;
						};
					}}
				>
					<button class="btn btn-destructive" disabled={cleaning}>
						{cleaning ? m.admin_migrate_deleting() : m.admin_migrate_delete_originals({ source: data.sourceLabel })}
					</button>
				</form>
			</section>
		{:else if data.source === 'uploadthing'}
			<div class="banner ok"><CheckCircle2 size={18} /> {m.admin_migrate_cleaned({ source: data.sourceLabel })}</div>
		{/if}
	{:else if phase === 'error'}
		<div class="banner err"><AlertTriangle size={18} /> {errorMsg} {m.admin_migrate_nothing_lost({ source: data.sourceLabel })}</div>
		<button class="btn btn-primary" onclick={runMigration}>{m.admin_migrate_try_again()}</button>
	{/if}

	{#if form?.message}<p class="success">{form.message}</p>{/if}
	{#if form?.error}<p class="error">{form.error}</p>{/if}
</div>

<style>
	.migrate-page { max-width: 720px; display: flex; flex-direction: column; gap: 20px; }
	.page-header h1 { font-size: 24px; }
	.route { display: flex; align-items: center; gap: 10px; color: var(--muted-foreground); }
	.provider-pill { padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: 13px; color: var(--foreground); }
	.provider-pill.target { border-color: var(--primary, var(--foreground)); }
	.card { border: 1px solid var(--border); border-radius: var(--radius-s); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
	.card.danger { border-color: var(--destructive, #b91c1c); }
	.card h2 { font-size: 15px; }
	.stats { display: flex; gap: 32px; }
	.stat-num { display: block; font-size: 22px; font-weight: 600; }
	.stat-lbl { font-size: 12px; color: var(--muted-foreground); }
	.checklist { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--muted-foreground); padding-left: 18px; }
	.actions { display: flex; gap: 12px; }
	.progress-head { display: flex; justify-content: space-between; font-size: 14px; align-items: center; }
	.bar { height: 8px; background: var(--secondary); border-radius: var(--radius-pill); overflow: hidden; }
	.bar-fill { height: 100%; background: var(--primary, var(--foreground)); transition: width 0.3s; }
	.muted { font-size: 13px; color: var(--muted-foreground); }
	.activity { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; border-top: 1px solid var(--border); padding-top: 12px; }
	.activity-head { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-foreground); margin-bottom: 6px; }
	.activity-row { display: flex; justify-content: space-between; font-size: 13px; padding: 3px 0; }
	.activity-slug { color: var(--foreground); font-variant-numeric: tabular-nums; }
	.activity-status { font-size: 12px; }
	.activity-status.migrated { color: #4ade80; }
	.activity-status.failed { color: #f87171; }
	.banner { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-s); font-size: 14px; }
	.banner.ok { background: rgba(74, 222, 128, 0.1); color: #4ade80; }
	.banner.warn { background: rgba(245, 166, 35, 0.1); color: #f5a623; }
	.banner.err { background: rgba(185, 28, 28, 0.12); color: #f87171; }
	.failures { font-size: 12px; color: var(--muted-foreground); display: flex; flex-direction: column; gap: 4px; padding-left: 18px; }
	.success { color: #4ade80; font-size: 14px; }
	.error { color: #f87171; font-size: 14px; }
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
