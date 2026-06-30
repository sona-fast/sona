<script lang="ts">
	interface PathEntry {
		href: string;
		label: string;
		description: string;
		// Lucide icon component. Typed loosely: lucide-svelte exports class-style
		// components that don't match Svelte 5's `Component<>` type.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		icon: any;
	}

	let {
		siteName,
		subtitle,
		paths
	}: { siteName: string; subtitle: string; paths: PathEntry[] } = $props();
</script>

<section class="hero">
	<div class="hero-inner container">
		<h1>{siteName}</h1>
		{#if subtitle}
			<p class="subtitle">{subtitle}</p>
		{/if}

		<div class="paths" data-count={paths.length}>
			{#each paths as p}
				<a class="path-card" href={p.href}>
					<span class="icon"><p.icon size={28} /></span>
					<span class="label">{p.label}</span>
					<span class="desc">{p.description}</span>
				</a>
			{/each}
		</div>
	</div>
</section>

<style>
	.hero {
		display: flex;
		justify-content: center;
		padding: 80px 24px 56px;
	}
	.hero-inner {
		width: 100%;
		text-align: center;
	}
	h1 {
		font-family: var(--font-primary);
		font-size: 48px;
		line-height: 1.05;
		margin: 0;
	}
	.subtitle {
		color: var(--muted-foreground);
		font-size: 16px;
		margin: 12px auto 0;
		max-width: 540px;
	}
	.paths {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 16px;
		margin-top: 48px;
	}
	.path-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 32px 24px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		text-decoration: none;
		color: var(--foreground);
		transition: border-color 0.15s, transform 0.15s, background 0.15s;
	}
	.path-card:hover {
		border-color: var(--primary);
		transform: translateY(-3px);
		text-decoration: none;
	}
	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		border-radius: var(--radius-pill);
		background: var(--secondary);
		color: var(--primary);
		margin-bottom: 4px;
	}
	.label {
		font-family: var(--font-primary);
		font-weight: 600;
		font-size: 18px;
	}
	.desc {
		font-size: 13px;
		color: var(--muted-foreground);
	}

	@media (max-width: 768px) {
		.hero {
			padding: 48px 16px 32px;
		}
		h1 {
			font-size: 34px;
		}
		.paths {
			grid-template-columns: 1fr;
			gap: 12px;
		}
		.path-card {
			flex-direction: row;
			justify-content: flex-start;
			text-align: left;
			padding: 16px 20px;
		}
		.icon {
			margin-bottom: 0;
			width: 44px;
			height: 44px;
			flex-shrink: 0;
		}
		.path-card .label,
		.path-card .desc {
			text-align: left;
		}
	}
</style>
