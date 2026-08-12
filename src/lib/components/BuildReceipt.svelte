<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { buildReceipt } from '$lib/build-info';

	// The footer's build stamp (SONA-167): the commit this deployment was built
	// from, baked in by vite define from the deploying fork's own Actions env.
	// A self-contained atom like SonaBadge, because it renders in both footer
	// chromes — Footer above 768px, MobileCredit below — and the /ai page points
	// at it as "the source this exact build came from".
	//
	// Null in dev and tests (the define is '' outside Actions), so the line only
	// appears on real deployed builds. Linked only when the building repo is
	// known; see build-info.ts for why it is never a hardcoded upstream URL.
	const receipt = buildReceipt(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__);
</script>

{#if receipt}
	<span class="build">
		{#if receipt.url}
			<a
				href={receipt.url}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={m.footer_build_link_label({ sha: receipt.short })}
			>{m.footer_build({ sha: receipt.short })}</a>
		{:else}
			{m.footer_build({ sha: receipt.short })}
		{/if}
	</span>
{/if}

<style>
	.build {
		font-family: var(--font-primary);
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.build a {
		color: var(--muted-foreground);
		text-decoration: underline;
		transition: color 0.15s;
	}

	.build a:hover {
		color: var(--foreground);
	}
</style>
