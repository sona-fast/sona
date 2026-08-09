<script lang="ts">
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import { Box, Maximize, X } from 'lucide-svelte';
	import { formatBytes } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		/** SAME-ORIGIN path of the model file (see deriveModelPath). The raw
		 * model_url must never reach this component — connect-src is 'self'. */
		modelPath: string;
		modelSizeBytes: number | null;
		name: string;
		/** The poster markup shown until (and after) the 3D view is active. */
		children: Snippet;
	}

	let { modelPath, modelSizeBytes, name, children }: Props = $props();

	let active = $state(false);
	let loading = $state(false);
	let loadedBytes = $state(0);
	let failed = $state(false);
	let webglUnavailable = $state(false);

	let stage = $state<HTMLDivElement>();
	let viewButton = $state<HTMLButtonElement>();
	let disposeScene: (() => void) | null = null;

	const progressPercent = $derived(
		modelSizeBytes ? Math.min(100, Math.round((loadedBytes / modelSizeBytes) * 100)) : 0
	);

	// Click-to-load: three + three-vrm are heavyweight and must NEVER ride the
	// initial bundle — they are dynamically imported here, on activation only
	// (same lazy-import shape as StickerMedia's lottie_light).
	async function enter3d() {
		if (active) return;
		// WebGL first: on a browser without it the heavy imports are pointless.
		const probe = document.createElement('canvas');
		if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
			webglUnavailable = true;
			return;
		}

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

			// Fetch the model ourselves (same-origin) so byte progress can be
			// reported against the known modelSizeBytes; GLTFLoader then parses the
			// buffer directly. No Draco/KTX2 decoders: CSP allows no wasm or workers.
			const res = await fetch(modelPath);
			if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				total += value.byteLength;
				loadedBytes = total;
			}
			const buffer = new Uint8Array(total);
			let at = 0;
			for (const chunk of chunks) {
				buffer.set(chunk, at);
				at += chunk.byteLength;
			}

			const loader = new GLTFLoader();
			loader.register((parser) => new VRMLoaderPlugin(parser));
			const gltf = await new Promise<{ userData: { vrm?: unknown } }>((resolve, reject) =>
				loader.parse(buffer.buffer, '', resolve, reject)
			);
			const vrm = gltf.userData.vrm as {
				scene: import('three').Group;
				update(delta: number): void;
			};
			if (!vrm) throw new Error('not a VRM model');
			// VRM 0.x models face +Z; rotate so both versions face the camera.
			VRMUtils.rotateVRM0(vrm as never);

			loading = false;
			await tick(); // stage <div> renders once loading flips off

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
			};
		} catch {
			// Failed chunk, failed fetch, or a file that doesn't parse — show the
			// poster again with a quiet error; the rest of the page still works.
			disposeScene?.();
			disposeScene = null;
			active = false;
			loading = false;
			failed = true;
		}
	}

	async function exit3d() {
		if (document.fullscreenElement) {
			await document.exitFullscreen().catch(() => {});
		}
		disposeScene?.();
		disposeScene = null;
		active = false;
		failed = false;
		await tick(); // poster + button re-render before focus moves
		viewButton?.focus();
	}

	function toggleFullscreen() {
		if (document.fullscreenElement) {
			void document.exitFullscreen().catch(() => {});
		} else {
			void stage?.requestFullscreen().catch(() => {});
		}
	}

	$effect(() => () => {
		disposeScene?.();
		disposeScene = null;
	});
</script>

<div class="viewer">
	{#if !active}
		{@render children()}
	{:else if loading}
		<div class="loading-panel">
			<p role="status">
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
		<div class="stage" bind:this={stage} aria-label={name}></div>
	{/if}

	{#if webglUnavailable}
		<p class="webgl-fallback" role="status">{m.vr_webgl_unavailable()}</p>
	{:else if !active}
		<div class="controls">
			<button bind:this={viewButton} class="btn btn-primary" onclick={enter3d}>
				<Box size={16} /> {m.vr_view_in_3d()}
			</button>
			{#if failed}
				<p class="load-error" role="status">{m.vr_load_failed()}</p>
			{/if}
		</div>
	{:else}
		<div class="controls">
			<button class="btn btn-secondary" onclick={toggleFullscreen} disabled={loading}>
				<Maximize size={16} /> {m.vr_fullscreen()}
			</button>
			<button class="btn btn-secondary" onclick={exit3d}>
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

	.stage {
		aspect-ratio: 4 / 3;
		border-radius: var(--radius-s);
		overflow: hidden;
		background: var(--secondary);
	}

	.stage:fullscreen {
		aspect-ratio: auto;
		border-radius: 0;
	}

	.stage :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.loading-panel {
		aspect-ratio: 4 / 3;
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

	.load-error {
		font-size: 13px;
		color: var(--destructive);
	}
</style>
