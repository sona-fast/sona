<script lang="ts">
	import { ArrowUpRight } from 'lucide-svelte';

	let {
		icon,
		title,
		subtitle = undefined,
		href = undefined,
		external = true,
		highlight = false
	}: {
		// lucide (legacy class) and our brand icons (runes) have different
		// component shapes, so accept any icon component here.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		icon: any;
		title: string;
		/** Optional. A row with no handle or detail to show leaves the subtitle
		 *  out; the 36px badge plus the row padding keep the height either way. */
		subtitle?: string;
		href?: string;
		external?: boolean;
		highlight?: boolean;
	} = $props();

	const Icon = $derived(icon);
</script>

<svelte:element
	this={href ? 'a' : 'div'}
	class="link-row"
	class:highlight
	{href}
	target={href && external ? '_blank' : undefined}
	rel={href && external ? 'noopener noreferrer' : undefined}
>
	<span class="badge"><Icon size={16} /></span>
	<span class="text">
		<span class="title">{title}</span>
		{#if subtitle}<span class="sub">{subtitle}</span>{/if}
	</span>
	{#if href}
		<ArrowUpRight class="arrow" size={16} />
	{/if}
</svelte:element>

<style>
	.link-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 16px;
		border-radius: 8px;
		background: var(--card);
		border: 1px solid var(--border);
		color: var(--foreground);
		text-decoration: none;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	a.link-row:hover {
		border-color: var(--primary);
		text-decoration: none;
	}

	.link-row.highlight {
		border-color: color-mix(in srgb, var(--primary) 40%, transparent);
	}

	.badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
		flex-shrink: 0;
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.title {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 14px;
		letter-spacing: 1px;
		color: var(--foreground);
	}

	.sub {
		font-family: var(--font-secondary);
		font-size: 12px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* On a phone a one-line subtitle clips mid-sentence — /share's "Send directly
	   to @taro — fastest way" loses its tail. Give it a second line there. */
	@media (max-width: 768px) {
		.sub {
			white-space: normal;
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			/* At 320px the column is ~150px, narrower than an unbreakable token
			   such as a long email address, which would otherwise be clipped. */
			overflow-wrap: anywhere;
		}
	}

	.link-row :global(.arrow) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
</style>
