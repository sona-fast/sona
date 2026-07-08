import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cdnImage, isAnimatedSource } from '$lib';

// Guards the GIF regression (sona#97 follow-up): cdnImage hardcodes anim=false
// and points off-zone sources at /cdn-cgi/image/, which either freezes animated
// GIFs to frame 1 or 403s → broken img. Animated GIFs must be served raw
// everywhere cdnImage is used (grid, cards, collections, admin, detail), while
// static formats still get the transform. cdnImage short-circuits to the raw
// src in DEV, so these stub DEV=false to exercise the production path.

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
			'/cdn-cgi/image/width=200,quality=75,fit=scale-down,format=auto,anim=false/https://x/a.png'
		);
		expect(cdnImage('https://x/a.jpg', 200)).toContain('/cdn-cgi/image/width=200');
		expect(cdnImage('https://x/a.webp', 400, 90)).toContain(
			'/cdn-cgi/image/width=400,quality=90'
		);
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
