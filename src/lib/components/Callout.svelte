<script lang="ts">
	let {
		icon,
		title,
		text,
		variant = 'primary'
	}: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		icon: any;
		title: string;
		text: string;
		variant?: 'primary' | 'success';
	} = $props();

	const Icon = $derived(icon);
</script>

<div class="callout {variant}">
	<span class="icon"><Icon size={18} /></span>
	<div class="body">
		<p class="title">{title}</p>
		<p class="text">{text}</p>
	</div>
</div>

<style>
	.callout {
		display: flex;
		gap: 10px;
		padding: 14px 16px;
		border-radius: 8px;
		border: 1px solid transparent;
	}

	.callout.primary {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		border-color: color-mix(in srgb, var(--primary) 25%, transparent);
	}

	/* --status-ok, not a baked-in #22c55e: the raw green is 1.9:1 as text on the
	   light surfaces, and the token already carries a darkened value there. The
	   ink is declared once on the container so the icon and the title inherit it;
	   .text sets its own colour. */
	.callout.success {
		color: var(--status-ok);
		background: color-mix(in srgb, var(--status-ok) 10%, transparent);
		border-color: color-mix(in srgb, var(--status-ok) 25%, transparent);
	}

	.icon {
		display: flex;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.primary .icon {
		color: var(--primary);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.title {
		font-family: var(--font-primary);
		font-weight: 700;
		font-size: 14px;
	}

	.primary .title {
		color: var(--primary-text);
	}

	/* --foreground, not --muted-foreground: the success variant tints the surface
	   behind this text, and muted over that tint falls under 4.5:1 on the light
	   palettes (3.94:1 on terracotta light). --foreground's worst block is 9.33:1
	   on terracotta dark over a card, and src/lib/theme-contrast.test.ts pins it. */
	.text {
		font-family: var(--font-secondary);
		font-size: 13px;
		line-height: 1.5;
		color: var(--foreground);
	}

	/* Neutral ink on a green-tinted surface reads as an accident, so the success
	   variant warms the body 15% toward the ink its own fill is mixed from. Both
	   ends are tokens, so it still follows the palette, and the worst block only
	   drops from 9.33:1 to 8.81:1 (terracotta dark over a card). The primary
	   variant keeps plain --foreground: its fill is a different ink. */
	.success .text {
		color: color-mix(in srgb, var(--foreground) 85%, var(--status-ok));
	}
</style>
