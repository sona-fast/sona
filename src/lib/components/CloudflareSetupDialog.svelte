<script lang="ts">
	// Connect-help dialog for the optional Cloudflare edge-analytics enrichment
	// (issue #6). Reused by both /admin/observability (the connect card) and
	// Settings → Observability, mirroring the Resend SetupDialog pattern. The token
	// is stored as Pages secrets, never in the DB, so there is nothing to submit
	// here — this is guidance only.
	import SetupDialog from './SetupDialog.svelte';
	import CopyCommand from './CopyCommand.svelte';
	import { Cloud, Check, AlertTriangle } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	let { onclose }: { onclose: () => void } = $props();

	const SECRETS = `npx wrangler pages secret put CLOUDFLARE_ANALYTICS_TOKEN --project-name <your-project>
npx wrangler pages secret put CLOUDFLARE_ACCOUNT_ID    --project-name <your-project>
npx wrangler pages secret put CLOUDFLARE_ZONE_ID       --project-name <your-project>`;
</script>

<SetupDialog title={m.admin_cf_setup_title()} sub={m.admin_cf_setup_sub()} {onclose}>
	{#snippet icon()}<Cloud size={15} aria-hidden="true" />{/snippet}

	<p class="lede">{m.admin_cf_setup_lede()}</p>

	<ol class="steps">
		<li>
			<span class="step-num">1</span>
			<div class="step-body">
				<div class="step-title">{m.admin_cf_setup_s1_title()}</div>
				<div class="step-text">{m.admin_cf_setup_s1_text()}</div>
				<div class="scope"><Check size={12} aria-hidden="true" /> {m.admin_cf_setup_s1_scope()}</div>
				<div class="step-text zone">{m.admin_cf_setup_s1_zone()}</div>
			</div>
		</li>
		<li>
			<span class="step-num">2</span>
			<div class="step-body">
				<div class="step-title">{m.admin_cf_setup_s2_title()}</div>
				<div class="step-text">{m.admin_cf_setup_s2_text()}</div>
				<CopyCommand text={SECRETS} />
			</div>
		</li>
		<li>
			<span class="step-num">3</span>
			<div class="step-body">
				<div class="step-title">{m.admin_cf_setup_s3_title()}</div>
				<div class="step-text">{m.admin_cf_setup_s3_text()}</div>
			</div>
		</li>
	</ol>

	<div class="callout">
		<AlertTriangle size={18} aria-hidden="true" />
		<span><strong>{m.admin_cf_setup_callout_strong()}</strong>{m.admin_cf_setup_callout()}</span>
	</div>

	<div class="unlocks"><strong>{m.admin_cf_setup_unlocks_label()}</strong>{m.admin_cf_setup_unlocks()}</div>
</SetupDialog>

<style>
	.lede {
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.6;
		margin: 0 0 18px;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.steps li {
		display: flex;
		gap: 12px;
	}
	.step-num {
		flex: none;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--primary) 16%, transparent);
		color: var(--primary);
		font: 600 12px var(--font-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		margin-top: 1px;
	}
	.step-body {
		min-width: 0;
		flex: 1;
	}
	.step-title {
		font-size: 13.5px;
		font-weight: 600;
		margin-bottom: 3px;
	}
	.step-text {
		font-size: 12.5px;
		color: var(--muted-foreground);
		line-height: 1.55;
	}
	.step-text.zone {
		margin-top: 8px;
	}
	.scope {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
		font-family: var(--font-primary);
		font-size: 11.5px;
		background: color-mix(in srgb, var(--status-ok) 12%, transparent);
		color: var(--status-ok);
		border: 1px solid color-mix(in srgb, var(--status-ok) 45%, transparent);
		border-radius: var(--radius-pill);
		padding: 3px 10px;
	}
	.callout {
		display: flex;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--radius-s);
		background: color-mix(in srgb, var(--status-warn) 12%, transparent);
		color: var(--status-warn);
		font-size: 12.5px;
		line-height: 1.55;
		margin: 20px 0 0;
	}
	.callout :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}
	.callout strong {
		color: var(--status-warn);
	}
	.unlocks {
		margin-top: 18px;
		padding: 12px 14px;
		border-left: 2px solid var(--primary);
		background: color-mix(in srgb, var(--primary) 8%, transparent);
		font-size: 12.5px;
		color: var(--muted-foreground);
		line-height: 1.6;
		border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
	}
	.unlocks strong {
		color: var(--foreground);
		font-weight: 600;
	}
</style>
