<script lang="ts">
	import { avatarColor, avatarInitials } from '$lib/avatar-color';

	interface Props {
		name: string;
		avatarUrl?: string | null;
		/** Rendered diameter in px. */
		size?: number;
	}
	let { name, avatarUrl = null, size = 36 }: Props = $props();

	// A broken avatar URL falls back to the monogram rather than a broken image.
	// Reset when the URL changes so list rows that reuse this instance re-try.
	let failed = $state(false);
	$effect(() => {
		void avatarUrl;
		failed = false;
	});

	let chip = $derived(avatarColor(name));
	// The name always sits as adjacent text at every call site, so the avatar
	// itself is decorative (empty alt / aria-hidden) to avoid a double read.
</script>

{#if avatarUrl && !failed}
	<img
		class="avatar"
		src={avatarUrl}
		alt=""
		width={size}
		height={size}
		loading="lazy"
		decoding="async"
		style="--avatar-size: {size}px"
		onerror={() => (failed = true)}
	/>
{:else}
	<span
		class="avatar monogram"
		style="--avatar-size: {size}px; background: {chip.bg}; color: {chip.fg}; font-size: {Math.round(
			size * 0.4
		)}px"
		aria-hidden="true">{avatarInitials(name)}</span
	>
{/if}

<style>
	.avatar {
		width: var(--avatar-size);
		height: var(--avatar-size);
		/* Beat the global `img { max-width: 100% }` clamp (app.css) — in narrow table
		   cells it squished the fixed-size avatar into an ellipse (SONA-148). */
		max-width: none;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}
	img.avatar {
		/* Hairline ring so the circular silhouette survives when the avatar's
		   edge pixels match the page background (dark mode especially). An
		   outline, not an inset box-shadow — replaced elements paint over inner
		   shadows. Monograms need no ring: they paint their own background. */
		outline: 1px solid color-mix(in srgb, currentColor 12%, transparent);
		outline-offset: -1px;
	}
	.monogram {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-primary);
		font-weight: 600;
		line-height: 1;
		user-select: none;
	}
</style>
