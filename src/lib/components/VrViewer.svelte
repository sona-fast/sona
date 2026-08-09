<script lang="ts">
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import { AlertTriangle, Box, Maximize, X } from 'lucide-svelte';
	import { formatBytes } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		/** SAME-ORIGIN path of the model-serving endpoint (/vr/[slug]/model). The
		 * raw model_url must never reach this component — connect-src is 'self'. */
		modelPath: string;
		modelSizeBytes: number | null;
		name: string;
		/** NSFW gate: while nsfw && !revealed the 3D entry point is hidden — the
		 * viewer must not bypass the poster's blur/reveal. */
		nsfw?: boolean;
		revealed?: boolean;
		/** Poster dimensions; the stage/loading panel keep the poster's aspect so
		 * entering 3D doesn't shift the layout (falls back to 4:3). */
		posterWidth?: number | null;
		posterHeight?: number | null;
		/** Whether the 3D view is active/loading — bindable so the page can
		 * disable controls that have no visible effect while the stage covers the
		 * poster (the media strip, R2-D12). */
		active?: boolean;
		/** The poster markup shown until (and after) the 3D view is active. */
		children: Snippet;
	}

	let {
		modelPath,
		modelSizeBytes,
		name,
		nsfw = false,
		revealed = false,
		posterWidth = null,
		posterHeight = null,
		active = $bindable(false),
		children
	}: Props = $props();
	let loading = $state(false);
	let loadedBytes = $state(0);
	let failed = $state(false);
	let webglUnavailable = $state(false);
	// Mirrors document.fullscreenElement so the toggle can expose its state
	// (aria-pressed) — the visual gives no other cue which mode is active.
	let isFullscreen = $state(false);

	let viewer = $state<HTMLDivElement>();
	let stage = $state<HTMLDivElement>();
	let viewButton = $state<HTMLButtonElement>();
	let exitButton = $state<HTMLButtonElement>();
	let fallbackMessage = $state<HTMLParagraphElement>();
	let disposeScene: (() => void) | null = null;
	// Keyboard camera control, wired up once the scene exists (see enter3d).
	let stageKeydown: ((e: KeyboardEvent) => void) | null = null;

	// Exit-during-load guard: every enter3d run takes a generation number, and
	// exit3d bumps it — a run that awakes from an await into a stale generation
	// abandons silently instead of throwing into the "failed to load" state.
	let generation = 0;

	const aspect = $derived(
		posterWidth && posterHeight ? `${posterWidth} / ${posterHeight}` : '4 / 3'
	);

	const progressPercent = $derived(
		modelSizeBytes ? Math.min(100, Math.round((loadedBytes / modelSizeBytes) * 100)) : 0
	);
	// Live-region text, throttled to 10% steps (or whole MB without a total) so a
	// screen reader isn't flooded with a per-chunk announcement stream. The
	// region itself is ALWAYS mounted — live regions inserted together with
	// their first content are often not announced at all.
	const loadingAnnouncement = $derived.by(() => {
		if (!loading) return '';
		if (modelSizeBytes) {
			const stepped = Math.floor(progressPercent / 10) * 10;
			return m.vr_loading_model({
				loaded: formatBytes(Math.round((stepped / 100) * modelSizeBytes)),
				total: formatBytes(modelSizeBytes)
			});
		}
		const wholeMb = Math.floor(loadedBytes / (1024 * 1024)) * 1024 * 1024;
		return m.vr_loading_model_nototal({ loaded: formatBytes(wholeMb) });
	});

	// Click-to-load: three + three-vrm are heavyweight and must NEVER ride the
	// initial bundle — they are dynamically imported here, on activation only
	// (same lazy-import shape as StickerMedia's lottie_light).
	async function enter3d() {
		if (active) return;
		// WebGL first: on a browser without it the heavy imports are pointless.
		const probe = document.createElement('canvas');
		if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
			webglUnavailable = true;
			// The button this click came from unmounts — move focus to the fallback
			// message rather than dropping it on <body>.
			await tick();
			fallbackMessage?.focus();
			return;
		}

		const gen = ++generation;
		active = true;
		loading = true;
		failed = false;
		loadedBytes = 0;
		try {
			const [THREE, { OrbitControls }, { GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] =
				await Promise.all([
					import('three'),
					import('three/addons/controls/OrbitControls.js'),
					import('three/addons/loaders/GLTFLoader.js'),
					import('@pixiv/three-vrm')
				]);
			if (gen !== generation) return;

			// Fetch the model ourselves (same-origin) so byte progress can be
			// reported against the known modelSizeBytes; GLTFLoader then parses the
			// buffer directly. No Draco/KTX2 decoders: CSP allows no wasm or workers.
			const res = await fetch(modelPath);
			if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);
			// Single buffer: preallocate from the declared length (grow only if the
			// origin lied) instead of collecting chunks and copying them again.
			const declared = Number(res.headers.get('content-length')) || modelSizeBytes || 0;
			let buffer = new Uint8Array(declared > 0 ? declared : 1024 * 1024);
			let total = 0;
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (gen !== generation) {
					void reader.cancel();
					return;
				}
				if (total + value.byteLength > buffer.length) {
					const grown = new Uint8Array(Math.max(buffer.length * 2, total + value.byteLength));
					grown.set(buffer.subarray(0, total));
					buffer = grown;
				}
				buffer.set(value, total);
				total += value.byteLength;
				loadedBytes = total;
			}
			if (gen !== generation) return;
			const data =
				total === buffer.length ? buffer.buffer : (buffer.slice(0, total).buffer as ArrayBuffer);

			const loader = new GLTFLoader();
			loader.register((parser) => new VRMLoaderPlugin(parser));
			const gltf = await new Promise<{ userData: { vrm?: unknown } }>((resolve, reject) =>
				loader.parse(data, '', resolve, reject)
			);
			if (gen !== generation) return;
			const vrm = gltf.userData.vrm as {
				scene: import('three').Group;
				update(delta: number): void;
			};
			if (!vrm) throw new Error('not a VRM model');
			// VRM 0.x models face +Z; rotate so both versions face the camera.
			VRMUtils.rotateVRM0(vrm as never);

			loading = false;
			await tick(); // stage <div> renders once loading flips off
			if (gen !== generation) return;

			const host = stage;
			if (!host) throw new Error('viewer stage missing');
			const width = host.clientWidth;
			const height = host.clientHeight;

			const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			renderer.setSize(width, height);
			host.appendChild(renderer.domElement);

			const scene = new THREE.Scene();
			scene.add(vrm.scene);
			scene.add(new THREE.AmbientLight(0xffffff, 1));
			const key = new THREE.DirectionalLight(0xffffff, 2.2);
			key.position.set(1, 2, 2);
			scene.add(key);

			// Frame the model from its bounding box, eye-level-ish.
			const box = new THREE.Box3().setFromObject(vrm.scene);
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 50);
			camera.position.set(center.x, center.y + size.y * 0.1, center.z + Math.max(size.y, size.x) * 1.7);

			const controls = new OrbitControls(camera, renderer.domElement);
			controls.target.copy(center);
			controls.enableDamping = true;
			// Auto-rotate is motion for motion's sake — honor the OS setting.
			controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			controls.autoRotateSpeed = 1.5;

			// Keyboard camera path (OrbitControls is pointer-only): arrows orbit,
			// +/- zoom — reduced-motion users with auto-rotate off would otherwise
			// have a frozen camera and no way to move it without a pointer.
			stageKeydown = (e: KeyboardEvent) => {
				const offset = camera.position.clone().sub(controls.target);
				const spherical = new THREE.Spherical().setFromVector3(offset);
				const step = Math.PI / 24;
				switch (e.key) {
					case 'ArrowLeft':
						spherical.theta -= step;
						break;
					case 'ArrowRight':
						spherical.theta += step;
						break;
					case 'ArrowUp':
						spherical.phi -= step;
						break;
					case 'ArrowDown':
						spherical.phi += step;
						break;
					case '+':
					case '=':
						spherical.radius = Math.max(0.2, spherical.radius * 0.9);
						break;
					case '-':
					case '_':
						spherical.radius = Math.min(40, spherical.radius / 0.9);
						break;
					default:
						return;
				}
				e.preventDefault();
				spherical.makeSafe();
				offset.setFromSpherical(spherical);
				camera.position.copy(controls.target).add(offset);
				camera.lookAt(controls.target);
			};

			const clock = new THREE.Clock();
			let raf = 0;
			const animate = () => {
				raf = requestAnimationFrame(animate);
				vrm.update(clock.getDelta());
				controls.update();
				renderer.render(scene, camera);
			};
			animate();

			// Keep the canvas sized to the stage (fullscreen enter/exit resizes it).
			const ro = new ResizeObserver(() => {
				const w = host.clientWidth;
				const h = host.clientHeight;
				if (!w || !h) return;
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
				renderer.setSize(w, h);
			});
			ro.observe(host);

			disposeScene = () => {
				cancelAnimationFrame(raf);
				ro.disconnect();
				controls.dispose();
				VRMUtils.deepDispose(vrm.scene);
				renderer.dispose();
				renderer.domElement.remove();
				stageKeydown = null;
			};

			// Entering 3D unmounts the "View in 3D" button this click came from —
			// hand focus to Exit 3D instead of letting it fall to <body> (mirrors
			// exit3d's tick-then-focus in the other direction).
			exitButton?.focus();
		} catch {
			if (gen !== generation) return;
			// Failed chunk, failed fetch, or a file that doesn't parse — show the
			// poster again with a quiet error; the rest of the page still works.
			disposeScene?.();
			disposeScene = null;
			active = false;
			loading = false;
			failed = true;
			// The loading panel this failure unmounts held no focus, but the View
			// in 3D button the click came from did — re-land focus there instead
			// of letting it fall to <body> (mirrors exit3d).
			await tick();
			viewButton?.focus();
		}
	}

	async function exit3d() {
		if (document.fullscreenElement) {
			await document.exitFullscreen().catch(() => {});
		}
		generation++;
		disposeScene?.();
		disposeScene = null;
		active = false;
		loading = false;
		failed = false;
		await tick(); // poster + button re-render before focus moves
		viewButton?.focus();
	}

	function toggleFullscreen() {
		if (document.fullscreenElement) {
			void document.exitFullscreen().catch(() => {});
		} else {
			// Fullscreen the WRAPPER, not the bare stage: the controls (Exit 3D,
			// Fullscreen) must stay reachable inside the fullscreen element, or a
			// keyboard user is stuck with only the Esc escape hatch.
			void viewer?.requestFullscreen().catch(() => {});
		}
	}

	$effect(() => () => {
		disposeScene?.();
		disposeScene = null;
	});
</script>

<svelte:document onfullscreenchange={() => (isFullscreen = !!document.fullscreenElement)} />

<div class="viewer" bind:this={viewer}>
	{#if !active}
		{@render children()}
	{:else if loading}
		<div class="loading-panel" style="aspect-ratio: {aspect}">
			<p aria-hidden="true">
				{modelSizeBytes
					? m.vr_loading_model({ loaded: formatBytes(loadedBytes), total: formatBytes(modelSizeBytes) })
					: m.vr_loading_model_nototal({ loaded: formatBytes(loadedBytes) })}
			</p>
			{#if modelSizeBytes}
				<div class="progress-track" aria-hidden="true">
					<div class="progress-fill" style="width: {progressPercent}%"></div>
				</div>
			{/if}
		</div>
	{:else}
		<!-- role="img": the stage is a rendered picture of the model; a generic
		     div would leave the aria-label unexposed. tabindex puts it in the tab
		     order for the keyboard camera bindings above — deliberately on the
		     "image" itself (OrbitControls is pointer-only; reduced-motion users
		     get a frozen camera with no other way to move it), hence the ignores. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="stage"
			bind:this={stage}
			role="img"
			aria-label={name}
			aria-describedby="vr-stage-keys"
			tabindex="0"
			style="aspect-ratio: {aspect}"
			onkeydown={(e) => stageKeydown?.(e)}
		></div>
		<!-- The keyboard camera bindings are invisible; describe them where a
		     screen reader lands (the focusable stage). -->
		<span class="sr-only" id="vr-stage-keys">{m.vr_stage_keys_hint()}</span>
	{/if}

	<!-- Always-mounted live region (inserting one with content skips the
	     announcement); text updates in 10% steps. -->
	<p class="sr-only" role="status">{loadingAnnouncement}</p>

	{#if webglUnavailable}
		<p class="webgl-fallback" role="status" tabindex="-1" bind:this={fallbackMessage}>
			{m.vr_webgl_unavailable()}
		</p>
	{:else if !active}
		{#if !nsfw || revealed}
			<div class="controls">
				<button bind:this={viewButton} class="btn btn-primary" onclick={enter3d}>
					<Box size={16} /> {m.vr_view_in_3d()}
				</button>
			</div>
		{/if}
		{#if failed}
			<!-- Its own row below the actions (not inline beside the orange primary
			     button) and role=alert like the admin upload errors. Banner
			     treatment (destructive tint + icon), not bare caption text that
			     reads like a strip label (DS7, pairs with the R2-A5 token fix). -->
			<p class="load-error" role="alert">
				<AlertTriangle size={14} aria-hidden="true" />
				{m.vr_load_failed()}
			</p>
		{/if}
	{:else}
		<div class="controls">
			<button
				class="btn btn-secondary"
				onclick={toggleFullscreen}
				disabled={loading}
				aria-pressed={isFullscreen}
			>
				<Maximize size={16} /> {m.vr_fullscreen()}
			</button>
			<button bind:this={exitButton} class="btn btn-secondary" onclick={exit3d}>
				<X size={16} /> {m.vr_exit_3d()}
			</button>
		</div>
	{/if}
</div>

<style>
	.viewer {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.viewer:fullscreen {
		background: var(--background);
		padding: 12px;
	}

	.viewer:fullscreen .stage {
		aspect-ratio: auto !important;
		flex: 1;
		min-height: 0;
		border-radius: 0;
	}

	.stage {
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.stage:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}

	.stage :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.loading-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		border-radius: var(--radius-s);
		background: var(--secondary);
		padding: 24px;
	}

	.loading-panel p {
		font-size: 14px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.progress-track {
		width: min(320px, 80%);
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--background);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--primary);
		transition: width 0.2s;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.webgl-fallback {
		font-size: 14px;
		color: var(--muted-foreground);
	}

	.webgl-fallback:focus {
		outline: none;
	}

	.load-error {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		padding: 10px 12px;
		border-radius: var(--radius-s);
		/* Destructive 12% tint carries the severity; the TEXT is --foreground:
		   --destructive over its own tint composites below 4.5:1 on three light
		   themes (R3-A2 — asserted in theme-contrast.test.ts against the real
		   composite surface, not the bare page background). */
		background: color-mix(in srgb, var(--destructive) 12%, transparent);
		color: var(--foreground);
	}

	.load-error :global(svg) {
		flex-shrink: 0;
		/* The icon keeps the destructive color (non-text, 3:1 floor). */
		color: var(--destructive);
	}

	/* .sr-only comes from the global rule in app.css — no local copy. */
</style>
