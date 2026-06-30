<script lang="ts">
	import { onMount } from 'svelte';
	import { cdnImage } from '$lib';

	interface Props {
		format: 'png' | 'webp' | 'animated' | 'video';
		imageUrl: string;
		alt?: string;
		/** Target render width for static stickers, routed through Cloudflare Image
		 * Transformations so grids don't pull multi-MB originals. Ignored for video
		 * and animated (Lottie), which must keep their original source. */
		width?: number;
	}

	let { format, imageUrl, alt = '', width = 360 }: Props = $props();

	let container: HTMLDivElement | undefined = $state();
	let video: HTMLVideoElement | undefined = $state();

	// Animated + video stickers only PLAY while on-screen. A pack grid can hold
	// dozens of them; without this, every <video> decodes and every Lottie runs a
	// requestAnimationFrame loop simultaneously, melting low-end devices. An
	// IntersectionObserver gates playback to visible cards, and Lottie is only
	// instantiated the first time its card scrolls into view.
	onMount(() => {
		if (format === 'video') return setupVideo();
		if (format === 'animated') return setupLottie();
	});

	function setupVideo() {
		const el = video;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) el.play().catch(() => {});
					else el.pause();
				}
			},
			{ rootMargin: '200px' }
		);
		io.observe(el);
		return () => io.disconnect();
	}

	function setupLottie() {
		const el = container;
		if (!el) return;
		// SECURITY: `lottie_light` OMITS the expressions module, which the default
		// build evaluates via Function() at render time — that would be stored XSS in
		// our origin, since sticker JSON is third-party (Telegram packs / uploads).
		// JSON is also validated + asset-stripped at import (see sticker-import.ts).
		let anim: { destroy(): void; play(): void; pause(): void } | null = null;
		let cancelled = false;
		let loading = false;

		const ensureLoaded = async () => {
			if (anim || loading || cancelled) return;
			loading = true;
			try {
				// lottie touches `document`, so import it client-side only.
				const lottie = (await import('lottie-web/build/player/lottie_light')).default;
				if (cancelled) return;
				anim = lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: true, path: imageUrl });
			} catch {
				// Failed chunk / 404 JSON — leave the empty container, don't crash the grid.
			} finally {
				loading = false;
			}
		};

		if (typeof IntersectionObserver === 'undefined') {
			void ensureLoaded(); // no observer support → just load it
			return () => {
				cancelled = true;
				anim?.destroy();
			};
		}

		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) void ensureLoaded().then(() => anim?.play());
					else anim?.pause();
				}
			},
			{ rootMargin: '200px' }
		);
		io.observe(el);

		return () => {
			cancelled = true;
			io.disconnect();
			anim?.destroy();
		};
	}
</script>

{#if format === 'video'}
	<!-- No `autoplay`: play/pause is driven by the on-screen observer above. -->
	<video bind:this={video} src={imageUrl} muted loop playsinline preload="metadata" class="media"></video>
{:else if format === 'animated'}
	<div bind:this={container} class="media lottie-container" aria-label={alt}></div>
{:else}
	<img src={cdnImage(imageUrl, width)} {alt} loading="lazy" class="media" />
{/if}

<style>
	.media {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.lottie-container {
		width: 100%;
		height: 100%;
	}
</style>
