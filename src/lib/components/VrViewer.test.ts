import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pinned wiring guard for the 3D viewer (SONA-124), same pattern as
// DownloadMenu.test.ts: no component test runner in this repo, and headless
// WebGL is deliberately not driven in e2e — so pin the invariants that would
// otherwise die silently.
const src = readFileSync(new URL('./VrViewer.svelte', import.meta.url), 'utf8');

describe('VrViewer wiring (SONA-124)', () => {
	it('three/three-vrm are DYNAMIC imports only (never on the initial bundle)', () => {
		expect(src).toContain("import('three')");
		expect(src).toContain("import('@pixiv/three-vrm')");
		// A top-level `import ... from 'three'` would put the whole engine on the
		// page bundle for every visitor who never clicks View in 3D.
		expect(src).not.toMatch(/^\s*import[^(]*from\s+'three/m);
		expect(src).not.toMatch(/^\s*import[^(]*from\s+'@pixiv/m);
	});

	it('fetches ONLY the same-origin viewer endpoint path (never a raw model URL)', () => {
		// modelPath is /vr/[slug]/model; connect-src permits no network origin
		// beyond 'self', and the raw (possibly cross-origin) model_url must never
		// reach this component.
		expect(src).toContain('await fetch(modelPath, { signal })');
		expect(src.match(/\bfetch\(/g)?.length).toBe(1);
		expect(src).not.toContain('modelUrl');
	});

	it('disposes the scene in the $effect teardown (leak on navigate otherwise)', () => {
		const cleanup = src.match(/\$effect\(\(\) => \(\) => \{[\s\S]*?\}\)/)?.[0];
		expect(cleanup).toBeDefined();
		expect(cleanup).toContain('disposeScene?.()');
	});

	it('hides the 3D entry point while nsfw && !revealed (the reveal gate, D3)', () => {
		expect(src).toMatch(/\{#if !nsfw \|\| revealed\}[\s\S]*?vr_view_in_3d/);
	});

	it('exposes the stage as an image with a name and keyboard access (A1/A2)', () => {
		const stage = src.match(/<div(?=[^>]*class="stage")[^>]*>/)?.[0];
		expect(stage).toBeDefined();
		expect(stage).toContain('role="img"');
		expect(stage).toContain('aria-label={name}');
		expect(stage).toContain('tabindex="0"');
		expect(stage).toContain('onkeydown');
	});

	it('fullscreens the wrapper (controls included), not the bare stage (A4)', () => {
		// The element the toggle hands to the fullscreen APIs is the viewer
		// wrapper — nothing ever fullscreens the bare stage.
		const toggle = src.match(/function toggleFullscreen\(\)[\s\S]*?\n\t\}/)?.[0];
		expect(toggle).toBeDefined();
		expect(toggle).toMatch(/=\s*viewer\b[\s\S]*el\?\.requestFullscreen/);
		expect(src).not.toContain('stage?.requestFullscreen()');
		expect(src).not.toContain('stage.requestFullscreen()');
	});

	it('feature-detects fullscreen with webkit + overlay fallbacks (iPhone, SONA-165)', () => {
		// iPhone Safari has no element fullscreen API and iPadOS only the
		// prefixed one — a bare requestFullscreen() call throws synchronously
		// there, so the toggle must detect before calling, then fall back to the
		// fixed-overlay mode. Safari's prefixed events (change AND error) are
		// wired by hand, symmetrically added and removed.
		expect(src).toContain('el?.requestFullscreen');
		expect(src).toContain('el?.webkitRequestFullscreen');
		expect(src).toContain('setFallbackFullscreen(true)');
		expect(src).toContain("document.addEventListener('webkitfullscreenchange', syncFullscreen)");
		expect(src).toContain("document.removeEventListener('webkitfullscreenchange', syncFullscreen)");
		// A REFUSED fullscreen request also lands on the overlay: the standard
		// promise rejection (iframe without allow=fullscreen) and the webkit
		// error event (iPadOS).
		expect(src).toContain('.catch(() => setFallbackFullscreen(true))');
		expect(src).toContain("document.addEventListener('webkitfullscreenerror', onWebkitError)");
		expect(src).toContain("document.removeEventListener('webkitfullscreenerror', onWebkitError)");
		// The document-level error listener only acts on a request THIS component
		// made — armed right before webkitRequestFullscreen, ignored otherwise —
		// so another element's failed attempt can't flip us to the overlay…
		expect(src).toMatch(/pendingWebkitFs = true;\s*\n\s*el\.webkitRequestFullscreen\(\)/);
		expect(src).toMatch(/if \(!pendingWebkitFs\) return/);
		// …and fullscreen state tracks OUR element by identity, so fullscreening
		// the page's <video> can't flip this component's state or label.
		expect(src).toContain('el === viewer');
		// Leaving webkit fullscreen goes through the prefixed exit call.
		expect(src).toContain('doc.webkitExitFullscreen?.()');
		// A toggle press while ANY native fullscreen is active exits it rather
		// than stacking a second request.
		expect(src).toMatch(/if \(exitAnyFullscreen\(\)\) return/);
		// The overlay honors Escape like native fullscreen does…
		expect(src).toMatch(/fallbackFullscreen && e\.key === 'Escape'/);
		// …styles via its own class (the stylesheet documents why its rules
		// never share a selector group with :fullscreen)…
		expect(src).toContain('class:fs-fallback={fallbackFullscreen}');
		// …and every exit path clears it: the toggle, Escape, Exit 3D, unmount.
		expect((src.match(/setFallbackFullscreen\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it('locks page scroll behind the overlay and restores the PREVIOUS inline value on exit', () => {
		expect(src).toContain('prevOverflow = document.documentElement.style.overflow');
		expect(src).toContain("document.documentElement.style.overflow = 'hidden'");
		expect(src).toContain('document.documentElement.style.overflow = prevOverflow');
		// Idempotence guard: a repeat call (e.g. unmount after exit3d already
		// cleared the overlay) is a no-op, not a spurious exit announcement.
		expect(src).toMatch(/if \(fallbackFullscreen === on\) return/);
	});

	it('inerts the page behind the overlay and restores exactly what it set', () => {
		// While the fallback overlay is up, the covered page must leave the tab
		// and screen-reader order; on exit only OUR inerts are cleared — anything
		// already inert is skipped on the way in and left alone on the way out.
		expect(src).toContain('&& !sibling.inert');
		expect(src).toContain('sibling.inert = true');
		expect(src).toContain('inerted.push(sibling)');
		expect(src).toMatch(/for \(const el of inerted\) el\.inert = false/);
		expect(src).toContain('inerted = []');
	});

	it('carries fullscreen state in the toggle NAME and announces mode changes', () => {
		// No aria-pressed: the swapped accessible name (Exit fullscreen +
		// Minimize icon) carries the state. The inactive label variant leaves
		// the accessibility tree so the name is only the active label, and a
		// status region announces both native and overlay mode changes.
		expect(src).not.toContain('aria-pressed');
		expect(src).toMatch(/class:inactive=\{!fsActive\}[\s\S]*?vr_exit_fullscreen/);
		expect(src).toMatch(/aria-hidden=\{fsActive\}/);
		expect(src).toMatch(/<p class="sr-only" role="status">\{fsAnnouncement\}<\/p>/);
		expect(src).toContain(
			'fsAnnouncement = now ? m.vr_entered_fullscreen() : m.vr_exited_fullscreen()'
		);
		expect(src).toContain(
			'fsAnnouncement = on ? m.vr_entered_fullscreen() : m.vr_exited_fullscreen()'
		);
		// fsActive covers BOTH modes — collapsing it to isFullscreen alone would
		// leave the iPhone overlay showing "Fullscreen" while the overlay is up.
		expect(src).toContain('$derived(isFullscreen || fallbackFullscreen)');
	});

	it('frames from the humanoid skeleton, bounding box only as fallback (SONA-165)', () => {
		// Camera framing goes through the unit-tested frameHumanoid (pivot
		// between hips and head, model-forward axis, distance from span) fed by
		// RAW bone world positions; Box3 survives only in the no-humanoid branch.
		expect(src).toMatch(/import \{[^}]*frameHumanoid[^}]*\} from '\$lib\/vr'/);
		expect(src).toContain('getRawBoneNode');
		// World matrices refresh BEFORE any bone is sampled — stale matrices
		// frame from wherever the loader left the nodes.
		expect(src).toMatch(/updateMatrixWorld\(true\)[\s\S]*getRawBoneNode/);
		expect(src).toMatch(/frameHumanoid\(\{/);
		// The far plane and framing cap come from one shared constant.
		expect(src).toMatch(/PerspectiveCamera\(30, width \/ height, 0\.1, VR_CAMERA_FAR\)/);
		const fallback = src.match(/const framing =[\s\S]*?controls\.target\.copy\(target\)/)?.[0];
		expect(fallback).toBeDefined();
		expect(fallback).toContain('new THREE.Box3().setFromObject(vrm.scene)');
		// A degenerate box (±Infinity/NaN) throws into the load-failed path
		// instead of rendering a blank canvas from an unrenderable camera.
		expect(fallback).toContain("throw new Error('degenerate model geometry')");
	});

	it('refits the framing distance inside the ResizeObserver, until the user takes the camera', () => {
		const ro = src.match(/new ResizeObserver\(\(\) => \{[\s\S]*?\n\t\t\t\}\);/)?.[0];
		expect(ro).toBeDefined();
		// The canvas/aspect sizing stays…
		expect(ro).toContain('camera.aspect = w / h');
		expect(ro).toContain('renderer.setSize(w, h)');
		// …the refit is ADDITIVE in the same callback (fires after layout on
		// fullscreen enter/exit, orientation changes, window resizes), stopping
		// the moment the user takes the camera…
		expect(ro).toMatch(/\|\| userAdjusted\) return/);
		expect(ro).toContain('frameHumanoid({');
		// …recomputed for the LIVE aspect (a constant would defeat the refit).
		expect(ro).toContain('aspect: w / h');
		// …and rescales the CURRENT camera offset, preserving direction and
		// target so auto-rotate isn't snapped back.
		expect(ro).toContain(
			'camera.position.sub(controls.target).setLength(dist).add(controls.target)'
		);
		// The keyboard camera path marks the camera user-taken too — the
		// pointer-only OrbitControls 'start' event would miss it and the refit
		// would erase a keyboard zoom.
		const keydown = src.match(/stageKeydown = \(e: KeyboardEvent\) => \{[\s\S]*?\n\t\t\t\};/)?.[0];
		expect(keydown).toBeDefined();
		expect(keydown).toContain('userAdjusted = true');
		// No refit path survives outside the observer.
		expect(src).not.toContain('reframe');
	});

	it('guards every await against a stale generation (exit-during-load race, D6)', () => {
		expect(src).toContain('const gen = ++generation');
		expect((src.match(/gen !== generation/g) ?? []).length).toBeGreaterThanOrEqual(4);
		// Exit 3D bumps the generation BEFORE awaiting the native fullscreen
		// exit, so the aborted download's rejection bails silently instead of
		// painting a fullscreen-sized failure the user didn't cause — and the
		// await itself keeps the poster from rendering mid-transition.
		expect(src).toMatch(/generation\+\+;[\s\S]{0,400}?await exitAnyFullscreen\(\)/);
	});

	it('hands focus to Exit 3D at load START and keeps the zoom clamp on the shared cap', () => {
		// Activation unmounts the View in 3D button the click came from; focus
		// must move to Exit 3D before the download, not after the scene builds,
		// or it sits on <body> for the whole load. Stale-generation guarded.
		const beforeImport = src.split("import('three')")[0];
		expect(beforeImport).toMatch(/gen !== generation\) return;\s*\n\s*exitButton\?\.focus\(\)/);
		// The keyboard zoom-out clamp shares the framing cap constant — a bare
		// numeric literal would silently detach it from the camera far plane.
		expect(src).toContain('Math.min(VR_FRAME_DISTANCE_CAP, spherical.radius / 0.9)');
	});

	it('keeps the progress live region always mounted and the failure as an alert (A8/A9)', () => {
		expect(src).toMatch(/<p class="sr-only" role="status">/);
		const failure = src.match(/<p(?=[^>]*class="load-error")[^>]*>/)?.[0];
		expect(failure).toBeDefined();
		expect(failure).toContain('role="alert"');
	});
});
