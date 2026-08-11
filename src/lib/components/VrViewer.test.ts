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
		expect(toggle).toMatch(/=\s*viewer as[\s\S]*el\?\.requestFullscreen/);
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
		// The overlay honors Escape like native fullscreen does…
		expect(src).toMatch(/fallbackFullscreen && e\.key === 'Escape'/);
		// …styles via its own class (the stylesheet documents why its rules
		// never share a selector group with :fullscreen)…
		expect(src).toContain('class:fs-fallback={fallbackFullscreen}');
		// …and every exit path clears it: the toggle, Escape, Exit 3D, unmount.
		expect((src.match(/setFallbackFullscreen\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it('locks page scroll behind the overlay and RESTORES it on exit (R1 MF6)', () => {
		expect(src).toContain("documentElement.style.overflow = on ? 'hidden' : ''");
	});

	it('inerts the page behind the overlay and restores exactly what it set (R1 MF1)', () => {
		// While the fallback overlay is up, the covered page must leave the tab
		// and screen-reader order; on exit only OUR inerts are cleared.
		expect(src).toContain('sibling.inert = true');
		expect(src).toContain('inerted.push(sibling)');
		expect(src).toMatch(/for \(const el of inerted\) el\.inert = false/);
	});

	it('mirrors fullscreen state on the toggle and announces mode changes (aria-pressed, exit label)', () => {
		expect(src).toContain('aria-pressed={isFullscreen || fallbackFullscreen}');
		// In fullscreen the toggle relabels as the exit it is (only visible cue
		// in the overlay), and a status region announces the mode change.
		expect(src).toMatch(/\{#if isFullscreen \|\| fallbackFullscreen\}[\s\S]*?vr_exit_fullscreen/);
		expect(src).toMatch(/<p class="sr-only" role="status">\{fsAnnouncement\}<\/p>/);
	});

	it('frames from the humanoid skeleton, bounding box only as fallback (SONA-165)', () => {
		// Camera framing goes through the unit-tested frameHumanoid (pivot
		// between hips and head, model-forward axis, distance from span) fed by
		// RAW bone world positions; Box3 survives only in the no-humanoid branch.
		expect(src).toMatch(/import \{[^}]*frameHumanoid[^}]*\} from '\$lib\/vr'/);
		expect(src).toContain('getRawBoneNode');
		// World matrices refresh BEFORE any bone is sampled — stale matrices
		// frame from wherever the loader left the nodes (R1 MF5).
		expect(src).toMatch(/updateMatrixWorld\(true\)[\s\S]*getRawBoneNode/);
		expect(src).toMatch(/frameHumanoid\(\{/);
		// The far plane and framing cap come from one shared constant (R1 N3).
		expect(src).toMatch(/PerspectiveCamera\(30, width \/ height, 0\.1, VR_CAMERA_FAR\)/);
		const fallback = src.match(/const framing =[\s\S]*?controls\.target\.copy\(target\)/)?.[0];
		expect(fallback).toBeDefined();
		expect(fallback).toContain('new THREE.Box3().setFromObject(vrm.scene)');
	});

	it('guards every await against a stale generation (exit-during-load race, D6)', () => {
		expect(src).toContain('const gen = ++generation');
		expect((src.match(/gen !== generation/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it('keeps the progress live region always mounted and the failure as an alert (A8/A9)', () => {
		expect(src).toMatch(/<p class="sr-only" role="status">/);
		const failure = src.match(/<p(?=[^>]*class="load-error")[^>]*>/)?.[0];
		expect(failure).toBeDefined();
		expect(failure).toContain('role="alert"');
	});
});
