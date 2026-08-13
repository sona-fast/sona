<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { buildReceipt } from '$lib/build-info';

	// The footer's build stamp (SONA-167). An atom because both footer chromes
	// render it: Footer above 768px, MobileCredit below. Returns null outside an
	// Actions build (the define is empty), so dev and tests show no line. See
	// build-info.ts for why the link targets the deploying fork's own repo.
	//
	// `linked` follows the /ai toggle. Actions sets GITHUB_REPOSITORY whether or
	// not the repository is public, so a fork that has not opted into publishing
	// its source pointer shows the SHA as plain text: no repo path in the markup
	// and no link for a visitor to hit a login wall on. A reader only ever sees
	// the /ai page's promise that this links to the source when the page is on,
	// which is exactly when it does.
	let { linked = true }: { linked?: boolean } = $props();
	const receipt = buildReceipt(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__);
</script>

{#if receipt}
	<span class="build">
		{#if receipt.url && linked}
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
