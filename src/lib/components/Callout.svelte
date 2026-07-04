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

	.callout.success {
		background: color-mix(in srgb, #22c55e 10%, transparent);
		border-color: color-mix(in srgb, #22c55e 25%, transparent);
	}

	.icon {
		display: flex;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.primary .icon {
		color: var(--primary);
	}

	.success .icon {
		color: #22c55e;
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
		color: var(--primary);
	}

	.success .title {
		color: #22c55e;
	}

	.text {
		font-family: var(--font-secondary);
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
</style>
