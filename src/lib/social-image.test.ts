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

	it('advertises an off-zone host nobody enumerated raw, at its original size', () => {
		// The allow-list case: an R2 custom domain on a DIFFERENT Cloudflare zone. A
		// deny-list of known off-zone hosts handed this a transform URL that 403s.
		expect(socialImage('https://cdn.otherdomain.net/a.webp', PAGE, 2400, 1800)).toEqual({
			url: 'https://cdn.otherdomain.net/a.webp',
			width: 2400,
			height: 1800
		});
	});

	it('does not build a transform URL for a src the transform cannot express', () => {
		// Each of these produced a URL the edge can't serve: no source at all, a
		// trailing space, a protocol-relative host that also escaped the off-zone
		// check (new URL() throws on it), and a nested transform CF rejects.
		for (const src of [
			'',
			'   ',
			'//app.ufs.sh/f/k',
			'https://taro.surf/cdn-cgi/image/width=1200,format=auto//img/a.png'
		]) {
			expect(socialImage(src, PAGE, 900, 700), src).toEqual({
				url: src.trim(),
				width: 900,
				height: 700
			});
		}
	});

	it('leaves real sources byte-identical (the degenerate guards are inert)', () => {
		expect(socialImage(' /img/parent.png ', PAGE, 900, 700).url).toBe(
			'https://taro.surf/cdn-cgi/image/width=1200,quality=85,fit=scale-down,format=auto//img/parent.png'
		);
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

	it('advertises no dimension at all when neither axis is known', () => {
		for (const [w, h] of [
			[null, null],
			[undefined, undefined],
			[0, 0]
		] as [number | null | undefined, number | null | undefined][]) {
			const { width, height } = socialImage('/img/x.png', PAGE, w, h);
			expect({ width, height }).toEqual({ width: null, height: null });
		}
	});

	// One column set and the other NULL is possible on a published row (SONA-22 owns
	// backfilling), and the axis we DO advertise must describe the URL we advertise.
	// Each direction has its own branch, so each gets its own case.
	it('caps a lone oversized width to match the transform and invents no height', () => {
		// The bug this pins: a 2400 width on a TRANSFORMED source used to be advertised
		// as 2400 beside a URL capped at 1200. Over the cap, so a 900-wide case cannot
		// catch it. The height the transform scaled to is unknowable without the ratio.
		expect(socialImage('/img/half.png', PAGE, 2400, null)).toEqual({
			url: 'https://taro.surf/cdn-cgi/image/width=1200,quality=85,fit=scale-down,format=auto//img/half.png',
			width: OG_MAX_WIDTH,
			height: null
		});
	});

	it('keeps a lone width the transform leaves alone', () => {
		const { width, height } = socialImage('/img/half.png', PAGE, 800, null);
		expect({ width, height }).toEqual({ width: 800, height: null });
	});

	it('keeps a lone height as stored and invents no width', () => {
		// The mirror: scale-down only shrinks by the width, which we do not have, so
		// the stored height stands and no width is guessed from it.
		const { width, height } = socialImage('/img/half.png', PAGE, null, 1600);
		expect({ width, height }).toEqual({ width: null, height: 1600 });
	});

	it('treats a stored 0 as missing on the transformed path', () => {
		// 0 is not a dimension any consumer can use (and is invalid for oEmbed
		// type=photo), so it must not survive as a value.
		expect(socialImage('/img/half.png', PAGE, 0, 700)).toMatchObject({
			width: null,
			height: 700
		});
		expect(socialImage('/img/half.png', PAGE, 2400, 0)).toMatchObject({
			width: OG_MAX_WIDTH,
			height: null
		});
	});

	it('advertises a raw source per axis, untouched', () => {
		// Nothing transformed it, so each axis it has is the real one — no cap.
		expect(socialImage('https://app12.ufs.sh/f/key', PAGE, 2400, null)).toEqual({
			url: 'https://app12.ufs.sh/f/key',
			width: 2400,
			height: null
		});
		expect(socialImage('https://app12.ufs.sh/f/key', PAGE, 0, 1800)).toEqual({
			url: 'https://app12.ufs.sh/f/key',
			width: null,
			height: 1800
		});
	});
});
