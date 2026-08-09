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
		// modelPath is /vr/[slug]/model; CSP connect-src is 'self', and the raw
		// (possibly cross-origin) model_url must never reach this component.
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
		expect(src).toContain('viewer?.requestFullscreen()');
		expect(src).not.toContain('stage?.requestFullscreen()');
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
