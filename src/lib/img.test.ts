import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cdnImage, isAnimatedSource } from '$lib';

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
