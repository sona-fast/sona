import { describe, it, expect } from 'vitest';
import { socialImage, OG_MAX_WIDTH } from './social-image';

const PAGE = 'https://taro.surf/gallery/parent-piece';

describe('socialImage — the url it advertises', () => {
	it('transforms a root-relative source to the exact CDN URL og:image ships', () => {
		// Pinned as a literal, not rebuilt from the helper: the quality, fit, and
		// format params are the contract link-preview consumers fetch.
		expect(socialImage('/img/parent.png', PAGE, 900, 700).url).toBe(
			'https://taro.surf/cdn-cgi/image/width=1200,quality=85,fit=scale-down,format=auto//img/parent.png'
		);
	});

	it('transforms an absolute source on the fork own zone (r2PublicUrl subdomain)', () => {
		// cdn.taro.surf is a different HOST but the same ZONE — the transform works
		// there and is wanted. A host-inequality bypass would wrongly skip it.
		expect(socialImage('https://cdn.taro.surf/artwork/a.webp', PAGE, 900, 700)).toEqual({
			url: 'https://taro.surf/cdn-cgi/image/width=1200,quality=85,fit=scale-down,format=auto/https://cdn.taro.surf/artwork/a.webp',
			width: 900,
			height: 700
		});
	});

	it('advertises an UploadThing source raw, at its original size', () => {
		// The default storageProvider. Off-zone, so the transform 403s and a JSON
		// payload has no rawFallback — and the dimensions must then be the raw ones.
		expect(socialImage('https://app12.ufs.sh/f/key', PAGE, 2400, 1800)).toEqual({
			url: 'https://app12.ufs.sh/f/key',
			width: 2400,
			height: 1800
		});
	});

	it('advertises a public R2 dev-bucket source raw, at its original size', () => {
		expect(socialImage('https://pub-abc.r2.dev/x.png', PAGE, 2400, 1800)).toEqual({
			url: 'https://pub-abc.r2.dev/x.png',
			width: 2400,
			height: 1800
		});
	});

	it('does not treat a lookalike host as off-zone', () => {
		expect(socialImage('https://evilufs.sh/f/key', PAGE, 900, 700).url).toContain('/cdn-cgi/image/');
	});

	it('returns the source verbatim when the page URL is unparseable', () => {
		expect(socialImage('/img/parent.png', 'not-a-url', 2400, 1800)).toEqual({
			url: '/img/parent.png',
			width: 2400,
			height: 1800
		});
	});
});

describe('socialImage — the dimensions it advertises', () => {
	it('caps an oversized transformed image and keeps the aspect ratio', () => {
		const { width, height } = socialImage('/img/big.png', PAGE, 2400, 1800);
		expect({ width, height }).toEqual({ width: OG_MAX_WIDTH, height: 900 });
	});

	it('leaves an already-small image at its own size', () => {
		const { width, height } = socialImage('/img/small.png', PAGE, 900, 700);
		expect({ width, height }).toEqual({ width: 900, height: 700 });
	});

	it('advertises neither dimension unless BOTH are known', () => {
		// A lone side would let a consumer infer the wrong aspect ratio, so the
		// guard drops both — for every missing/zero combination.
		for (const [w, h] of [
			[null, 700],
			[900, null],
			[undefined, 700],
			[900, undefined],
			[null, null],
			[undefined, undefined],
			[0, 700],
			[900, 0]
		] as [number | null | undefined, number | null | undefined][]) {
			const { width, height } = socialImage('/img/x.png', PAGE, w, h);
			expect({ width, height }).toEqual({ width: null, height: null });
		}
	});
});
