<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowRight, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-svelte';

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
				if (!res.ok) throw new Error(`Migration request failed (${res.status})`);
				progress = await res.json();
				recentActivity = [...progress.recent, ...recentActivity].slice(0, 20);
				if (progress.remaining <= 0) break;
				if (progress.migrated === 0) break; // stuck on failures
			}
			phase = 'done';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Migration failed';
			phase = 'error';
		}
	}
</script>

<div class="migrate-page">
	<div class="page-header">
		<h1>Storage Migration</h1>
	</div>

	<div class="route">
		<span class="provider-pill">{data.sourceLabel}</span>
		<ArrowRight size={16} />
		<span class="provider-pill target">{data.targetLabel}</span>
	</div>

	{#if phase === 'confirm'}
		<section class="card">
			<div class="stats">
				<div><span class="stat-num">{progress.total - progress.done}</span><span class="stat-lbl">to migrate</span></div>
				<div><span class="stat-num">{formatSize(data.totalSize)}</span><span class="stat-lbl">total size</span></div>
				{#if progress.done > 0}<div><span class="stat-num">{progress.done}</span><span class="stat-lbl">already done</span></div>{/if}
			</div>
			<ul class="checklist">
				<li>Images are copied to {data.targetLabel}; originals stay on {data.sourceLabel}, untouched.</li>
				<li>Your images stay online the whole time.</li>
				<li>You choose when to switch new uploads over (a separate step).</li>
				<li>Originals are deleted only later, after you confirm everything works.</li>
				<li>Safe to stop and resume — already-copied images are skipped.</li>
			</ul>
			<div class="actions">
				<a href="/admin/settings" class="btn btn-outline">Cancel</a>
				<button class="btn btn-primary" onclick={runMigration}>Start migration</button>
			</div>
		</section>
	{:else if phase === 'running'}
		<section class="card">
			<div class="progress-head">
				<span><Loader2 size={16} class="spin" /> Copying… {progress.done} of {progress.total}</span>
				<span>{pct}%</span>
			</div>
			<div class="bar"><div class="bar-fill" style="width: {pct}%"></div></div>
			<p class="muted">Keep this page open. Migration is resumable — if it stops, reopen and start again to pick up where it left off.</p>
			{#if recentActivity.length > 0}
				<div class="activity">
					<span class="activity-head">Recent activity</span>
					{#each recentActivity as item}
						<div class="activity-row">
							<span class="activity-slug">{item.slug}</span>
							<span class="activity-status {item.status}">{item.status === 'migrated' ? 'Copied' : 'Failed'}</span>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{:else if phase === 'done'}
		{#if succeeded}
			<div class="banner ok"><CheckCircle2 size={18} /> All {progress.total} images are on {data.targetLabel}.</div>
		{:else}
			<div class="banner warn"><AlertTriangle size={18} /> {progress.done} of {progress.total} copied · {progress.failed || progress.remaining} not copied. Originals remain safe on {data.sourceLabel}.</div>
		{/if}

		{#if progress.failures.length > 0}
			<section class="card">
				<h2>Failures</h2>
				<ul class="failures">
					{#each progress.failures as f}<li>Image #{f.imageId}: {f.error}</li>{/each}
				</ul>
				<button class="btn btn-outline" onclick={runMigration}>Retry remaining</button>
			</section>
		{/if}

		{#if data.source === 'uploadthing' && data.sourceLeftover !== 0}
			<section class="card danger">
				<h2>Clean up — delete originals</h2>
				<p class="muted">
					Now that images serve from {data.targetLabel}, delete the
					{data.sourceLeftover > 0 ? `${data.sourceLeftover} ` : ''}leftover
					original{data.sourceLeftover === 1 ? '' : 's'} from {data.sourceLabel} to free space.
					Permanent and irreversible.
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
						{cleaning ? 'Deleting…' : `Delete original files from ${data.sourceLabel}`}
					</button>
				</form>
			</section>
		{:else if data.source === 'uploadthing'}
			<div class="banner ok"><CheckCircle2 size={18} /> Originals cleaned up — nothing left on {data.sourceLabel}.</div>
		{/if}
	{:else if phase === 'error'}
		<div class="banner err"><AlertTriangle size={18} /> {errorMsg} Nothing was lost — originals remain on {data.sourceLabel}.</div>
		<button class="btn btn-primary" onclick={runMigration}>Try again</button>
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
