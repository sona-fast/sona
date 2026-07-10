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
