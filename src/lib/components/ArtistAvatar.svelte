<script lang="ts">
	import { avatarColor, avatarInitials } from '$lib/avatar-color';
	import { cdnImage, rawFallback } from '$lib/img';

	interface Props {
		name: string;
		avatarUrl?: string | null;
		/** Rendered diameter in px. */
		size?: number;
		/** Route through the CDN transform at 2x the rendered size — opt-in per
		 * call site (some avatar sources are off-zone and 403 the transform; see
		 * the admin/stickers note). A failed transform retries the raw URL before
		 * falling back to the monogram. */
		cdn?: boolean;
		/** loading="lazy" by default (avatars are never LCP) — pass false for a
		 * genuinely above-the-fold placement that must not wait on the lazy
		 * scheduler. */
		lazy?: boolean;
	}
	let { name, avatarUrl = null, size = 36, cdn = false, lazy = true }: Props = $props();

	// A broken avatar URL falls back to the monogram rather than a broken image
	// (with cdn, first to the untransformed original — off-zone sources 403 the
	// transform). Reset when the URL changes so list rows that reuse this
	// instance re-try.
	let failed = $state(false);
	let useRaw = $state(false);
	$effect(() => {
		void avatarUrl;
		failed = false;
		useRaw = false;
	});
	const displaySrc = $derived(
		cdn && !useRaw && avatarUrl ? cdnImage(avatarUrl, size * 2) : avatarUrl
	);
	function onError() {
		if (cdn && !useRaw) useRaw = true;
		else failed = true;
	}

	let chip = $derived(avatarColor(name));
	// The name always sits as adjacent text at every call site, so the avatar
	// itself is decorative (empty alt / aria-hidden) to avoid a double read.
</script>

{#if avatarUrl && !failed}
	<!-- use:rawFallback backstops the SSR gap (R2-D3): a cdn-transformed
	     off-zone avatar (e.g. Bluesky CDN) can 403 BEFORE hydration, when
	     onerror isn't wired yet — the action's mount-time complete/naturalWidth
	     check swaps the already-failed img to the raw URL, per the documented
	     admin/stickers precedent. Runtime errors still walk the cdn→raw→monogram
	     ladder via onError. -->
	<img
		class="avatar"
		src={displaySrc}
		alt=""
		width={size}
		height={size}
		loading={lazy ? 'lazy' : undefined}
		decoding="async"
		style="--avatar-size: {size}px"
		use:rawFallback={avatarUrl}
		onerror={onError}
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
