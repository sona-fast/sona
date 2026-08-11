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
		// The fullscreen root is the viewer wrapper (via the `el` local) —
		// nothing ever fullscreens the bare stage.
		expect(src).toContain('const el = viewer as');
		expect(src).not.toContain('stage?.requestFullscreen()');
		expect(src).not.toContain('stage.requestFullscreen()');
	});

	it('feature-detects fullscreen with webkit + overlay fallbacks (iPhone, SONA-165)', () => {
		// iPhone Safari has no element fullscreen API and iPadOS only the
		// prefixed one — a bare requestFullscreen() call throws synchronously
		// there, so the toggle must detect before calling, then fall back to the
		// fixed-overlay mode.
		expect(src).toContain('el?.requestFullscreen');
		expect(src).toContain('el?.webkitRequestFullscreen');
		expect(src).toContain('setFallbackFullscreen(true)');
		// The overlay honors Escape like native fullscreen does…
		expect(src).toMatch(/fallbackFullscreen && e\.key === 'Escape'/);
		// …styles via its own class, whose rules never share a selector group
		// with :fullscreen (one unknown selector drops a whole CSS rule on the
		// old Safari that needs the fallback)…
		expect(src).toContain('class:fs-fallback={fallbackFullscreen}');
		const fallbackSelectors = src.match(/^\s*[^\n{}/]*\.fs-fallback[^\n{}]*\{/gm) ?? [];
		expect(fallbackSelectors.length).toBeGreaterThanOrEqual(2);
		for (const selector of fallbackSelectors) {
			expect(selector).not.toContain(':fullscreen');
		}
		// …and every exit path clears it: the toggle, Exit 3D, and unmount.
		expect((src.match(/setFallbackFullscreen\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it('frames from the humanoid skeleton, bounding box only as fallback (SONA-165)', () => {
		// Camera framing goes through the unit-tested frameHumanoid (pivot
		// between hips and head, model-forward axis, distance from span) fed by
		// RAW bone world positions; Box3 survives only in the no-humanoid branch.
		expect(src).toMatch(/import \{[^}]*frameHumanoid[^}]*\} from '\$lib\/vr'/);
		expect(src).toContain('getRawBoneNode');
		expect(src).toMatch(/frameHumanoid\(\{/);
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
