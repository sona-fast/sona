import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cdnImage, isAnimatedSource, rawFallback } from '$lib';
import { cardImage, isUploadThingHost, isSameZoneImageHost } from '$lib/img';

// Guards the GIF regression (sona#97 follow-up): GIFs are served raw everywhere
// cdnImage is used (grid, cards, collections, admin, detail) because off-zone
// GIFs 403 the transform. Static formats still get the transform. cdnImage must
// NOT force anim=false — that froze animated WebP/AVIF (which can't be detected
// by URL) to their first frame; they now animate via the transform. cdnImage
// short-circuits to the raw src in DEV, so these stub DEV=false to exercise the
// production path.

describe('cdnImage animated-GIF bypass', () => {
	beforeEach(() => vi.stubEnv('DEV', false));
	afterEach(() => vi.unstubAllEnvs());

	it('returns the raw src for GIFs — no CDN transform', () => {
		expect(cdnImage('https://x/a.gif')).toBe('https://x/a.gif');
		expect(cdnImage('https://x/a.gif?v=1')).toBe('https://x/a.gif?v=1');
		expect(cdnImage('https://x/a.gif')).not.toContain('/cdn-cgi/image/');
	});

	it('still routes static formats through the CDN transform with width/quality', () => {
		expect(cdnImage('https://x/a.png', 200)).toBe(
			'/cdn-cgi/image/width=200,quality=75,fit=scale-down,format=auto/https://x/a.png'
		);
		expect(cdnImage('https://x/a.jpg', 200)).toContain('/cdn-cgi/image/width=200');
		expect(cdnImage('https://x/a.webp', 400, 90)).toContain(
			'/cdn-cgi/image/width=400,quality=90'
		);
	});

	it('never forces anim=false — animated WebP/AVIF must keep their frames', () => {
		// WebP/AVIF animation isn't URL-detectable, so it rides the transform;
		// anim=false would freeze it to frame 1 (the bug this guards against).
		expect(cdnImage('https://x/a.webp', 200)).not.toContain('anim=false');
		expect(cdnImage('https://x/a.png', 200)).not.toContain('anim=false');
		expect(cdnImage('https://x/a.webp', 200)).toContain('/cdn-cgi/image/width=200');
	});

	it('returns empty string for a missing src', () => {
		expect(cdnImage(null)).toBe('');
		expect(cdnImage(undefined)).toBe('');
	});
});

describe('isAnimatedSource', () => {
	it('is true for GIF URLs regardless of case or trailing query/hash', () => {
		expect(isAnimatedSource('https://x/a.gif')).toBe(true);
		expect(isAnimatedSource('https://x/a.GIF')).toBe(true);
		expect(isAnimatedSource('https://x/a.gif?v=1')).toBe(true);
		expect(isAnimatedSource('https://x/a.gif#frag')).toBe(true);
	});

	it('is false for static formats and extensionless UploadThing URLs', () => {
		expect(isAnimatedSource('https://x/a.png')).toBe(false);
		expect(isAnimatedSource('https://x/a.webp')).toBe(false);
		expect(isAnimatedSource('https://app.ufs.sh/f/abc')).toBe(false);
	});
});

describe('rawFallback', () => {
	// vitest runs in node with no DOM, and rawFallback only ever touches these
	// four methods — enough to drive it for real rather than scanning the source.
	function fakeImg(attrs: Record<string, string>) {
		const listeners: Record<string, (() => void)[]> = {};
		return {
			complete: false,
			naturalWidth: 1,
			attrs,
			getAttribute: (n: string) => attrs[n] ?? null,
			setAttribute: (n: string, v: string) => {
				attrs[n] = v;
			},
			removeAttribute: (n: string) => {
				delete attrs[n];
			},
			addEventListener: (n: string, fn: () => void) => {
				(listeners[n] ??= []).push(fn);
			},
			removeEventListener: () => {},
			fire: (n: string) => listeners[n]?.forEach((fn) => fn())
		};
	}

	const RAW = 'https://cdn.example.com/a.png';

	it('swaps in the raw URL and drops srcset AND sizes', () => {
		// A leftover `sizes` describes a slot for candidates that no longer exist;
		// keeping it while removing srcset is the half-fix.
		const img = fakeImg({
			src: '/cdn-cgi/image/width=1100,quality=75,fit=scale-down,format=auto/' + RAW,
			srcset: 'a 600w, b 1100w',
			sizes: '(max-width: 600px) calc(100vw - 56px), 544px'
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		rawFallback(img as any, RAW);
		img.fire('error');

		expect(img.attrs.src).toBe(RAW);
		expect(img.attrs.srcset).toBeUndefined();
		expect(img.attrs.sizes).toBeUndefined();
	});

	it('does not re-swap once src is already the raw URL', () => {
		const img = fakeImg({ src: RAW });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		rawFallback(img as any, RAW);
		img.fire('error');
		expect(img.attrs.src).toBe(RAW);
	});
});

// isUploadThingHost decides ref-image.ts's crossorigin branch, so every clause needs
// its own case: the bare-host ones (`ufs.sh`, `utfs.io`) are not covered by the suffix
// clauses, and the suffix clauses must keep the leading dot so a lookalike
// registration can't impersonate a host.
describe('isUploadThingHost', () => {
	it('matches UploadThing hosts and their subdomains only', () => {
		for (const host of ['ufs.sh', 'utfs.io', 'app12.ufs.sh', 'x.utfs.io']) {
			expect(isUploadThingHost(host), host).toBe(true);
		}
		for (const host of ['evilufs.sh', 'notutfs.io', 'cdn.example.com', 'r2.dev']) {
			expect(isUploadThingHost(host), host).toBe(false);
		}
	});
});

// isSameZoneImageHost decides whether a source rides the /cdn-cgi/image/ transform or
// is advertised raw. It is an allow-list, so the cases that matter are the two that
// must transform (same host, sibling subdomain) and everything else falling to raw —
// including off-zone hosts nobody enumerated.
describe('isSameZoneImageHost', () => {
	// A fork domain: two labels, as every fork's is.
	const PAGE = 'taro.surf';

	it('allows the page host and its own subdomains (the r2PublicUrl case)', () => {
		for (const host of ['taro.surf', 'cdn.taro.surf', 'images.taro.surf']) {
			expect(isSameZoneImageHost(host, PAGE), host).toBe(true);
		}
	});

	it('refuses a host on a different zone, including one nobody enumerated', () => {
		// The case the deny-list missed: an R2 custom domain on a DIFFERENT zone.
		expect(isSameZoneImageHost('cdn.otherdomain.net', 'sona.example.com')).toBe(false);
	});

	it('refuses every other host, enumerated or not', () => {
		// The first four are the hosts the old deny-list knew about; the rest are the
		// ones it silently handed a 403ing transform URL — a non-CF CDN and a lookalike
		// of the page domain.
		for (const host of [
			'ufs.sh',
			'app12.ufs.sh',
			'r2.dev',
			'pub-abc.r2.dev',
			'images.some-cdn.io',
			'taro.surf.evil.net'
		]) {
			expect(isSameZoneImageHost(host, PAGE), host).toBe(false);
		}
	});

	it('allows a same-host source when the PAGE host has three labels', () => {
		// The `srcHost === pageHost` clause is redundant for a two-label page host
		// (registrableDomain('taro.surf') === 'taro.surf'), so every case above passes
		// without it. It only earns its place here: on a fork served at a subdomain,
		// registrableDomain('sona.example.com') is 'example.com', which does NOT equal
		// the page host — so without the identity clause a page's own images would be
		// advertised raw and lose the transform.
		expect(isSameZoneImageHost('sona.example.com', 'sona.example.com')).toBe(true);
		// And the documented fail-safe for that same fork shape: a sibling host is not
		// assumed to share the zone.
		expect(isSameZoneImageHost('cdn.sona.example.com', 'sona.example.com')).toBe(false);
	});

	it('refuses when either host is missing', () => {
		expect(isSameZoneImageHost('', PAGE)).toBe(false);
		expect(isSameZoneImageHost('cdn.example.com', '')).toBe(false);
		// Both empty: unreachable via socialImage (it only calls with a truthy
		// srcHost), so this pins the guard as deliberate defense in depth.
		expect(isSameZoneImageHost('', '')).toBe(false);
	});

	it('falls to raw for a multi-part TLD rather than guessing the zone', () => {
		// Last-two-labels compares `co.uk` with `example.co.uk`: no match, so the
		// source is served raw. The failing-safe direction — raw always resolves.
		expect(isSameZoneImageHost('cdn.example.co.uk', 'example.co.uk')).toBe(false);
	});
});

// The card slot is a square with object-fit: cover, so a landscape image is
// drawn at the slot's height times its aspect ratio. `sizes` has to describe
// that drawn width, or a 2x/3x screen picks a candidate narrower than what it
// paints and upscales it.
describe('cardImage', () => {
	it('returns null when a dimension is missing or not positive', () => {
		expect(cardImage(null, 900)).toBeNull();
		expect(cardImage(1200, undefined)).toBeNull();
		expect(cardImage(undefined, undefined)).toBeNull();
		expect(cardImage(0, 900)).toBeNull();
		expect(cardImage(1200, 0)).toBeNull();
		expect(cardImage(-5, 900)).toBeNull();
	});

	it('offers exactly 400 and 800, with 800 as the src', () => {
		const spec = cardImage(800, 800)!;
		expect(spec.widths).toEqual([400, 800]);
		expect(spec.srcWidth).toBe(800);
		expect(spec.quality).toBe(75);
	});

	it('sizes a square image to the slot', () => {
		expect(cardImage(1000, 1000)!.sizes).toBe('(max-width: 768px) 100vw, (max-width: 1279px) 370px, 293px');
	});

	it('sizes a portrait image like a square, since cover fills the width', () => {
		expect(cardImage(900, 1200)!.sizes).toBe(cardImage(1000, 1000)!.sizes);
	});

	it('scales a landscape image by its aspect, rounded up', () => {
		// 1200x900 → 1.333… → 1.34; 370 × 1.34 = 495.8 → 496; 293 × 1.34 = 392.62 → 393,
		// which keeps a 4:3 desktop card on the 400 candidate.
		expect(cardImage(1200, 900)!.sizes).toBe(
			'(max-width: 768px) calc(100vw * 1.34), (max-width: 1279px) 496px, 393px'
		);
		// Whole-number products stay whole: 370 × 2 is 740, not 741.
		expect(cardImage(1600, 800)!.sizes).toBe(
			'(max-width: 768px) calc(100vw * 2), (max-width: 1279px) 740px, 586px'
		);
		// In float, 370 × 1.1 is 407.00000000000006; it must still come out 407.
		expect(cardImage(1100, 1000)!.sizes).toBe(
			'(max-width: 768px) calc(100vw * 1.1), (max-width: 1279px) 407px, 323px'
		);
	});

	it('sizes the phone slot by mobileColumns: full viewport by default, half minus padding for two', () => {
		expect(cardImage(1000, 1000)!.sizes).toBe('(max-width: 768px) 100vw, (max-width: 1279px) 370px, 293px');
		expect(cardImage(1000, 1000, 1)!.sizes).toBe('(max-width: 768px) 100vw, (max-width: 1279px) 370px, 293px');
		expect(cardImage(1000, 1000, 2)!.sizes).toBe(
			'(max-width: 768px) calc(50vw - 21px), (max-width: 1279px) 370px, 293px'
		);
		expect(cardImage(1200, 900, 2)!.sizes).toBe(
			'(max-width: 768px) calc((50vw - 21px) * 1.34), (max-width: 1279px) 496px, 393px'
		);
	});

	it('leaves the desktop steps unchanged by mobileColumns', () => {
		const desktop = (s: string) => s.slice(s.indexOf(', ') + 2);
		for (const [w, h] of [[1000, 1000], [900, 1200], [1200, 900], [1600, 800]]) {
			expect(desktop(cardImage(w, h, 2)!.sizes)).toBe(desktop(cardImage(w, h)!.sizes));
		}
	});
});
