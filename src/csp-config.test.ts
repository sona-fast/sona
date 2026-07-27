import { describe, it, expect } from 'vitest';
import config from '../svelte.config.js';

// Guards the shape of the app CSP (kit.csp in svelte.config.js) so a future edit
// can't silently gut it. The real emitted header + zero-violation rendering is
// covered end-to-end in tests/e2e/csp-check.spec.ts; this is the cheap unit gate
// on the directives that matter for XSS containment.
describe('kit.csp directives (F3)', () => {
	const csp = config.kit?.csp;
	const d = csp?.directives ?? {};

	it('uses hash mode so SvelteKit hashes its own inline scripts', () => {
		expect(csp?.mode).toBe('hash');
	});

	it('locks script-src: self + a hash, never unsafe-inline/unsafe-eval', () => {
		const script = d['script-src'] ?? [];
		expect(script).toContain('self');
		expect(script).not.toContain('unsafe-inline');
		expect(script).not.toContain('unsafe-eval');
		// The app.html theme resolver is pinned by hash (SvelteKit won't hash it).
		// Assert the EXACT app.html theme-script hash, not just "some hash" — if that
		// inline script's bytes drift, its hash changes and CSP would block it; failing
		// here in unit CI catches the drift fast instead of only at e2e.
		expect(script).toContain('sha256-b+LZKZWtSdZmsS5XuXKlgFQg8sQ4LLl7/HzIR8xtLMo=');
	});

	it('scopes inline event handlers to Svelte’s replay shim only', () => {
		// 'unsafe-hashes' + one hash allows exactly `this.__e=event`, not arbitrary
		// injected on*= handlers.
		const attr = d['script-src-attr'] ?? [];
		expect(attr).toContain('unsafe-hashes');
		expect(attr).not.toContain('unsafe-inline');
		expect(attr.some((s) => s.startsWith('sha256-'))).toBe(true);
	});

	it('covers the image + media origins the app actually loads', () => {
		// Same-origin (/cdn-cgi/image, /img), any https host (per-fork R2 domain,
		// external artist avatars, UploadThing), data: (CSS chevron / inline SVG),
		// and blob: (see below).
		expect(d['img-src']).toEqual(['self', 'https:', 'data:', 'blob:']);
		expect(d['media-src']).toEqual(['self', 'https:']);
	});

	it('allows blob: images, or the upload page silently stores NULL dimensions', () => {
		// Regression guard. admin/upload renders each picked file via
		// URL.createObjectURL(file) twice: the preview thumbnail, and an <img> that
		// getImageDimensions() reads naturalWidth/naturalHeight from. Drop blob: and
		// that <img> fires onerror, dimensions resolve to 0x0, the form posts
		// width_N=0/height_N=0, and +page.server.ts stores `Number(0) || null` — NULL.
		// The visible symptom is a missing thumbnail; the real damage is metadata loss
		// on every upload, which is why this gets its own named test.
		expect(d['img-src']).toContain('blob:');
	});

	it('permits the Turnstile widget (script + iframe) on admin login', () => {
		// challenges.cloudflare.com must be reachable or /admin/login breaks (F1).
		expect(d['script-src']).toContain('https://challenges.cloudflare.com');
		expect(d['frame-src']).toContain('https://challenges.cloudflare.com');
	});

	it('allows the Google Fonts stylesheet + files', () => {
		expect(d['style-src']).toContain('https://fonts.googleapis.com');
		expect(d['font-src']).toContain('https://fonts.gstatic.com');
	});

	it('denies framing and plugins', () => {
		expect(d['frame-ancestors']).toEqual(['none']);
		expect(d['object-src']).toEqual(['none']);
		expect(d['base-uri']).toEqual(['self']);
	});
});
