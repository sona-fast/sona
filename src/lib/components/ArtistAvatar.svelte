<script lang="ts">
	import { avatarColor, avatarInitials } from '$lib/avatar-color';
	import { cdnImage } from '$lib/img';

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
		/** loading="lazy" for below-the-fold lists. */
		lazy?: boolean;
	}
	let { name, avatarUrl = null, size = 36, cdn = false, lazy = false }: Props = $props();

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
	<img
		class="avatar"
		src={displaySrc}
		alt=""
		width={size}
		height={size}
		loading={lazy ? 'lazy' : undefined}
		style="--avatar-size: {size}px"
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
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
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
