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

	it('exposes the stage as an image with a name and keyboard access (A1/A2)', () => {
		const stage = src.match(/<div(?=[^>]*class="stage")[^>]*>/)?.[0];
		expect(stage).toBeDefined();
		expect(stage).toContain('role="img"');
		expect(stage).toContain('aria-label={name}');
		expect(stage).toContain('tabindex="0"');
		expect(stage).toContain('onkeydown');
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
		// Armed right before the request, disarmed by change/error AND by a
		// timeout backstop (a request that fires neither event must not leave
		// the flag armed for an unrelated later error).
		expect(src).toMatch(
			/pendingWebkitFs = true;[\s\S]{0,300}?pendingWebkitFs = false\), 2000\);\s*\n\s*el\.webkitRequestFullscreen\(\)/
		);
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

	it('keeps the progress live region always mounted and the failure as an alert (A8/A9)', () => {
		expect(src).toMatch(/<p class="sr-only" role="status">/);
		const failure = src.match(/<p(?=[^>]*class="load-error")[^>]*>/)?.[0];
		expect(failure).toBeDefined();
		expect(failure).toContain('role="alert"');
	});
});
