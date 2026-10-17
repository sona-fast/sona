<script lang="ts">
	// The top of every ledger page: the early-access notice while adding and
	// changing entries waits for the GA date, then the line that says who can
	// read the ledger. "Private" means hidden from visitors, not unreadable, and
	// the lede says so (SONA-236 doc, section 4).
	import * as m from '$lib/paraglide/messages';

	interface Props {
		gate: { open: boolean; gaDate: string | null };
		/** No entries yet: the notice says the ledger unlocks, rather than that
		 * existing entries can still be read and deleted. */
		empty?: boolean;
	}

	let { gate, empty = false }: Props = $props();
</script>

{#if !gate.open && gate.gaDate}
	<div class="notice" role="note">
		<span class="notice-eyebrow">{m.admin_commissions_early_eyebrow()}</span>
		<p>
			{empty
				? m.admin_commissions_gated_empty_pre({ date: gate.gaDate })
				: m.admin_commissions_gated_pre({ date: gate.gaDate })}<a
				href="/admin/settings?tab=account#supporter-key">{m.admin_commissions_gated_link()}</a
			>{m.admin_commissions_gated_post()}
		</p>
	</div>
{/if}
<p class="lede">{m.admin_commissions_lede()}</p>

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 12px 16px;
		margin-bottom: 20px;
		max-width: 720px;
	}
	.notice p {
		font-size: 13px;
		line-height: 1.55;
		margin: 0;
		flex: 1;
		min-width: 0;
		text-wrap: pretty;
		overflow-wrap: anywhere;
	}
	.notice a {
		color: var(--foreground);
		text-decoration: underline;
	}
	.notice-eyebrow {
		font-family: var(--font-primary);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--status-warn);
		flex: none;
		padding-top: 2px;
	}
	.lede {
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.5;
		max-width: 68ch;
		margin: 0 0 24px;
		text-wrap: pretty;
	}
	@media (max-width: 900px) {
		.notice {
			flex-direction: column;
			gap: 4px;
		}
	}
</style>
