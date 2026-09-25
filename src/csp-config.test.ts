import { describe, it, expect } from 'vitest';
import config from '../svelte.config.js';

// Guards the shape of the app CSP (kit.csp in svelte.config.js) so a future edit
// can't silently gut it. The real emitted header + zero-violation rendering is
// covered end-to-end in tests/e2e/csp-check.spec.ts; this is the cheap unit gate
// on the directives that matter for XSS containment.
describe('kit.csp directives', () => {
	const csp = config.kit?.csp;
	const d = csp?.directives ?? {};

	it('locks script-src: self + a hash, never unsafe-inline/unsafe-eval', () => {
		const script = d['script-src'] ?? [];
		expect(script).toContain('self');
		expect(script).not.toContain('unsafe-inline');
		expect(script).not.toContain('unsafe-eval');
		// connect-src legitimately carries blob:/data:; script-src must not — either
		// would let injected script bytes execute from attacker-minted URLs.
		expect(script).not.toContain('blob:');
		expect(script).not.toContain('data:');
		// The app.html theme resolver is pinned by hash (SvelteKit won't hash it).
		// Assert the EXACT app.html theme-script hash, not just "some hash" — if that
		// inline script's bytes drift, its hash changes and CSP would block it; failing
		// here in unit CI catches the drift fast instead of only at e2e.
		expect(script).toContain('sha256-b+LZKZWtSdZmsS5XuXKlgFQg8sQ4LLl7/HzIR8xtLMo=');
		// Exact match blocks additions the not-contains lines can't anticipate
		// ('https:', '*', 'strict-dynamic').
		expect(script).toEqual([
			'self',
			'sha256-b+LZKZWtSdZmsS5XuXKlgFQg8sQ4LLl7/HzIR8xtLMo=',
			'https://challenges.cloudflare.com',
			'https://static.cloudflareinsights.com'
		]);
	});

	it('allows the analytics beacon script WITHOUT widening connect-src', () => {
		// The two travel together in the obvious-but-wrong version of this change:
		// the beacon's cross-origin RUM fallback tempts a connect-src addition.
		// The auto-injected tag always posts same-origin /cdn-cgi/rum ('self'
		// covers it), and the beacon honors attacker-settable send.to/forward.url
		// destinations bounded only by connect-src — so the origin must appear in
		// script-src ONLY. See the connect-src comment in svelte.config.js.
		expect(d['script-src']).toContain('https://static.cloudflareinsights.com');
		expect(d['connect-src']).toEqual(['self', 'blob:', 'data:']);
		expect(d['connect-src']).not.toContain('https://cloudflareinsights.com');
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
		// DELIBERATE change (SONA-124 R2-B1): media-src gained blob: for the VR
		// media picker's client-side clip probe — the same rationale as img-src's
		// blob: (the upload page's object-URL dimension read). The load-bearing
		// containment invariants are untouched: connect-src carries no network origin
		// beyond 'self' (blob:/data: are in-document schemes — its exact value is
		// asserted in the analytics beacon test above) and script-src
		// still carries no unsafe-inline/unsafe-eval (asserted above).
		expect(d['img-src']).toEqual(['self', 'https:', 'data:', 'blob:']);
		expect(d['media-src']).toEqual(['self', 'https:', 'blob:']);
	});

	it('permits the Turnstile widget (script + iframe) on admin login', () => {
		// challenges.cloudflare.com must be reachable or /admin/login breaks.
		expect(d['script-src']).toContain('https://challenges.cloudflare.com');
		expect(d['frame-src']).toContain('https://challenges.cloudflare.com');
	});

	// SONA-181 self-hosted the typefaces. Re-adding either origin would let a
	// stylesheet or a font come from Google again — the exact request the privacy
	// policy now says the site does not make.
	it('names no external font or stylesheet origin', () => {
		expect(d['style-src']).toEqual(['self', 'unsafe-inline']);
		expect(d['font-src']).toEqual(['self']);
	});

	it('denies framing and plugins', () => {
		expect(d['frame-ancestors']).toEqual(['none']);
		expect(d['object-src']).toEqual(['none']);
		expect(d['base-uri']).toEqual(['self']);
	});

	it('denies worker sourcing, which would otherwise inherit script-src', () => {
		// Nothing in the app spawns workers; left unset, worker-src falls back to
		// script-src and workers become a quiet script-execution surface.
		expect(d['worker-src']).toEqual(['none']);
	});
});
