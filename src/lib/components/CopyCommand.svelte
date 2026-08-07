<script lang="ts">
	import { Copy, Check } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		/** The exact text copied to the clipboard. Also rendered verbatim. */
		text: string;
	}

	let { text }: Props = $props();
	let copied = $state(false);
	// Announced to screen readers on copy — the icon swap alone is silent.
	let announce = $state('');

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			announce = m.admin_setup_copied();
			setTimeout(() => (copied = false), 1200);
		} catch {
			// Clipboard can be unavailable (insecure context / permission).
			announce = m.admin_setup_copy_failed();
		}
	}
</script>

<div class="cmd">{text}<button class="copy" class:copied onclick={copy} aria-label={m.admin_setup_copy()}>
		{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
	</button><span class="sr-only" aria-live="polite">{announce}</span></div>

<style>
	.cmd {
		position: relative;
		margin-top: 10px;
		background: #0e0e0e;
		border: 1px solid var(--border);
		border-radius: var(--radius-s);
		padding: 12px 44px 12px 14px;
		font-family: var(--font-primary);
		font-size: 12px;
		color: #e6e6e6;
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.6;
	}
	:global([data-theme='light']) .cmd { background: #ecedea; color: #1a1a1a; }
	.copy {
		position: absolute;
		top: 8px;
		right: 8px;
		background: var(--secondary);
		border: none;
		color: var(--muted-foreground);
		border-radius: var(--radius-xs);
		padding: 5px;
		display: flex;
		cursor: pointer;
	}
	.copy:hover { color: var(--foreground); }
	.copy.copied { color: var(--primary); }
</style>
