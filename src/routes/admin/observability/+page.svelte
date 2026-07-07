<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import CloudflareSetupDialog from '$lib/components/CloudflareSetupDialog.svelte';
	import { getLocale } from '$lib/paraglide/runtime';

	let { data } = $props();
	const o = $derived(data.observability);
	let showCfSetup = $state(false);

	// --- formatting helpers (locale-aware where it reads as a number) ---
	function fmtInt(n: number): string {
		return new Intl.NumberFormat(getLocale()).format(Math.round(n));
	}
	function fmtCompact(n: number): string {
		return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
	}
	function pct(x: number, digits = 1): string {
		return `${(x * 100).toFixed(digits)}%`;
	}
	function fmtBytes(b: number): string {
		if (b < 1024) return `${b} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let n = b / 1024;
		let i = 0;
		while (n >= 1024 && i < units.length - 1) {
			n /= 1024;
			i++;
		}
		return `${n.toFixed(1)} ${units[i]}`;
	}
	/** Compact relative age, e.g. "5m", "2h", "3d". */
	function ago(ts: string | null): string {
		if (!ts) return '';
		const diff = Date.now() - Date.parse(ts);
		if (!Number.isFinite(diff) || diff < 0) return 'now';
		const s = Math.floor(diff / 1000);
		if (s < 60) return 'now';
		const min = Math.floor(s / 60);
		if (min < 60) return `${min}m`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}h`;
		return `${Math.floor(h / 24)}d`;
	}

	// Sparkline: map the per-day request totals onto a 196x46 viewBox, newest right.
	const SPARK_W = 196;
	const SPARK_H = 46;
	const sparkPoints = $derived.by(() => {
		const values = o.sparkline;
		const max = Math.max(1, ...values);
		const n = values.length;
		if (n <= 1) return `0,${SPARK_H - 4} ${SPARK_W},${SPARK_H - 4}`;
		return values
			.map((v, i) => {
				const x = (i / (n - 1)) * SPARK_W;
				const y = SPARK_H - 4 - (v / max) * (SPARK_H - 8);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});

	/** Colour class for an error/status badge. */
	function statusClass(status: number): 'red' | 'amber' | 'muted' {
		if (status >= 500 || status === 0) return 'red';
		if (status >= 400) return 'amber';
		return 'muted';
	}
</script>

<div class="obs">
	<!-- Header -->
	<div class="obs-head">
		<div>
			<h1>{m.admin_obs_title()} <span class="new">{m.admin_obs_new()}</span></h1>
			<p class="cap">{m.admin_obs_subtitle()}</p>
		</div>
		<span class="range-pill">{m.admin_obs_range_7d()}</span>
	</div>

	<!-- Verdict hero -->
	<section class="card hero verdict-{o.verdict.level}">
		<div class="hero-top">
			<div class="hero-lead">
				<span class="ring"></span>
				<div>
					<div class="eyebrow">{o.verdict.eyebrow}</div>
					<div class="lead">{o.verdict.lead}</div>
					<div class="cap detail">{o.verdict.detail}</div>
				</div>
			</div>
			<div class="hero-spark">
				<svg width={SPARK_W} height={SPARK_H} viewBox="0 0 {SPARK_W} {SPARK_H}" fill="none" aria-hidden="true">
					<polyline points={sparkPoints} stroke="var(--primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
				<div class="mut spark-cap">{m.admin_obs_spark_caption()}</div>
			</div>
		</div>
		<div class="vitals">
			<div class="vital first">
				<div class="vnum">{fmtInt(o.appRequests)}</div>
				<div class="vlbl">{m.admin_obs_vital_requests()}</div>
			</div>
			<div class="vital">
				<div class="vnum">{pct(o.errorRate)}</div>
				<div class="vlbl">{m.admin_obs_vital_error_rate()}</div>
			</div>
			<div class="vital">
				<div class="vnum">
					{fmtInt(o.uploads.ok + o.uploads.fail)}{#if o.uploads.fail > 0}<span class="failed"> · {o.uploads.fail} {m.admin_obs_failed_suffix()}</span>{/if}
				</div>
				<div class="vlbl">{m.admin_obs_vital_uploads()}</div>
			</div>
			<div class="vital">
				<div class="vnum">
					{fmtInt(o.emails.sent + o.emails.failed)}{#if o.emails.failed > 0}<span class="failed"> · {o.emails.failed} {m.admin_obs_failed_suffix()}</span>{/if}
				</div>
				<div class="vlbl">{m.admin_obs_vital_emails()}</div>
			</div>
		</div>
	</section>

	<!-- Recent errors + background jobs -->
	<div class="grid grid-3">
		<section class="card span-2">
			<div class="row-between">
				<h2 class="h2 flush">{m.admin_obs_errors_title()}</h2>
				<span class="mut">{m.admin_obs_errors_caption()}</span>
			</div>
			{#if o.recentErrors.length === 0}
				<p class="empty">{m.admin_obs_errors_empty()}</p>
			{:else}
				<table>
					<thead>
						<tr>
							<th scope="col" class="col-status">{m.admin_obs_col_status()}</th>
							<th scope="col" class="col-route">{m.admin_obs_col_route()}</th>
							<th scope="col">{m.admin_obs_col_message()}</th>
							<th scope="col" class="col-when">{m.admin_obs_col_when()}</th>
						</tr>
					</thead>
					<tbody>
						{#each o.recentErrors as e (e.id)}
							<tr>
								<td><span class="sbadge {statusClass(e.status)}">{e.status}</span></td>
								<td class="code">{e.route}</td>
								<td class="code">{e.message}</td>
								<td class="mut when">{ago(e.ts)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class="card">
			<h2 class="h2">{m.admin_obs_jobs_title()}</h2>
			{#each o.jobs as job, i (job.name)}
				<div class="job-row" class:first={i === 0}>
					<span class:strong={job.status === 'failed'}>{job.label}</span>
					{#if job.status === null}
						<span class="mut"><span class="dot muted"></span> {m.admin_obs_job_never()}</span>
					{:else if job.status === 'failed'}
						<span class="job-failed"><span class="dot red"></span> {m.admin_obs_job_failed()} · {ago(job.ranAt)}</span>
					{:else}
						<span class="mut"><span class="dot green"></span> {m.admin_obs_job_ok()} · {ago(job.ranAt)}</span>
					{/if}
				</div>
			{/each}
		</section>
	</div>

	<!-- Provider health -->
	<div class="section-lead">
		<div class="eyebrow muted-eyebrow">{m.admin_obs_provider_eyebrow()}</div>
		<p class="cap">{m.admin_obs_provider_sub()}</p>
	</div>

	<div class="grid grid-2">
		<!-- Storage -->
		<section class="card">
			<div class="row-between tight">
				<h2 class="h2 flush">
					{o.providers.storage.label}
					{#if o.providers.storage.configured}
						<span class="en">{m.admin_obs_badge_enabled()}</span>
					{:else}
						<span class="dis">{m.admin_obs_badge_not_configured()}</span>
					{/if}
				</h2>
				<span class="mut">{m.admin_obs_storage_sub()}</span>
			</div>
			<div class="stats stats-3">
				<div><div class="snum">{fmtInt(o.providers.storage.uploads)}</div><div class="vlbl">{m.admin_obs_stat_uploads_7d()}</div></div>
				<div><div class="snum" class:red-num={o.providers.storage.failed > 0}>{fmtInt(o.providers.storage.failed)}</div><div class="vlbl">{m.admin_obs_stat_failed_7d()}</div></div>
				<div><div class="snum" class:amber-num={o.providers.storage.failRate > 0}>{pct(o.providers.storage.failRate)}</div><div class="vlbl">{m.admin_obs_stat_fail_rate()}</div></div>
			</div>
			<div class="last-row">
				<span class="mut">{m.admin_obs_last_failure()}</span>
				{#if o.providers.storage.lastFailure}
					<span class="job-failed"><span class="dot red"></span> {o.providers.storage.lastFailure.message} · {ago(o.providers.storage.lastFailure.ts)}</span>
				{:else}
					<span class="mut"><span class="dot green"></span> {m.admin_obs_no_failures()}</span>
				{/if}
			</div>
		</section>

		<!-- Email / Resend -->
		<section class="card">
			<div class="row-between tight">
				<h2 class="h2 flush">
					Resend
					{#if o.providers.email.configured}
						<span class="en">{m.admin_obs_badge_enabled()}</span>
					{:else}
						<span class="dis">{m.admin_obs_badge_not_configured()}</span>
					{/if}
				</h2>
				<span class="mut">{m.admin_obs_email_sub()}</span>
			</div>
			<div class="stats stats-4">
				<div><div class="snum">{fmtInt(o.providers.email.sent)}</div><div class="vlbl">{m.admin_obs_stat_sent_7d()}</div></div>
				<div><div class="snum na">{m.admin_obs_unavailable()}</div><div class="vlbl">{m.admin_obs_stat_delivered()}</div></div>
				<div><div class="snum na">{m.admin_obs_unavailable()}</div><div class="vlbl">{m.admin_obs_stat_bounced()}</div></div>
				<div><div class="snum na">{m.admin_obs_unavailable()}</div><div class="vlbl">{m.admin_obs_stat_complaints()}</div></div>
			</div>
			{#if o.providers.email.lastFailure}
				<div class="last-row">
					<span class="mut">{m.admin_obs_last_send_failure()}</span>
					<span class="job-failed"><span class="dot red"></span> {o.providers.email.lastFailure.message} · {ago(o.providers.email.lastFailure.ts)}</span>
				</div>
			{/if}
			<p class="webhook-note">{m.admin_obs_email_webhook_note()}</p>
		</section>
	</div>

	<!-- Cloudflare edge: streamed (see +page.server.ts). Renders nothing until the
	     deferred query resolves, then the connected panel OR the connect card. -->
	{#await data.cfEdge then cfEdge}
		{#if cfEdge.state === 'connected'}
			<section class="card cf-edge">
				<div class="row-between tight">
					<h2 class="h2 flush">{m.admin_obs_cf_title()} <span class="en">{m.admin_obs_badge_connected()}</span></h2>
					<span class="mut">{m.admin_obs_cf_sub()}</span>
				</div>
				<div class="stats stats-4">
					<div><div class="snum">{pct(cfEdge.cacheHitRate, 0)}</div><div class="vlbl">{m.admin_obs_cf_cache_hit()}</div></div>
					<div><div class="snum">{fmtCompact(cfEdge.cachedRequests)}</div><div class="vlbl">{m.admin_obs_cf_cached()}</div></div>
					<div><div class="snum">{fmtBytes(cfEdge.bytes)}</div><div class="vlbl">{m.admin_obs_cf_bandwidth()}</div></div>
					<div><div class="snum" class:amber-num={cfEdge.threats > 0}>{fmtInt(cfEdge.threats)}</div><div class="vlbl">{m.admin_obs_cf_threats()}</div></div>
				</div>
				<div class="last-row">
					<span class="mut">{m.admin_obs_cf_footer()}</span>
					<a class="mut manage" href="/admin/settings">{m.admin_obs_cf_manage()}</a>
				</div>
			</section>
		{:else}
			<div class="cf-card">
				<div>
					<div class="cf-card-title">{m.admin_obs_cf_card_title()} <span class="mut">· {m.admin_obs_cf_card_optional()}</span></div>
					<div class="mut cf-card-desc">{m.admin_obs_cf_card_desc()}</div>
					{#if cfEdge.state === 'error'}
						<div class="cf-error">{m.admin_obs_cf_error_prefix()} {cfEdge.message}</div>
					{/if}
				</div>
				<button type="button" class="connect-btn" onclick={() => (showCfSetup = true)}>{m.admin_obs_cf_connect()}</button>
			</div>
		{/if}
	{/await}

	<!-- Privacy footer -->
	<div class="privacy">
		<span class="dot green mt"></span>
		<span>{m.admin_obs_privacy_footer()}</span>
	</div>
</div>

{#if showCfSetup}
	<CloudflareSetupDialog onclose={() => (showCfSetup = false)} />
{/if}

<style>
	.obs {
		max-width: 1120px;
	}
	.obs-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 20px;
	}
	h1 {
		font-size: 24px;
		font-weight: 700;
		margin: 0;
	}
	.new {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--status-attention);
		border: 1px solid var(--status-attention);
		border-radius: var(--radius-pill);
		padding: 1px 6px;
		vertical-align: middle;
		margin-left: 8px;
	}
	.cap {
		font-size: 12px;
		color: var(--muted-foreground);
		margin: 6px 0 0;
		max-width: 74ch;
	}
	.mut {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.range-pill {
		flex: none;
		height: 32px;
		padding: 0 14px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		font-size: 13px;
		display: inline-flex;
		align-items: center;
		color: var(--muted-foreground);
	}

	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		padding: 22px;
	}
	.h2 {
		font-size: 15px;
		font-weight: 600;
		margin: 0 0 14px;
	}
	.h2.flush {
		margin-bottom: 0;
	}

	/* Verdict hero */
	.hero {
		padding: 24px 26px;
		margin-bottom: 16px;
	}
	.hero-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 32px;
	}
	.hero-lead {
		display: flex;
		align-items: flex-start;
		gap: 14px;
	}
	.ring {
		width: 12px;
		height: 12px;
		border-radius: var(--radius-pill);
		flex-shrink: 0;
		margin-top: 4px;
	}
	.verdict-ok .ring {
		background: var(--status-ok);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-ok) 14%, transparent);
	}
	.verdict-warn .ring {
		background: var(--status-warn);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-warn) 14%, transparent);
	}
	.verdict-down .ring {
		background: var(--destructive);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--destructive) 16%, transparent);
	}
	.eyebrow {
		font-family: var(--font-primary);
		font-size: 10px;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		font-weight: 600;
	}
	.verdict-ok .eyebrow {
		color: var(--status-ok);
	}
	.verdict-warn .eyebrow {
		color: var(--status-warn);
	}
	.verdict-down .eyebrow {
		color: var(--destructive);
	}
	.lead {
		font-family: var(--font-primary);
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		margin-top: 6px;
	}
	.detail {
		margin-top: 6px;
	}
	.hero-spark {
		text-align: right;
		flex-shrink: 0;
	}
	.hero-spark svg {
		display: block;
	}
	.spark-cap {
		font-family: var(--font-primary);
		margin-top: 6px;
	}
	.vitals {
		display: flex;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.vital {
		flex: 1;
		padding: 0 20px;
		border-left: 1px solid var(--border);
	}
	.vital.first {
		padding-left: 0;
		border-left: none;
	}
	.vnum {
		font-family: var(--font-primary);
		font-size: 19px;
		font-weight: 600;
		line-height: 1;
	}
	.failed {
		font-size: 13px;
		color: var(--status-attention);
		font-weight: 500;
	}
	.vlbl {
		font-size: 11px;
		color: var(--muted-foreground);
		margin-top: 6px;
	}

	.grid {
		display: grid;
		gap: 16px;
	}
	.grid-3 {
		grid-template-columns: repeat(3, 1fr);
	}
	.grid-2 {
		grid-template-columns: repeat(2, 1fr);
		margin-top: 0;
	}
	.span-2 {
		grid-column: span 2;
	}
	.row-between {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.row-between.tight {
		margin-bottom: 2px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 12px;
	}
	th {
		font-family: var(--font-primary);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-foreground);
		text-align: left;
		font-weight: 500;
		padding: 0 0 8px;
	}
	td {
		font-size: 13px;
		padding: 9px 0;
		border-top: 1px solid var(--border);
		vertical-align: top;
	}
	.col-status {
		width: 60px;
	}
	.col-route {
		width: 220px;
	}
	.col-when {
		width: 52px;
		text-align: right;
	}
	.when {
		text-align: right;
	}
	.code {
		font-family: var(--font-primary);
		font-size: 12px;
		color: var(--card-foreground);
		word-break: break-word;
	}
	.sbadge {
		font-family: var(--font-primary);
		font-size: 11px;
		padding: 1px 6px;
		border-radius: var(--radius-xs);
		font-weight: 600;
	}
	.sbadge.red {
		background: color-mix(in srgb, var(--destructive) 20%, transparent);
		color: var(--destructive);
	}
	.sbadge.amber {
		background: color-mix(in srgb, var(--status-warn) 20%, transparent);
		color: var(--status-warn);
	}
	.sbadge.muted {
		background: var(--secondary);
		color: var(--muted-foreground);
	}
	.empty {
		font-size: 13px;
		color: var(--muted-foreground);
		margin: 16px 0 4px;
	}

	.job-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 0;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.job-row.first {
		border-top: none;
	}
	.strong {
		color: var(--foreground);
	}
	.job-failed {
		color: var(--destructive);
		font-size: 13px;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: var(--radius-pill);
		display: inline-block;
	}
	.dot.mt {
		margin-top: 6px;
	}
	.dot.green {
		background: var(--status-ok);
	}
	.dot.red {
		background: var(--destructive);
	}
	.dot.muted {
		background: var(--muted-foreground);
	}

	.section-lead {
		margin: 28px 0 12px;
	}
	.muted-eyebrow {
		color: var(--muted-foreground);
	}

	.en {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--status-ok);
		border: 1px solid color-mix(in srgb, var(--status-ok) 45%, transparent);
		background: color-mix(in srgb, var(--status-ok) 14%, transparent);
		border-radius: var(--radius-pill);
		padding: 1px 7px;
		margin-left: 8px;
		vertical-align: middle;
	}
	.dis {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		padding: 1px 7px;
		margin-left: 8px;
		vertical-align: middle;
	}

	.stats {
		display: grid;
		gap: 12px;
		margin: 14px 0 16px;
	}
	.stats-3 {
		grid-template-columns: repeat(3, 1fr);
	}
	.stats-4 {
		grid-template-columns: repeat(4, 1fr);
	}
	.snum {
		font-family: var(--font-primary);
		font-size: 20px;
		font-weight: 600;
	}
	.snum.na {
		color: var(--muted-foreground);
	}
	.red-num {
		color: var(--destructive);
	}
	.amber-num {
		color: var(--status-warn);
	}

	.last-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-top: 10px;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.manage {
		color: var(--muted-foreground);
		text-decoration: none;
	}
	.manage:hover {
		color: var(--foreground);
	}
	.webhook-note {
		font-size: 11px;
		line-height: 1.5;
		color: var(--muted-foreground);
		margin: 10px 0 0;
	}

	.cf-edge {
		margin-top: 16px;
	}
	.cf-card {
		margin-top: 16px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-m);
		padding: 18px 22px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
	}
	.cf-card-title {
		font-size: 14px;
		font-weight: 500;
	}
	.cf-card-desc {
		margin-top: 5px;
		max-width: 70ch;
	}
	.cf-error {
		margin-top: 8px;
		font-size: 12px;
		color: var(--status-warn);
	}
	.connect-btn {
		flex: none;
		height: 38px;
		padding: 0 16px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: none;
		color: var(--foreground);
		font-size: 14px;
		font-family: var(--font-secondary);
		cursor: pointer;
	}
	.connect-btn:hover {
		background: var(--secondary);
	}

	.privacy {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		margin-top: 26px;
		font-size: 12px;
		color: var(--muted-foreground);
		max-width: 90ch;
	}

	@media (max-width: 900px) {
		.grid-3,
		.grid-2 {
			grid-template-columns: 1fr;
		}
		.span-2 {
			grid-column: span 1;
		}
		.hero-top {
			flex-direction: column;
			gap: 16px;
		}
		.hero-spark {
			text-align: left;
		}
		.vitals {
			flex-wrap: wrap;
			gap: 16px 0;
		}
		.vital {
			flex: 1 1 50%;
			padding-left: 0;
			border-left: none;
		}
		.cf-card {
			flex-direction: column;
			align-items: flex-start;
		}
	}

	/* On narrow phones the recent-errors table has no room for the relative-age
	   column; drop it so the status/route/message stay readable (the age is
	   secondary and still available on wider screens). */
	@media (max-width: 480px) {
		.col-when,
		.when {
			display: none;
		}
	}
</style>
