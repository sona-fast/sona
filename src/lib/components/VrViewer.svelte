<script lang="ts">
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import { AlertTriangle, Box, Maximize, Minimize, X } from 'lucide-svelte';
	import { VR_CAMERA_FAR, VR_FRAME_DISTANCE_CAP, formatBytes, frameHumanoid } from '$lib/vr';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		/** SAME-ORIGIN path of the model-serving endpoint (/vr/[slug]/model). The
		 * raw model_url must never reach this component — connect-src permits no
		 * network origin beyond 'self'. */
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
	// Mirrors whether OUR viewer is the fullscreen element so the toggle can
	// swap its accessible name — the visual gives no other cue which mode is
	// active.
	let isFullscreen = $state(false);
	// iPhone Safari has NO element fullscreen API (and iPadOS only the webkit-
	// prefixed one) — when neither exists, fullscreen is a fixed-position
	// overlay instead (SONA-165); this drives the .fs-fallback class.
	let fallbackFullscreen = $state(false);
	// Mode-change announcement for screen readers: entering/exiting fullscreen
	// has no other non-visual cue. Own region, not the loading one.
	let fsAnnouncement = $state('');
	// Elements WE set inert while the overlay fallback is up, so exit restores
	// exactly those and never clears an inert some other code owns.
	let inerted: HTMLElement[] = [];

	let viewer = $state<HTMLDivElement>();
	let stage = $state<HTMLDivElement>();
	let viewButton = $state<HTMLButtonElement>();
	let exitButton = $state<HTMLButtonElement>();
	let fallbackMessage = $state<HTMLParagraphElement>();
	let disposeScene: (() => void) | null = null;
	// Keyboard camera control, wired up once the scene exists (see enter3d).
	let stageKeydown: ((e: KeyboardEvent) => void) | null = null;
	// Whether the user has taken the camera (pointer orbit or keyboard) — the
	// aspect refit in the ResizeObserver stops the moment they do. Reset by
	// every enter3d run.
	let userAdjusted = false;
	// True only between OUR webkitRequestFullscreen call and its change/error
	// event — the document-level webkit error listener must ignore failures it
	// didn't cause (another element's fullscreen attempt).
	let pendingWebkitFs = false;
	// The page's own inline overflow style, captured when the overlay locks
	// scroll so exit restores it instead of clobbering it with ''.
	let prevOverflow = '';

	// Exit-during-load guard: every enter3d run takes a generation number, and
	// exit3d bumps it — a run that awakes from an await into a stale generation
	// abandons silently instead of throwing into the "failed to load" state.
	let generation = 0;
	let abort: AbortController | null = null;

	const aspect = $derived(
		posterWidth && posterHeight ? `${posterWidth} / ${posterHeight}` : '4 / 3'
	);
	// Either fullscreen mode (native or overlay fallback) — drives the toggle's
	// label swap.
	const fsActive = $derived(isFullscreen || fallbackFullscreen);

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
		// Abort the byte stream when exit3d bumps the generation — the stale-gen
		// guards stop WORK, but without an abort the download itself would keep
		// running to completion in the background.
		abort?.abort();
		abort = new AbortController();
		const signal = abort.signal;
		active = true;
		loading = true;
		failed = false;
		loadedBytes = 0;
		userAdjusted = false;
		// Entering 3D unmounts the "View in 3D" button this click came from —
		// hand focus to Exit 3D NOW, before the download, or it sits on <body>
		// for the whole load (mirrors exit3d's tick-then-focus).
		await tick();
		if (gen !== generation) return;
		exitButton?.focus();
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
			const res = await fetch(modelPath, { signal });
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
			if (gen !== generation) {
				// The user exited while parsing — free the parsed scene rather than
				// leaking its geometries/materials/textures.
				const stale = gltf.userData.vrm as { scene?: import('three').Object3D } | undefined;
				if (stale?.scene) VRMUtils.deepDispose(stale.scene);
				return;
			}
			const vrm = gltf.userData.vrm as {
				scene: import('three').Group;
				humanoid?: {
					getRawBoneNode(name: string): import('three').Object3D | null;
				} | null;
				update(delta: number): void;
			};
			if (!vrm) throw new Error('not a VRM model');
			// VRM 0.x models face +Z; rotate so both versions face the camera.
			VRMUtils.rotateVRM0(vrm as never);

			loading = false;
			await tick(); // stage <div> renders once loading flips off
			// Same reasoning as the parse-time guard above: an exit (or unmount)
			// during the tick must free the parsed scene, not abandon it — and the
			// missing-stage throw lands in a catch where disposeScene is still
			// null, so that path disposes here too.
			if (gen !== generation || !stage) {
				VRMUtils.deepDispose(vrm.scene);
				if (gen === generation) throw new Error('viewer stage missing');
				return;
			}
			const host = stage;
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

			// Frame from the humanoid skeleton (frameHumanoid in $lib/vr, where the
			// math and its rationale live): pivot between the hips and head bones,
			// oriented to the model's own forward axis, distance from the
			// head-to-hips span. Raw bones, not normalized ones — raw world
			// positions are where the model actually stands, and the anatomical
			// forward is convention-free (the normalized rig inherits rotateVRM0's
			// yaw, which would frame VRM 0.x models from behind).
			const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, VR_CAMERA_FAR);
			vrm.scene.updateMatrixWorld(true);
			const bonePos = (name: string) => {
				const node = vrm.humanoid?.getRawBoneNode(name);
				return node ? node.getWorldPosition(new THREE.Vector3()) : null;
			};
			const hips = bonePos('hips');
			const head = bonePos('head');
			const leftUpperArm = bonePos('leftUpperArm');
			const rightUpperArm = bonePos('rightUpperArm');
			const framing =
				hips && head
					? frameHumanoid({
							hips,
							head,
							leftUpperArm,
							rightUpperArm,
							aspect: width / height,
							fovDeg: camera.fov
						})
					: null;
			const target = new THREE.Vector3();
			if (framing) {
				target.set(framing.target.x, framing.target.y, framing.target.z);
				camera.position.set(framing.position.x, framing.position.y, framing.position.z);
			} else {
				// No humanoid or a degenerate skeleton: bounding-box framing.
				const box = new THREE.Box3().setFromObject(vrm.scene);
				const size = box.getSize(new THREE.Vector3());
				box.getCenter(target);
				// An empty or hostile geometry yields ±Infinity/NaN here — throw
				// into the load-failed path instead of rendering a blank canvas
				// from an unrenderable camera. disposeScene isn't wired yet, so
				// free what already exists by hand.
				for (const v of [size.x, size.y, size.z, target.x, target.y, target.z]) {
					if (!Number.isFinite(v)) {
						VRMUtils.deepDispose(vrm.scene);
						renderer.dispose();
						renderer.domElement.remove();
						throw new Error('degenerate model geometry');
					}
				}
				camera.position.set(
					target.x,
					target.y + size.y * 0.1,
					target.z + Math.max(size.y, size.x) * 1.7
				);
			}

			const controls = new OrbitControls(camera, renderer.domElement);
			controls.target.copy(target);
			controls.enableDamping = true;
			// Auto-rotate is motion for motion's sake — honor the OS setting.
			controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			controls.autoRotateSpeed = 1.5;

			// A pointer grab marks the camera as user-taken (the keyboard path in
			// stageKeydown marks it too) — the aspect refit in the ResizeObserver
			// below stops the moment either happens.
			const markAdjusted = () => {
				userAdjusted = true;
				controls.removeEventListener('start', markAdjusted);
			};
			controls.addEventListener('start', markAdjusted);

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
						spherical.radius = Math.min(VR_FRAME_DISTANCE_CAP, spherical.radius / 0.9);
						break;
					default:
						return;
				}
				e.preventDefault();
				userAdjusted = true;
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
				// Any resize (fullscreen enter/exit, orientation change) shifts the
				// aspect enough to spoil the skeleton framing — refit the DISTANCE
				// from the cached bones for the new aspect, keeping the current
				// target and direction (so auto-rotate isn't snapped back), but
				// only until the user takes the camera.
				if (!framing || !hips || !head || userAdjusted) return;
				const next = frameHumanoid({
					hips,
					head,
					leftUpperArm,
					rightUpperArm,
					aspect: w / h,
					fovDeg: camera.fov
				});
				if (!next) return;
				const dist = Math.hypot(
					next.position.x - next.target.x,
					next.position.y - next.target.y,
					next.position.z - next.target.z
				);
				camera.position.sub(controls.target).setLength(dist).add(controls.target);
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
		abort?.abort();
		abort = null;
		// Await the native exit transition (~200ms) so the poster doesn't render
		// fullscreen-sized mid-transition.
		await exitAnyFullscreen();
		setFallbackFullscreen(false);
		generation++;
		disposeScene?.();
		disposeScene = null;
		active = false;
		loading = false;
		failed = false;
		await tick(); // poster + button re-render before focus moves
		viewButton?.focus();
	}

	// Safari never shipped the unprefixed element fullscreen API on iOS: iPadOS
	// has only webkitRequestFullscreen, iPhone has nothing at all — the old
	// bare requestFullscreen() call threw synchronously there and the button
	// was a silent no-op (SONA-165).
	function webkitDocument() {
		return document as Document & {
			webkitFullscreenElement?: Element | null;
			webkitExitFullscreen?: () => void;
		};
	}

	function syncFullscreen() {
		// Identity, not truthiness: fullscreening some OTHER element on the page
		// (a <video>, another viewer) must not flip this component's state.
		const el = document.fullscreenElement ?? webkitDocument().webkitFullscreenElement;
		const now = !!el && el === viewer;
		pendingWebkitFs = false;
		if (now === isFullscreen) return;
		isFullscreen = now;
		fsAnnouncement = now ? m.vr_entered_fullscreen() : m.vr_exited_fullscreen();
	}

	/** Leaves native fullscreen (standard or webkit-prefixed) if one is
	 * active; the standard path returns the exit promise so callers can await
	 * the transition, the webkit path an already-resolved one, and null when
	 * there was none to leave. Shared by the toggle and Exit 3D so the
	 * feature-detect chain exists once. */
	function exitAnyFullscreen(): Promise<void> | null {
		if (document.fullscreenElement) {
			return document.exitFullscreen().catch(() => {});
		}
		const doc = webkitDocument();
		if (doc.webkitFullscreenElement) {
			doc.webkitExitFullscreen?.();
			return Promise.resolve();
		}
		return null;
	}

	// Safari fires only the PREFIXED fullscreenchange, which Svelte's typed
	// svelte:document attributes don't know — wire that one by hand. A refused
	// webkitRequestFullscreen surfaces as an error EVENT, not a rejected
	// promise — fall through to the overlay fallback there, but only for a
	// request WE made (pendingWebkitFs): the listener is document-level and
	// hears every element's failures.
	$effect(() => {
		const onWebkitError = () => {
			if (!pendingWebkitFs) return;
			pendingWebkitFs = false;
			setFallbackFullscreen(true);
		};
		document.addEventListener('webkitfullscreenchange', syncFullscreen);
		document.addEventListener('webkitfullscreenerror', onWebkitError);
		return () => {
			document.removeEventListener('webkitfullscreenchange', syncFullscreen);
			document.removeEventListener('webkitfullscreenerror', onWebkitError);
		};
	});

	// The overlay fallback covers the page — lock scroll behind it, take the
	// covered page out of the tab and screen-reader order (inert), and always
	// restore through here (toggle, Escape, exit3d, unmount) so neither can
	// leak.
	function setFallbackFullscreen(on: boolean) {
		if (fallbackFullscreen === on) return;
		fallbackFullscreen = on;
		if (on) {
			// Capture any pre-existing inline overflow so exit restores it
			// instead of clobbering it with ''.
			prevOverflow = document.documentElement.style.overflow;
			document.documentElement.style.overflow = 'hidden';
		} else {
			document.documentElement.style.overflow = prevOverflow;
		}
		if (on) {
			// Inert every sibling on the path from the viewer up to <body>: the
			// overlay only covers them visually. Skip anything already inert —
			// it isn't ours to restore. ('inert' needs iOS/Safari ≥ 15.5 /
			// Chrome 102 / Firefox 112 — on older browsers this walk is a silent
			// no-op and the overlay still works visually, an accepted
			// degradation.)
			for (
				let el: HTMLElement | null = viewer ?? null;
				el && el !== document.body;
				el = el.parentElement
			) {
				for (const sibling of el.parentElement?.children ?? []) {
					if (sibling !== el && sibling instanceof HTMLElement && !sibling.inert) {
						sibling.inert = true;
						inerted.push(sibling);
					}
				}
			}
		} else {
			for (const el of inerted) el.inert = false;
			inerted = [];
		}
		fsAnnouncement = on ? m.vr_entered_fullscreen() : m.vr_exited_fullscreen();
	}

	function toggleFullscreen() {
		if (fallbackFullscreen) {
			setFallbackFullscreen(false);
			return;
		}
		if (exitAnyFullscreen()) return;
		// Fullscreen the WRAPPER, not the bare stage: the controls (Exit 3D,
		// Fullscreen) must stay reachable inside the fullscreen element, or a
		// keyboard user is stuck with only the Esc escape hatch.
		const el = viewer as
			| (HTMLElement & { webkitRequestFullscreen?: () => void })
			| undefined;
		if (el?.requestFullscreen) {
			// A refused request (e.g. an iframe without allow=fullscreen) falls
			// through to the overlay instead of a silent no-op.
			void el.requestFullscreen().catch(() => setFallbackFullscreen(true));
		} else if (el?.webkitRequestFullscreen) {
			// Arm the document-level error listener for exactly this request;
			// syncFullscreen (change) and onWebkitError both disarm it.
			pendingWebkitFs = true;
			el.webkitRequestFullscreen();
		} else if (el) {
			setFallbackFullscreen(true);
		}
	}

	$effect(() => () => {
		// Unmount is an exit: abort an in-flight model download (it would run to
		// completion in the background otherwise) and bump the generation so an
		// awaited stage of enter3d abandons instead of touching a dead DOM.
		abort?.abort();
		abort = null;
		generation++;
		disposeScene?.();
		disposeScene = null;
		// Unlock the page scroll if we unmount mid-overlay (navigation).
		setFallbackFullscreen(false);
	});
</script>

<svelte:document onfullscreenchange={syncFullscreen} />
<!-- Native fullscreen exits on Esc by itself; the overlay fallback needs the
     same escape hatch wired by hand. -->
<svelte:window
	onkeydown={(e) => {
		if (fallbackFullscreen && e.key === 'Escape') setFallbackFullscreen(false);
	}}
/>

<div class="viewer" class:fs-fallback={fallbackFullscreen} bind:this={viewer}>
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
	<!-- Fullscreen mode changes have no non-visual cue — announce them from
	     their own always-mounted region (same mounted-empty rule as above). -->
	<p class="sr-only" role="status">{fsAnnouncement}</p>

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
			<button class="btn btn-secondary fs-toggle" onclick={toggleFullscreen} disabled={loading}>
				<!-- In fullscreen (either kind) the toggle is the only visible way
				     back — the swapped accessible name carries the state (no
				     pressed-state attribute needed). Both label variants share one
				     grid cell so the pill always sizes to the longest label in the
				     active locale and the swap can't shove Exit 3D sideways
				     mid-tap; the inactive variant is visibility-hidden AND
				     aria-hidden, keeping the accessible name to the active label
				     only. -->
				<span class="fs-label" class:inactive={fsActive} aria-hidden={fsActive}>
					<Maximize size={16} /> {m.vr_fullscreen()}
				</span>
				<span class="fs-label" class:inactive={!fsActive} aria-hidden={!fsActive}>
					<Minimize size={16} /> {m.vr_exit_fullscreen()}
				</span>
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
		/* The stage bleeds to the top and side edges (an inline-card frame reads
		   wrong at screen size); only the controls row keeps a bottom inset. */
		padding: 0 0 12px;
	}

	.viewer:fullscreen .stage {
		aspect-ratio: auto !important;
		flex: 1;
		min-height: 0;
		border-radius: 0;
	}

	/* iPhone's no-fullscreen-API fallback: a fixed overlay above the nav
	   (MobileNav sits at 50), mirroring the :fullscreen rules above. Kept as
	   SEPARATE rules on purpose — a browser old enough to need the fallback may
	   not parse :fullscreen, and one unknown selector drops a whole rule. */
	.viewer.fs-fallback {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: var(--background);
		/* Same edge bleed as :fullscreen above: stage to the edges, bottom
		   inset for the controls row. */
		padding: 0 0 12px;
		/* overflow makes the overlay its own (never-scrolling) scroll container,
		   so overscroll-behavior has something to act on and an edge-of-scroll
		   flick inside it can't chain to the page behind (iOS scroll lock is
		   best-effort otherwise). */
		overflow: hidden;
		overscroll-behavior: contain;
	}

	/* Short enter fade so the overlay doesn't pop in. Media-wrapped, so old
	   browsers that can't parse it (and reduced-motion users) skip straight
	   to the final state — it's decoration. */
	@media (prefers-reduced-motion: no-preference) {
		.viewer.fs-fallback {
			animation: vr-fs-fade 150ms ease-out;
		}
	}

	@keyframes vr-fs-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.viewer.fs-fallback .stage {
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

	/* The toggle's two label variants stack in one grid cell so the pill sizes
	   to the longest label in the active locale — the enter/exit label swap
	   never resizes the button (a growing pill shoved Exit 3D sideways
	   mid-tap). */
	.fs-toggle {
		display: grid;
	}

	.fs-toggle .fs-label {
		grid-area: 1 / 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
	}

	.fs-toggle .fs-label.inactive {
		visibility: hidden;
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
